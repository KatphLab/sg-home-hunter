import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStaticServer } from '../index.js'

describe('static PWA server', () => {
  let tempDir = ''
  let server: Bun.Server<undefined> | null = null

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'house-hunter-srv-'))
    await mkdir(join(tempDir, 'data'), { recursive: true })
    await mkdir(join(tempDir, 'empty-dir'), { recursive: true })
    await writeFile(join(tempDir, 'index.html'), '<h1>House Hunter</h1>')
    await writeFile(join(tempDir, 'sw.js'), '// sw')
    await writeFile(join(tempDir, 'manifest.webmanifest'), '{"name":"HH"}')
    await writeFile(
      join(tempDir, 'data/stops.tsv'),
      'inventoryDate\t2026-11-24',
    )
    await writeFile(join(tempDir, 'notes.txt'), 'plain')
    server = await createStaticServer(tempDir, 0)
  })

  afterAll(async () => {
    server?.stop(true)
    if (tempDir.length > 0) {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('serves allowlisted static assets and rejects missing or disallowed paths', async () => {
    if (!server) {
      throw new Error('Server did not start')
    }
    const base = `http://127.0.0.1:${String(server.port)}`

    const rootRes = await fetch(`${base}/`)
    expect(rootRes.status).toBe(200)
    expect(await rootRes.text()).toContain('House Hunter')

    const swRes = await fetch(`${base}/sw.js`)
    expect(swRes.status).toBe(200)
    expect(swRes.headers.get('Cache-Control')).toBe('no-cache')

    const tsvRes = await fetch(`${base}/data/stops.tsv`)
    expect(tsvRes.status).toBe(200)

    const headRes = await fetch(`${base}/manifest.webmanifest`, {
      method: 'HEAD',
    })
    expect(headRes.status).toBe(200)

    const txtRes = await fetch(`${base}/notes.txt`)
    expect(txtRes.status).toBe(200)
    expect(txtRes.headers.get('Content-Type')).toBe('application/octet-stream')

    const missingRes = await fetch(`${base}/../../etc/passwd`)
    expect(missingRes.status).toBe(404)

    const postRes = await fetch(`${base}/`, { method: 'POST' })
    expect(postRes.status).toBe(405)
  })
})
