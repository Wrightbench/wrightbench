import { randomUUID } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { artifactFileForRun } from './db'
import { artifactsRoot } from './artifacts'

interface HostedArtifact {
  path: string
  contentType: string
  fileName: string
}

let server: Server | null = null
let port: number | null = null
let starting: Promise<number> | null = null
const hosted = new Map<string, HostedArtifact>()

const MIME: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.webp': 'image/webp'
}

function isOwnedArtifact(path: string): boolean {
  const root = resolve(artifactsRoot())
  const file = resolve(path)
  return file.startsWith(root + sep)
}

function fail(res: ServerResponse, status: number): void {
  res.statusCode = status
  res.setHeader('Cache-Control', 'no-store')
  res.end()
}

function serveFile(
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  artifact: HostedArtifact
): void {
  let size: number
  try {
    const stat = statSync(artifact.path)
    if (!stat.isFile()) {
      fail(res, 404)
      return
    }
    size = stat.size
  } catch {
    fail(res, 404)
    return
  }

  const type =
    artifact.contentType || MIME[extname(artifact.path).toLowerCase()] || 'application/octet-stream'
  res.setHeader('Content-Type', type)
  res.setHeader('Content-Disposition', `inline; filename="${artifact.fileName.replace(/["\\]/g, '_')}"`)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
  res.setHeader('X-Content-Type-Options', 'nosniff')

  const range = req.headers.range
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match) {
      res.setHeader('Content-Range', `bytes */${size}`)
      fail(res, 416)
      return
    }
    const start = match[1] === '' ? 0 : Number(match[1])
    const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      res.setHeader('Content-Range', `bytes */${size}`)
      fail(res, 416)
      return
    }
    res.statusCode = 206
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
    res.setHeader('Content-Length', end - start + 1)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(artifact.path, { start, end }).pipe(res)
    return
  }

  res.setHeader('Content-Length', size)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(artifact.path).pipe(res)
}

async function ensureServer(): Promise<number> {
  if (server && port !== null) return port
  if (starting) return starting
  starting = new Promise<number>((resolvePort, reject) => {
    const next = createServer((req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        fail(res, 405)
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const match = /^\/artifact\/([a-f0-9-]+)(?:\/.*)?$/.exec(url.pathname)
      const artifact = match ? hosted.get(match[1]) : undefined
      if (!artifact) {
        fail(res, 404)
        return
      }
      serveFile(req, res, artifact)
    })
    next.once('error', (error) => {
      starting = null
      reject(error)
    })
    next.listen(0, '127.0.0.1', () => {
      const address = next.address()
      if (address === null || typeof address === 'string') {
        next.close()
        starting = null
        reject(new Error('could not bind artifact server'))
        return
      }
      server = next
      port = address.port
      starting = null
      resolvePort(address.port)
    })
  })
  return starting
}

/**
 * Return a short-lived opaque URL for one DB-owned artifact. The renderer
 * never supplies a filesystem path and the server never serves outside the
 * immutable Wrightbench artifact root.
 */
export async function serveRunArtifact(
  projectPath: string,
  runId: number,
  artifactId: number
): Promise<{ url: string; contentType: string }> {
  const artifact = artifactFileForRun(projectPath, runId, artifactId)
  if (!artifact || !isOwnedArtifact(artifact.path)) throw new Error('run artifact not found')
  try {
    const stat = statSync(artifact.path)
    if (!stat.isFile()) throw new Error('not a file')
  } catch {
    throw new Error('run artifact is no longer available')
  }
  const token = randomUUID()
  hosted.set(token, artifact)
  while (hosted.size > 200) {
    const oldest = hosted.keys().next().value as string | undefined
    if (!oldest) break
    hosted.delete(oldest)
  }
  const activePort = await ensureServer()
  return {
    url: `http://127.0.0.1:${activePort}/artifact/${token}/${encodeURIComponent(artifact.fileName)}`,
    contentType: artifact.contentType
  }
}

export function stopArtifactServer(): void {
  hosted.clear()
  server?.close()
  server = null
  port = null
  starting = null
}
