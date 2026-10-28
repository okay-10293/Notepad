// 오케이 테이블 오프라인용 Service Worker
// 허브(/)와 music.html, 아이콘만 캐시한다. 그 외 요청(노트패드 본체, Supabase, 광고 등)은 건드리지 않고 그대로 네트워크로 보낸다.
const CACHE = 'okay-table-v4'
const SB_LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
const STATIC = ['/manifest.webmanifest', '/assets/favicon.svg', '/assets/favicon-180.png', '/assets/favicon-32.png']
// 주소 → 캐시 키 (Cloudflare Pages가 .html을 떼는 리다이렉트도 같이 처리)
const PAGES = { '/': '/', '/index.html': '/', '/music': '/music.html', '/music.html': '/music.html' }

// 리다이렉트된 응답은 페이지 이동(navigation)에 그대로 쓸 수 없어서 새 Response로 감싸 flag를 떼어낸다.
async function cleanResponse(res) {
  if (!res.redirected) return res
  const body = await res.blob()
  return new Response(body, { status: 200, statusText: 'OK', headers: res.headers })
}
async function putPage(cache, key, res) {
  const page = await cleanResponse(res)
  await cache.put(key, page.clone())
  if (key === '/music.html') await cache.put('/music', page.clone())
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    for (const key of ['/', '/music.html']) {
      const res = await fetch(key, { cache: 'reload' })
      if (!res.ok) throw new Error(key + ' 캐시 실패')
      await putPage(cache, key, res)
    }
    try { const lib = await fetch(SB_LIB, { mode: 'no-cors' }); await cache.put(SB_LIB, lib) } catch (e) {}
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
  if (req.url === SB_LIB) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE)
      const cached = await cache.match(SB_LIB)
      const refresh = fetch(req).then(async (res) => { try { await cache.put(SB_LIB, res.clone()) } catch (e) {} return res }).catch(() => null)
      if (cached) { event.waitUntil(refresh); return cached }
      return (await refresh) || Response.error()
    })())
    return
  }
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  const pageKey = PAGES[url.pathname]
  const isStatic = STATIC.includes(url.pathname)
  if (!pageKey && !isStatic) return  // 나머지(노트패드 등)는 브라우저 기본 동작

  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    const key = pageKey || url.pathname
    const cached = await cache.match(key)
    // 캐시 먼저 보여주고, 온라인이면 뒤에서 조용히 최신 버전으로 갱신
    const refresh = fetch(pageKey ? key : req).then(async (res) => {
      if (res.ok) {
        if (pageKey) await putPage(cache, key, res.clone())
        else await cache.put(key, res.clone())
      }
      return res
    }).catch(() => null)
    if (cached) { event.waitUntil(refresh); return cached }
    const net = await refresh
    return net || new Response('오프라인이고 아직 저장된 페이지가 없어요.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  })())
})
