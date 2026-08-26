/**
 * Safe package-script analysis. Package scripts are launch adapters, not
 * Playwright configs: a small, strictly recognized family of scripts can
 * contribute launch context (inline env, --config, fixed args) to a harness
 * target; everything else is deliberately classified as opaque rather than
 * guessed at. Nothing here executes anything — analysis is purely lexical,
 * and discovery/execution later invokes the project's installed Playwright
 * CLI directly with structured argv, never the script itself.
 */

export type ScriptAnalysis =
  /** `[VAR=v …] [cross-env VAR=v …] [npx|yarn|pnpm …] playwright test [args]` */
  | {
      kind: 'playwright-test'
      env: Record<string, string>
      /** value of -c/--config, verbatim (resolved against the package dir later) */
      configArg: string | null
      /** remaining fixed args after Wrightbench-owned config/evidence/output flags are stripped */
      args: string[]
    }
  /** playwright, but not a test run we can adopt (ui/list/help/show-report/…) */
  | {
      kind: 'playwright-other'
      /** selected config from a non-run `playwright test` mode, if any */
      configArg?: string | null
    }
  /** a Playwright executable was recognized, but its command is unsafe to interpret */
  | { kind: 'opaque'; reason: string }
  /** no playwright involvement at all */
  | { kind: 'unrelated' }

/** shell syntax that turns a script into a program rather than one command */
const UNQUOTED_SHELL_SYNTAX = /[|&;<>(){}`$*?!~\n\r]/
/** expansions that the shell still evaluates inside double quotes */
const DOUBLE_QUOTED_SHELL_EXPANSION = /[`$]/

/** wrappers we can safely skip ahead of the playwright invocation */
const LAUNCH_PREFIXES = new Set(['npx', 'yarn', 'pnpm', 'bunx', 'bun'])
/** wrapper-specific forms that still execute the following binary directly */
const PREFIX_FLAGS = new Map<string, ReadonlySet<string>>([
  ['npx', new Set(['--no-install', '--yes', '-y'])],
  ['yarn', new Set(['exec'])],
  ['pnpm', new Set(['exec', 'x'])],
  ['bunx', new Set()],
  ['bun', new Set(['x'])]
])

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
const WRIGHTBENCH_OWNED_VALUE_FLAGS = new Set(['--reporter', '--trace', '--output'])
const NON_RUN_TEST_MODE =
  /^(?:--ui(?:$|[-=])|--list(?:$|=)|--help(?:$|=)|-h$|--version(?:$|=)|-V$)/

/**
 * Project-only aliases and Playwright's interactive execution modes do not
 * define another test inventory. Projects are selected independently in the
 * workspace, while headed/debug are run modes, so contexts containing only
 * those flags are represented by their base configuration rather than an
 * additional run recipe.
 */
export function hasRecipeContext(env: Record<string, string>, args: string[]): boolean {
  if (Object.keys(env).length > 0) return true
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === '--project') {
      index += 1
      continue
    }
    if (token.startsWith('--project=')) continue
    if (token === '--headed' || token === '--debug') continue
    // A custom argv contract or any other fixed flag is meaningful recipe
    // context and must be preserved exactly for listing and execution.
    return true
  }
  return false
}

/**
 * Persisted targets are user-editable. Wrightbench owns these flags and must
 * never allow a stale or hand-edited recipe to replace its reporter, evidence
 * paths, selected config, or execution mode. Tokens after `--` belong to the
 * test suite's own argv contract and are intentionally opaque.
 */
export function hasReservedRunArgs(args: string[]): boolean {
  const separator = args.indexOf('--')
  const options = separator === -1 ? args : args.slice(0, separator)
  return options.some((token) =>
    /^(?:-c|--config(?:=|$)|--reporter(?:=|$)|--trace(?:=|$)|--output(?:=|$)|--ui(?:-|=|$)|--list(?:=|$)|--help(?:=|$)|-h$|--version(?:=|$)|-V$)/.test(
      token
    )
  )
}

/**
 * Tokenize one command line, honoring simple single/double quotes. Returns
 * null when the input uses anything beyond plain tokens and quoted spans
 * (escapes, nested/unbalanced quotes) — callers treat that as opaque.
 */
export function tokenizeScript(script: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (const ch of script) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null
      } else if (ch === '\\') {
        return null // escapes inside quotes are beyond "simple"
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (ch === '\\') return null
    if (ch === ' ' || ch === '\t') {
      if (started || current !== '') {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (quote !== null) return null // unbalanced quote
  if (started || current !== '') tokens.push(current)
  return tokens
}

/**
 * Detect shell behavior without confusing quoted argument content for shell
 * syntax. Guarded operators and expansion characters are literal inside either
 * quote kind, while `$` and backticks remain active inside double quotes.
 * Escapes and unbalanced quotes are rejected separately by tokenizeScript.
 */
function usesShellSyntax(script: string): boolean {
  let quote: '"' | "'" | null = null
  for (const ch of script) {
    if (quote === "'") {
      if (ch === "'") quote = null
      continue
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null
      } else if (DOUBLE_QUOTED_SHELL_EXPANSION.test(ch)) {
        return true
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (UNQUOTED_SHELL_SYNTAX.test(ch)) return true
  }
  return false
}

/**
 * The executable token itself, optionally followed immediately by a shell
 * command separator/redirection. The attached-operator form is recognized
 * only so it can be rejected as opaque below; branded artifacts such as
 * `playwright-*.vsix` deliberately do not match.
 */
function isPlaywrightLaunchToken(token: string | undefined): boolean {
  return token === 'playwright' || /^playwright[|&;<>(){}]/.test(token ?? '')
}

/** Completed tokens before the first malformed escape/unbalanced quote. */
function tokenizeCompletedPrefix(script: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (const ch of script) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null
      } else if (ch === '\\') {
        return tokens
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (ch === '\\') return tokens
    if (ch === ' ' || ch === '\t') {
      if (started || current !== '') {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  // Do not turn the contents of an unfinished quoted argument into a token:
  // `code "playwright` is unrelated, whereas the completed prefix of
  // `npx playwright test "broken` already proves a direct invocation.
  if (quote !== null) return tokens
  if (started || current !== '') tokens.push(current)
  return tokens
}

function parseLaunchPrefix(
  tokens: string[],
  env?: Record<string, string>
): { index: number; crossEnvShell: boolean } {
  let index = 0
  const consumeAssignments = (): void => {
    while (index < tokens.length) {
      const match = ASSIGNMENT.exec(tokens[index])
      if (!match) return
      if (env) env[match[1]] = match[2]
      index += 1
    }
  }

  // VAR=v … [cross-env VAR=v …] repeated in any interleaving.
  for (;;) {
    consumeAssignments()
    if (tokens[index] === 'cross-env-shell') {
      index += 1
      consumeAssignments()
      return { index, crossEnvShell: true }
    }
    if (tokens[index] === 'cross-env') {
      index += 1
      continue
    }
    break
  }

  // Package-manager wrappers ahead of the real binary.
  while (index < tokens.length && LAUNCH_PREFIXES.has(tokens[index])) {
    const prefix = tokens[index]
    index += 1
    const flags = PREFIX_FLAGS.get(prefix)
    while (index < tokens.length && flags?.has(tokens[index])) index += 1
  }
  return { index, crossEnvShell: false }
}

export function analyzeScript(script: string): ScriptAnalysis {
  // Identify Playwright only at the executable position after the small set
  // of launch prefixes we understand. Repositories commonly pass the word
  // "playwright" as data (an extension id, artifact, or ordinary argument);
  // those scripts have no relationship to the CLI and should stay silent.
  const tokens = tokenizeScript(script)
  if (tokens === null) {
    const prefixTokens = tokenizeCompletedPrefix(script)
    const launch = parseLaunchPrefix(prefixTokens)
    return isPlaywrightLaunchToken(prefixTokens[launch.index])
      ? { kind: 'opaque', reason: 'uses quoting Wrightbench cannot safely parse' }
      : { kind: 'unrelated' }
  }

  const env: Record<string, string> = {}
  const launch = parseLaunchPrefix(tokens, env)
  let i = launch.index
  if (launch.crossEnvShell) {
    return isPlaywrightLaunchToken(tokens[i])
      ? {
          kind: 'opaque',
          reason: 'uses cross-env-shell, which Wrightbench will not interpret'
        }
      : { kind: 'unrelated' }
  }

  if (!isPlaywrightLaunchToken(tokens[i])) return { kind: 'unrelated' }
  if (usesShellSyntax(script)) {
    return { kind: 'opaque', reason: 'uses shell operators Wrightbench will not interpret' }
  }
  // Attached operator spellings were rejected by the shell guard above.
  if (tokens[i] !== 'playwright') return { kind: 'unrelated' }
  i += 1
  if (tokens[i] !== 'test') return { kind: 'playwright-other' }
  i += 1

  let configArg: string | null = null
  const args: string[] = []
  let nonRun = false
  while (i < tokens.length) {
    const token = tokens[i]
    // Everything after the shell/CLI separator belongs to the project's
    // custom argv contract. Do not interpret or strip Playwright-looking
    // tokens there; list.ts inserts Wrightbench-owned flags before this marker.
    if (token === '--') {
      args.push(...tokens.slice(i))
      break
    }
    if (token === '-c' || token === '--config') {
      const value = tokens[i + 1]
      if (value === undefined || value.startsWith('-')) {
        return { kind: 'opaque', reason: 'config flag without a value' }
      }
      configArg = value
      i += 2
      continue
    }
    if (token.startsWith('--config=')) {
      configArg = token.slice('--config='.length)
      i += 1
      continue
    }
    if (token.startsWith('-c=')) {
      configArg = token.slice('-c='.length)
      i += 1
      continue
    }
    // Commander accepts the compact short-option spelling `-cFILE` as well
    // as `-c FILE`. Treat it as config context so it receives the same
    // workspace-containment checks and Full-capture wrapper as every other
    // selected config; leaving it in extraArgs would let it bypass both.
    if (token.startsWith('-c') && token.length > 2) {
      configArg = token.slice(2)
      i += 1
      continue
    }
    // Listing, help/version, and interactive/serving modes do not execute a
    // test run and therefore must never become runnable recipes. Continue
    // parsing so a later -c/--config can still surface its base configuration.
    if (NON_RUN_TEST_MODE.test(token)) {
      nonRun = true
      i += 1
      continue
    }

    // Discovery and execution inject their own reporter, trace mode, and
    // output directory. Strip a valid script override now so the candidate
    // that discovery validates is exactly the target persistence will accept.
    if (WRIGHTBENCH_OWNED_VALUE_FLAGS.has(token)) {
      const value = tokens[i + 1]
      if (value === undefined || value === '' || value.startsWith('-')) {
        return { kind: 'opaque', reason: `${token} flag without a value` }
      }
      i += 2
      continue
    }
    const ownedInline = [...WRIGHTBENCH_OWNED_VALUE_FLAGS].find((flag) =>
      token.startsWith(`${flag}=`)
    )
    if (ownedInline !== undefined) {
      if (token.length === ownedInline.length + 1) {
        return { kind: 'opaque', reason: `${ownedInline} flag without a value` }
      }
      i += 1
      continue
    }
    args.push(token)
    i += 1
  }

  return nonRun
    ? { kind: 'playwright-other', configArg }
    : { kind: 'playwright-test', env, configArg, args }
}
