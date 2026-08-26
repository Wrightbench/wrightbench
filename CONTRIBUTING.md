# Contributing to Wrightbench

Thanks for your interest in improving Wrightbench!

## Before you start

- Read [AGENTS.md](AGENTS.md). It is the authoritative guide to the
  architecture, the design-system rules, and the process rules for this
  repository — for humans as well as AI agents.
- For UI work, the design contract lives in
  `design_handoff_wrightbench/` (README + pixel-reference artboards).
- Significant changes are easier to land if you open an issue first and
  agree on the approach.

## Development setup

```bash
git clone https://github.com/Wrightbench/wrightbench.git
cd wrightbench
npm ci
npx electron-rebuild -f -w better-sqlite3
npm run dev
```

Wrightbench uses Node as pinned in [`.nvmrc`](.nvmrc). `better-sqlite3` is a
native module built for **Electron's** ABI: after any `npm install`, run
`npx electron-rebuild -f -w better-sqlite3` again. (To unit-test `db.ts`
under plain Node instead, `npm rebuild better-sqlite3` first, then rebuild
for Electron when you're done.) We deliberately do **not** rebuild via a
`postinstall` hook so this two-ABI workflow stays explicit; packaging runs
its own rebuild through electron-builder.

## Checks that must pass

Run these locally before opening a pull request — CI runs the same steps:

```bash
npm run typecheck
npm run test:uimode
npm run build
```

`npm run test:uimode:live` needs an external Playwright project and network
access; it is not part of CI and is optional locally.

## Pull requests

- Branch from `main`; keep PRs focused on one change.
- Commit messages are imperative and scoped, e.g.
  `phase5: add report webview retry` or `distribution: pin release runners`.
- Update `package-lock.json` together with `package.json` (`npm install`
  regenerates it; never hand-edit).
- Both themes: every new or changed UI primitive must render correctly in
  light and dark, and appear in the kitchen sink (`#kitchen-sink`).
- PRs run CI (typecheck, tests, build) automatically. A maintainer review
  is required to merge.

## Licensing of contributions

Wrightbench is licensed under the [Apache License 2.0](LICENSE). By
submitting a contribution you agree that it is your own work and that you
license it under Apache-2.0 (see Section 5 of the license — inbound =
outbound). There is no separate CLA.

## Reporting issues

Use the issue templates for bug reports and feature requests. For security
vulnerabilities, **do not open a public issue** — follow
[SECURITY.md](SECURITY.md).
