import { createServer } from 'node:net'
import type { ChildProcess } from 'node:child_process'

/** ask the OS for a free loopback port */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('could not allocate a port'))
        return
      }
      const { port } = address
      server.close(() => resolve(port))
    })
  })
}

/**
 * Resolve the `Listening on ws://…` endpoint a Playwright test server prints
 * on stdout. The endpoint (host, port, guid path) comes from the child itself,
 * so there is no pre-allocated-port race.
 */
export function waitForWsEndpoint(
  child: ChildProcess,
  what: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const maxProbeBytes = 16_384
    let buffer = ''
    let done = false
    const finish = (settle: () => void): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.off('close', onClose)
      settle()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error(`${what} did not become reachable in time`))),
      timeoutMs
    )
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString()
      const match = /Listening on (ws:\/\/\S+)/.exec(buffer)
      if (match) finish(() => resolve(match[1]))
      else if (buffer.length > maxProbeBytes) {
        // Keep enough rolling suffix to recognize a marker split between two
        // chunks, without retaining project-controlled stdout indefinitely.
        buffer = buffer.slice(-maxProbeBytes)
      }
    }
    const onClose = (): void =>
      finish(() => reject(new Error(`${what} exited before it became reachable`)))
    child.stdout?.on('data', onData)
    child.on('close', onClose)
  })
}

class HostedServerMismatchError extends Error {}

async function responsePrefix(response: Response, maxBytes = 65_536): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let result = ''
  let remaining = maxBytes
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read()
      if (done) break
      const take = Math.min(value.byteLength, remaining)
      result += decoder.decode(value.subarray(0, take), { stream: take === value.byteLength })
      remaining -= take
      if (take < value.byteLength) break
    }
  } finally {
    if (remaining === 0) void reader.cancel()
  }
  return `${result}${decoder.decode()}`
}

/**
 * Poll until the child's HTTP server answers with a body matching `expect` —
 * the pre-allocated port could have been grabbed by another local server, so
 * only a matching response from a live child counts.
 */
export async function waitForHttp(
  url: string,
  child: ChildProcess,
  expect: RegExp,
  what: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let exited = false
  child.once('close', () => (exited = true))
  while (Date.now() < deadline) {
    if (exited) throw new Error(`${what} exited before it became reachable`)
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(2_000)
      })
      if (response.status >= 300 && response.status < 400) {
        throw new HostedServerMismatchError(`${what} returned an unexpected redirect`)
      }
      if (!response.ok) {
        throw new HostedServerMismatchError(
          `${what} returned an unexpected HTTP ${response.status}`
        )
      }
      const body = await responsePrefix(response)
      if (!exited && expect.test(body)) return
      if (exited) throw new Error(`${what} exited before it became reachable`)
      throw new HostedServerMismatchError(`another local server answered on the ${what} port`)
    } catch (err) {
      if (err instanceof HostedServerMismatchError) throw err
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`${what} did not become reachable in time`)
}
