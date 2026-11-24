import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const ROOT_DIR = resolve(import.meta.dir, '..')
const PUBLIC_SRC_DIR = resolve(ROOT_DIR, 'public')
const PUBLIC_OUT_DIR = resolve(ROOT_DIR, 'dist/public')

const buildBundle = async (
  entrypoint: string,
  outfileName: string,
): Promise<void> => {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: PUBLIC_OUT_DIR,
    naming: outfileName,
    target: 'browser',
    minify: true,
    sourcemap: 'none',
  })
  if (!result.success) {
    const details = result.logs.map((log) => log.message).join('; ')
    throw new Error(`Bundle failed for ${entrypoint}: ${details}`)
  }
}

const main = async (): Promise<void> => {
  await rm(PUBLIC_OUT_DIR, { recursive: true, force: true })
  await mkdir(PUBLIC_OUT_DIR, { recursive: true })
  await cp(PUBLIC_SRC_DIR, PUBLIC_OUT_DIR, { recursive: true })

  const leafletCssSrc = resolve(
    ROOT_DIR,
    'node_modules/leaflet/dist/leaflet.css',
  )
  const leafletCssDest = resolve(PUBLIC_OUT_DIR, 'leaflet.css')
  await mkdir(dirname(leafletCssDest), { recursive: true })
  await cp(leafletCssSrc, leafletCssDest)

  await Promise.all([
    buildBundle(resolve(ROOT_DIR, 'src/app/main.ts'), 'app.js'),
    buildBundle(resolve(ROOT_DIR, 'src/sw.ts'), 'sw.js'),
  ])

  process.stdout.write(`Built PWA assets to ${PUBLIC_OUT_DIR}\n`)
}

await main()
