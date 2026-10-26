// 오케이 음악 오프라인용 Service Worker
// music.html + 아이콘만 캐시한다. 그 외 요청(노트패드 본체, Supabase, 광고 등)은 건드리지 않고 그대로 네트워크로 보낸다.
const CACHE = 'okay-music-v1'
const PAGE = '/music.html'
const STATIC = ['/manifest.webmanifest', '/assets/favicon.svg', '/assets/favicon-180.png', '/assets/favicon-32.png']

// Cloudflare Pages는 /music.html → /music 으로 리다이렉트하는데, 리다이렉트된 응답은
// 페이지 이동(navigation)에 그대로 쓸 수 없어서 새 Response로 감싸 flag를 떼어낸다.
async function cleanResponse(res) {
  if (!res.redirected) return res
  const body = await res.blob()
  return new Response(body, { status: 200, statusText: 'OK', headers: res.headers })
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    const res = await fetch(PAGE, { cache: 'reload' })
    if (!res.ok) throw new Error('music.html 캐시 실패')
    const page = await cleanResponse(res)
    await cache.put(PAGE, page.clone())
    await cache.put('/music', page.clone())
    await Promise.all(STATIC.map(async (u) => {
      try { const r = await fetch(u, { cache: 'reload' }); if (r.ok) await cache.put(u, r) } catch (e) {}
    }))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  const isPage = url.pathname === '/music' || url.pathname === '/music.html'
  const isStatic = STATIC.includes(url.pathname)
  if (!isPage && !isStatic) return  // 나머지는 브라우저 기본 동작

  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    const key = isPage ? PAGE : url.pathname
    const cached = await cache.match(key)
    // 캐시 먼저 보여주고, 온라인이면 뒤에서 조용히 최신 버전으로 갱신
    const refresh = fetch(isPage ? PAGE : req).then(async (res) => {
      if (res.ok) {
        const fresh = isPage ? await cleanResponse(res) : res
        await cache.put(key, fresh.clone())
        if (isPage) await cache.put('/music', fresh.clone())
      }
      return res
    }).catch(() => null)
    if (cached) { event.waitUntil(refresh); return cached }
    const net = await refresh
    return net || new Response('오프라인이고 아직 저장된 페이지가 없어요.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  })())
})
