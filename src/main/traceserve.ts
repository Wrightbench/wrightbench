import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'

/**
 * Serves Playwright's own trace-viewer web app (the built bundle inside the
 * user project's playwright-core) plus local trace.zip files — the same two
 * routes `npx playwright show-trace` wires up, but embeddable in a <webview>.
 * One server per project so the viewer version matches the traces.
 */

interface TraceServer {
  port: number
  server: Server
  viewerDir: string
}

const servers = new Map<string, TraceServer>()

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.map': 'application/json',
  '.zip': 'application/zip',
  '.webm': 'video/webm'
}

function serveFile(filePath: string, res: import('node:http').ServerResponse): void {
  let size: number
  try {
    size = statSync(filePath).size
  } catch {
    res.statusCode = 404
    res.end()
    return
  }
  res.setHeader('Content-Type', MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream')
  res.setHeader('Content-Length', size)
  createReadStream(filePath)
    .on('error', () => {
      res.statusCode = 500
      res.end()
    })
    .pipe(res)
}

function viewerDirFor(projectPath: string): string {
  return join(projectPath, 'node_modules', 'playwright-core', 'lib', 'vite', 'traceViewer')
}

async function launch(projectPath: string): Promise<TraceServer> {
  const viewerDir = viewerDirFor(projectPath)
  if (!existsSync(join(viewerDir, 'index.html'))) {
    throw new Error('trace viewer assets not found — is Playwright installed in this project?')
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/trace')) {
      res.statusCode = 404
      res.end()
      return
    }
    const rel = url.pathname.slice('/trace'.length)
    if (rel.startsWith('/file')) {
      // the viewer fetches the zip back through us: /trace/file?path=<abs>
      const filePath = url.searchParams.get('path')
      if (filePath !== null && existsSync(filePath)) {
        serveFile(filePath, res)
      } else {
        res.statusCode = 404
        res.end()
      }
      return
    }
    // static viewer asset — never allow escaping the bundle dir
    const asset = normalize(join(viewerDir, rel === '' || rel === '/' ? 'index.html' : rel))
    if (!asset.startsWith(viewerDir + sep) && asset !== viewerDir) {
      res.statusCode = 403
      res.end()
      return
    }
    serveFile(asset, res)
  })
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('could not bind trace server'))
        return
      }
      resolve(address.port)
    })
  })
  return { port, server, viewerDir }
}

/** viewer URL for one trace.zip, starting the project's server if needed */
export async function serveTrace(projectPath: string, zipPath: string): Promise<{ url: string }> {
  let entry = servers.get(projectPath)
  if (!entry) {
    entry = await launch(projectPath)
    servers.set(projectPath, entry)
  }
  const base = `http://127.0.0.1:${entry.port}`
  const traceUrl = `${base}/trace/file?path=${encodeURIComponent(zipPath)}`
  return { url: `${base}/trace/index.html?trace=${encodeURIComponent(traceUrl)}` }
}

export function stopTraceServer(projectPath: string): boolean {
  const entry = servers.get(projectPath)
  if (!entry) return false
  entry.server.close()
  servers.delete(projectPath)
  return true
}

/** Main-process webview policy helper for exact live trace-server origins. */
export function traceServerPort(projectPath: string): number | null {
  return servers.get(projectPath)?.port ?? null
}

export function stopAllTraceServers(): void {
  for (const path of [...servers.keys()]) stopTraceServer(path)
}
