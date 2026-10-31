// 오케이 테이블 오프라인용 Service Worker
// 허브(/), 음악, PDF 오프너 페이지와 그 페이지가 쓰는 라이브러리만 캐시한다.
// 그 외 요청(노트패드 본체, Supabase 데이터 등)은 건드리지 않고 그대로 네트워크로 보낸다.
const CACHE = 'okay-table-v5'
const PDFJS = '3.11.174'
const LIBS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDFJS + '/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDFJS + '/pdf.worker.min.js',
  'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js'
]
const STATIC = ['/manifest.webmanifest', '/assets/favicon.svg', '/assets/favicon-180.png', '/assets/favicon-32.png']
// 주소 → 캐시 키 (Cloudflare Pages가 .html을 떼는 리다이렉트도 같이 처리)
const PAGES = {
  '/': '/', '/index.html': '/',
  '/music': '/music.html', '/music.html': '/music.html',
  '/pdf': '/pdf.html', '/pdf.html': '/pdf.html'
}
const ALIAS = { '/music.html': '/music', '/pdf.html': '/pdf' }

// 리다이렉트된 응답은 페이지 이동(navigation)에 그대로 쓸 수 없어서 새 Response로 감싸 flag를 떼어낸다.
async function cleanResponse(res) {
  if (!res.redirected) return res
  const body = await res.blob()
  return new Response(body, { status: 200, statusText: 'OK', headers: res.headers })
}
async function putPage(cache, key, res) {
  const page = await cleanResponse(res)
  await cache.put(key, page.clone())
  if (ALIAS[key]) await cache.put(ALIAS[key], page.clone())
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    for (const key of ['/', '/music.html', '/pdf.html']) {
      const res = await fetch(key, { cache: 'reload' })
      if (!res.ok) throw new Error(key + ' 캐시 실패')
      await putPage(cache, key, res)
    }
    await Promise.all(LIBS.map(async (u) => {
      try { const r = await fetch(u, { mode: 'no-cors' }); await cache.put(u, r) } catch (e) {}
    }))
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

  // CDN 라이브러리: 캐시 우선, 뒤에서 조용히 갱신
  if (LIBS.includes(req.url)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE)
      const cached = await cache.match(req.url)
      const refresh = fetch(req).then(async (res) => { try { await cache.put(req.url, res.clone()) } catch (e) {} return res }).catch(() => null)
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
