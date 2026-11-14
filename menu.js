/* 오케이 스튜디오 공통 메뉴: 오른쪽 위 햄버거 + 오른쪽에서 열리는 서랍. 모든 페이지가 같은 모양을 쓴다. */
(function () {
  if (window.OkayMenu) return
  var REF = 'iksctrteeygnvfcsyjea'
  var SB_URL = 'https://iksctrteeygnvfcsyjea.supabase.co'
  var SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrc2N0cnRlZXlnbnZmY3N5amVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1OTExMTMsImV4cCI6MjA5NjE2NzExM30.DcsqSXHE4tu_B_vNX9UhGIYAt9CyMvNj3gzRS7T45hg'
  var ITEMS = [['/', '홈', '모든 도구'], ['/notepad.html', '노트패드', '글, 파일 저장', 1], ['/pdf.html', 'PDF 오프너', 'PDF 열기, 필기'], ['/draw.html', '드로잉', '그림 그리기'], ['/music.html', '음악', '저장한 곡 재생']]
  var CSS = ':root{--okm-bg:#fff;--okm-ink:#0a0a0a;--okm-ink2:#5c5c5c;--okm-ink3:#9b9b9b;--okm-bd:#e6e6e6;--okm-sf:#f3f3f3}' +
    '@media (prefers-color-scheme:dark){:root{--okm-bg:#000;--okm-ink:#f5f5f5;--okm-ink2:#a8a8a8;--okm-ink3:#6e6e6e;--okm-bd:#2a2a2a;--okm-sf:#171717}}' +
    '.okm-btn{border:none;background:none;padding:.35rem;cursor:pointer;color:var(--okm-ink);display:inline-grid;flex-shrink:0;-webkit-tap-highlight-color:transparent}' +
    '.okm-btn svg{width:28px;height:28px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}' +
    '#okm-dim{position:fixed;inset:0;background:rgba(0,0,0,.45);opacity:0;pointer-events:none;transition:opacity .2s;z-index:2147483000}' +
    '#okm-drawer{position:fixed;top:0;right:0;bottom:0;width:min(320px,86vw);background:var(--okm-bg);color:var(--okm-ink);border-left:1px solid var(--okm-bd);transform:translateX(100%);transition:transform .22s;z-index:2147483001;padding:calc(1.2rem + env(safe-area-inset-top,0px)) 1.2rem calc(1.2rem + env(safe-area-inset-bottom,0px));display:flex;flex-direction:column;font-family:"Pretendard Variable",Pretendard,-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;-webkit-user-select:none;user-select:none}' +
    '.okm-open #okm-dim{opacity:1;pointer-events:auto}.okm-open #okm-drawer{transform:none}' +
    '#okm-drawer .dh{display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;font-weight:800;font-size:1.1rem}' +
    '#okm-drawer .dx{border:none;background:none;color:var(--okm-ink2);font-size:1.7rem;line-height:1;cursor:pointer;padding:.2rem .4rem}' +
    '#okm-drawer a,#okm-drawer .mi{display:block;text-align:left;width:100%;padding:.85rem .7rem;border:none;background:none;color:var(--okm-ink);font:inherit;font-size:1.05rem;font-weight:600;text-decoration:none;border-radius:10px;cursor:pointer}' +
    '#okm-drawer a:hover,#okm-drawer .mi:hover,#okm-drawer a.cur{background:var(--okm-sf)}' +
    '#okm-drawer small{display:block;font-size:.78rem;color:var(--okm-ink3);font-weight:400;margin-top:.1rem}' +
    '#okm-drawer hr{border:none;border-top:1px solid var(--okm-bd);margin:.8rem 0}' +
    '#okm-drawer .who{font-size:.85rem;color:var(--okm-ink2);padding:.3rem .7rem}' +
    '.okm-off #okm-drawer a.net{opacity:.5}'
  function norm(p) { return p.replace(/\/index\.html$/, '/').replace(/\.html$/, '') || '/' }
  function who() { try { var r = JSON.parse(localStorage.getItem('sb-' + REF + '-auth-token')); return ((r && r.user && r.user.email) || '').replace('@notepad.app', '') } catch (e) { return '' } }
  function setOpen(o) { document.documentElement.classList.toggle('okm-open', o); document.documentElement.classList.toggle('okm-off', !navigator.onLine) }
  function logout() {
    var done = function () { try { localStorage.removeItem('sb-' + REF + '-auth-token') } catch (e) {} location.assign('/') }
    try { if (window.supabase) { window.supabase.createClient(SB_URL, SB_KEY).auth.signOut().then(done, done); return } } catch (e) {}
    done()
  }
  function build() {
    if (document.getElementById('okm-drawer')) return
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st)
    var dim = document.createElement('div'); dim.id = 'okm-dim'; dim.onclick = function () { setOpen(false) }
    var d = document.createElement('aside'); d.id = 'okm-drawer'; d.setAttribute('aria-label', '메뉴')
    var h = '<div class="dh"><span>오케이 스튜디오</span><button class="dx" aria-label="닫기">×</button></div>'
    var cur = norm(location.pathname)
    ITEMS.forEach(function (it) { h += '<a href="' + it[0] + '"' + ((norm(it[0]) === cur ? ' class="cur"' : '')).replace('class="cur"', 'class="cur' + (it[3] ? ' net' : '') + '"') + (norm(it[0]) !== cur && it[3] ? ' class="net"' : '') + '>' + it[1] + '<small>' + it[2] + '</small></a>' })
    var w = who()
    if (w) h += '<hr><div class="who"></div><button class="mi" data-a="out">로그아웃</button>'
    d.innerHTML = h
    if (w) d.querySelector('.who').textContent = w
    d.querySelector('.dx').onclick = function () { setOpen(false) }
    var out = d.querySelector('[data-a="out"]'); if (out) out.onclick = logout
    document.body.appendChild(dim); document.body.appendChild(d)
    addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false) })
  }
  window.OkayMenu = {
    mount: function (el) {
      if (!el) return
      build()
      var b = document.createElement('button'); b.className = 'okm-btn'; b.setAttribute('aria-label', '메뉴')
      b.innerHTML = '<svg viewBox="0 0 30 30"><path d="M4 8h22M4 15h22M4 22h22"/></svg>'
      b.onclick = function () { setOpen(true) }
      el.appendChild(b)
    }
  }
})()
