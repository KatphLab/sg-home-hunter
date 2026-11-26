const CACHE_NAME = 'house-hunter-shell-v6'
const PRECACHE_PATHS = [
  './',
  './index.html',
  './app.js',
  './planner-worker.js',
  './styles.css',
  './leaflet.css',
  './manifest.webmanifest',
  './data/stops.tsv',
  './data/bus-network.tsv',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
]

interface ExtendableEventLike extends Event {
  waitUntil(promise: Promise<unknown>): void
}

interface FetchEventLike extends Event {
  readonly request: Request
  respondWith(response: Promise<Response> | Response): void
}

const isExtendableEvent = (event: Event): event is ExtendableEventLike =>
  'waitUntil' in event

const isFetchEvent = (event: Event): event is FetchEventLike =>
  'request' in event && 'respondWith' in event

const precacheShell = async (): Promise<void> => {
  const cache = await caches.open(CACHE_NAME)
  await cache.addAll(PRECACHE_PATHS)
}

const clearOldCaches = async (): Promise<void> => {
  const keys = await caches.keys()
  await Promise.all(
    keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
  )
}

const handleSameOriginGet = async (request: Request): Promise<Response> => {
  const cached = await caches.match(request)
  if (cached) {
    return cached
  }
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME)
      await cache.put(request, response.clone())
    }
    return response
  } catch {
    if (request.mode === 'navigate') {
      const shell = await caches.match('./index.html')
      if (shell) {
        return shell
      }
    }
    return new Response('Offline', { status: 503, statusText: 'Offline' })
  }
}

globalThis.addEventListener('install', (event) => {
  if (isExtendableEvent(event)) {
    event.waitUntil(precacheShell())
  }
})

globalThis.addEventListener('activate', (event) => {
  if (isExtendableEvent(event)) {
    event.waitUntil(clearOldCaches())
  }
})

globalThis.addEventListener('fetch', (event) => {
  if (!isFetchEvent(event)) {
    return
  }
  const { request } = event
  if (request.method !== 'GET') {
    return
  }
  const url = new URL(request.url)
  if (url.origin !== globalThis.location.origin) {
    return
  }
  event.respondWith(handleSameOriginGet(request))
})
