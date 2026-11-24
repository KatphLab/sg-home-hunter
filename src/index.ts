import { readdir } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

interface StaticAsset {
  readonly content: ArrayBuffer
  readonly contentType: string
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.png': 'image/png',
}

const loadAssetsRecursive = async (
  baseDir: string,
  relPrefix: string,
  map: Map<string, StaticAsset>,
): Promise<void> => {
  const entries = await readdir(join(baseDir, relPrefix), {
    withFileTypes: true,
  })
  for (const entry of entries) {
    const relPath =
      relPrefix.length > 0 ? `${relPrefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      await loadAssetsRecursive(baseDir, relPath, map)
      continue
    }
    if (!entry.isFile()) {
      continue
    }
    const content = await Bun.file(join(baseDir, relPath)).arrayBuffer()
    const contentType =
      MIME_TYPES[extname(entry.name)] ?? 'application/octet-stream'
    map.set(`/${relPath}`, { content, contentType })
  }
}

export const createStaticServer = async (
  publicDir: string,
  port: number,
): Promise<Bun.Server<undefined>> => {
  const assets = new Map<string, StaticAsset>()
  await loadAssetsRecursive(publicDir, '', assets)

  const indexAsset = assets.get('/index.html')
  if (indexAsset) {
    assets.set('/', indexAsset)
  }

  return Bun.serve({
    port,
    fetch(request) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405 })
      }
      const pathname = new URL(request.url).pathname
      const asset = assets.get(pathname)
      if (!asset) {
        return new Response('Not Found', { status: 404 })
      }
      return new Response(request.method === 'HEAD' ? null : asset.content, {
        status: 200,
        headers: {
          'Content-Type': asset.contentType,
          'Cache-Control':
            pathname === '/sw.js' ? 'no-cache' : 'public, max-age=300',
        },
      })
    },
  })
}

if (import.meta.main) {
  await createStaticServer(
    resolve(import.meta.dir, '../dist/public'),
    Number(process.env['PORT'] ?? 3000),
  )
}
