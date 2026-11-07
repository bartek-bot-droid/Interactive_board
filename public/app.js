// Tablica PDF – klient
(() => {
  'use strict';

  // ---------- ustawienia ----------
  // Grubości (ułamek szerokości strony): cienki, średni, gruby, bardzo gruby.
  const PEN_SIZES = [0.0015, 0.0028, 0.005, 0.009];
  const ERASER_SIZES = [0.012, 0.025, 0.045, 0.08];
  const SIZE_NAMES = ['Cienki', 'Średni', 'Gruby', 'Bardzo gruby'];
  const DEFAULT_COLORS = ['#111827', '#1d4ed8', '#dc2626', '#16a34a', '#ea580c'];
  const GUTTER = 16;
  const MAX_PAGE_WIDTH = 1000;
  const MIN_ZOOM = 0.5, MAX_ZOOM = 4;
  const MAX_CANVAS_PIXELS = 4.5e6; // limit pamięci na iPadzie
  const SEND_INTERVAL = 30;        // ms między paczkami punktów
  const A4 = { w: 595, h: 842 };   // rozmiar pustej strony, gdy nie ma sąsiedniej (punkty PDF)

  const $ = (s) => document.querySelector(s);
  const viewer = $('#viewer');
  const pagesEl = $('#pages');

  // ---------- identyfikator tablicy w adresie ----------
  const params = new URLSearchParams(location.search);
  const roomId = (params.get('b') || '').toLowerCase();
  if (!/^[a-z0-9]{4,32}$/.test(roomId)) {
    // Bez kodu tablicy: lista tablic nauczyciela (chroniona PIN-em).
    location.replace('/tablice.html');
    return;
  }
  const clientId = randomId(6);
  let strokeCounter = 0;

  function randomId(n) {
    const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    return Array.from(bytes, (b) => abc[b % abc.length]).join('');
  }

  // ---------- pdf.js – wczytywany w tle, żeby nie opóźniać pokazania tablicy ----------
  let pdfjsReady = null;
  let pdfWorker = null;
  function pdfjs() {
    if (!pdfjsReady) {
      pdfjsReady = loadScript('/vendor/pdfjs/pdf.min.js').then(() => {
        pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
        pdfWorker = new pdfjsLib.PDFWorker(); // od razu zaczyna pobierać „silnik” PDF
        return pdfjsLib;
      });
      pdfjsReady.catch(() => { pdfjsReady = null; });
    }
    return pdfjsReady;
  }
  pdfjs();

  const PDF_OPTIONS = {
    cMapUrl: '/vendor/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/fonts/',
  };
  const assetUrl = (a) => `/api/room/${roomId}/asset/${a}`;

  // Pamięć plików na tym urządzeniu: PDF pobrany raz (albo wgrany stąd) przy następnym otwarciu
  // tablicy wczytuje się bez internetu. Pliki o danym id nigdy się nie zmieniają, więc to bezpieczne.
  // Działa tylko na stronie https (np. adres Tailscale); w sieci domowej i tak jest szybko.
  const FILE_CACHE = 'tablica-pliki-v1';
  const canCache = window.isSecureContext && 'caches' in window;
  async function cachedBytes(a) {
    if (!canCache) return null;
    try {
      const r = await (await caches.open(FILE_CACHE)).match(assetUrl(a));
      return r ? new Uint8Array(await r.arrayBuffer()) : null;
    } catch { return null; }
  }
  function rememberFile(a, body, type) {
    if (!canCache) return;
    caches.open(FILE_CACHE)
      .then((c) => c.put(assetUrl(a), new Response(body, { headers: { 'Content-Type': type } })))
      .catch(() => { /* brak miejsca – trudno, pobierze się następnym razem */ });
  }

  // Dokumenty PDF (po jednym na plik). Plik spoza pamięci jest pobierany kawałkami: najpierw to,
  // co potrzebne do widocznych stron, reszta w tle.
  const pdfDocs = new Map();     // assetId -> Promise<PDFDocumentProxy>
  const localImages = new Map(); // assetId -> adres obrazka z pamięci (zdjęcia wgrane z tego urządzenia)
  function getPdfDoc(a) {
    if (!pdfDocs.has(a)) {
      const p = pdfjs().then(async (lib) => {
        const cached = await cachedBytes(a);
        if (cached) return lib.getDocument({ ...PDF_OPTIONS, data: cached, worker: pdfWorker }).promise;

        const task = lib.getDocument({
          ...PDF_OPTIONS,
          url: assetUrl(a),
          worker: pdfWorker,
          disableStream: true,     // tylko potrzebne fragmenty, a nie cały plik naraz
          rangeChunkSize: 262144,  // większe kawałki = mniej zapytań przez wolne łącze
        });
        task.onProgress = ({ loaded, total }) => {
          if (total) setStatus(`Pobieranie PDF… ${Math.min(99, Math.round(loaded / total * 100))}%`, 'pdf:' + a);
        };
        const doc = await task.promise.finally(() => clearStatus('pdf:' + a));
        // Gdy w tle dojdzie reszta pliku, zapisz go na następny raz.
        if (canCache) doc.getData().then((bytes) => rememberFile(a, bytes, 'application/pdf')).catch(() => {});
        return doc;
      });
      p.catch(() => pdfDocs.delete(a));
      pdfDocs.set(a, p);
    }
    return pdfDocs.get(a);
  }

  // ---------- stan ----------
  let docName = '';               // nazwa pierwszego wgranego pliku
  let boardTitle = '';            // nazwa nadana na liście tablic
  let pages = [];                 // strony w kolejności: { id, desc, index, el, aspect, baseW, mounted, ink, ... }
  const pageById = new Map();
  const strokes = new Map();      // id -> stroke
  const byPage = new Map();       // id strony -> [stroke]
  const myStrokes = [];           // moje kreski – do cofania
  let joined = false;
  let zoom = 1;
  let lastViewerWidth = viewer.clientWidth;
  let currentPage = 0;
  let jumpToId = null;            // po najbliższym ułożeniu stron przewiń do tej strony
  let colors = loadColors();
  let tool = 'pen';               // 'pen' | 'eraser'
  let colorIndex = loadNumber('tablica.color', 1, colors.length);
  let sizeIndex = loadNumber('tablica.size', 1, PEN_SIZES.length);
  let fingerDraws = false;

  // ---------- socket ----------
  const socket = io({ transports: ['websocket', 'polling'] });
  const loadingEl = $('#loading');
  const connectHint = setTimeout(() => {
    if (!joined) loadingEl.textContent = 'Łączenie trwa dłużej niż zwykle… (sprawdź internet)';
  }, 8000);

  socket.on('connect', () => {
    $('#conn').classList.add('on');
    socket.emit('join', roomId);
    socket.emit('view', currentPage);
  });
  socket.on('disconnect', () => $('#conn').classList.remove('on'));
  socket.on('connect_error', () => {
    if (!joined) loadingEl.textContent = 'Nie mogę połączyć się z tablicą – próbuję dalej…';
  });
  socket.on('title', (t) => { boardTitle = t || ''; updateTitle(); });

  function updateTitle() {
    const name = boardTitle || docName.replace(/\.pdf$/i, '');
    document.title = name ? name + ' – Tablica PDF' : 'Tablica PDF';
  }

  // Przycisk powrotu do listy widzi tylko nauczyciel (urządzenie zalogowane PIN-em).
  let teacherToken = '';
  try { teacherToken = localStorage.getItem('tablica.teacherToken') || ''; } catch { /* brak */ }
  if (teacherToken) $('#boards').hidden = false;

  // Adres dla ucznia: w sieci domowej (szybki adres NAS-a) „Link” podaje adres internetowy tablicy.
  const onLocalAddress = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);
  let publicOrigin = onLocalAddress ? null : location.origin;
  if (onLocalAddress) {
    fetch('/api/admin/public-url').then((r) => r.json()).then(({ url }) => { publicOrigin = url; }).catch(() => {});
  } else if (teacherToken && location.protocol === 'https:') {
    fetch('/api/admin/public-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Teacher-Token': teacherToken },
      body: JSON.stringify({ url: location.origin }),
    }).catch(() => {});
  }

  // Co 4 minuty krótkie zapytanie – podtrzymuje połączenie, dopóki tablica jest otwarta.
  setInterval(() => fetch('/api/ping', { cache: 'no-store' }).catch(() => {}), 4 * 60 * 1000);

  socket.on('state', (st) => {
    strokes.clear();
    byPage.clear();
    for (const s of st.strokes) addStroke(s);
    for (let i = myStrokes.length - 1; i >= 0; i--) if (!strokes.has(myStrokes[i])) myStrokes.splice(i, 1);
    boardTitle = st.title || '';
    docName = st.name || '';
    updateTitle();

    const first = !joined;
    joined = true;
    clearTimeout(connectHint);
    loadingEl.hidden = true;
    applyPages(st.pages, { reset: first || !!st.reset });
    pages.forEach((p) => p.mounted && redrawInk(p));
  });

  socket.on('pages', ({ pages: list, name }) => {
    if (name) { docName = name; updateTitle(); }
    applyPages(list);
  });

  socket.on('stroke:begin', (s) => {
    if (strokes.has(s.id)) return;
    addStroke(s);
    markStroke(s);
  });
  socket.on('stroke:add', ({ id, pts }) => {
    const s = strokes.get(id);
    if (!s) return;
    s.pts.push(...pts);
    markStroke(s);
  });
  socket.on('stroke:remove', (id) => removeStroke(id));
  socket.on('page:clear', (pageId) => clearPageLocal(pageId));

  socket.on('peers', (list) => {
    const box = $('#peers');
    box.textContent = '';
    list.filter((p) => p.id !== socket.id).forEach((p, i, arr) => {
      const b = document.createElement('button');
      b.className = 'peer';
      b.textContent = 'str. ' + (p.page + 1);
      b.title = (arr.length > 1 ? `Osoba ${i + 2}` : 'Druga osoba') + ' – kliknij, aby przejść do tej strony';
      b.onclick = () => goToPage(p.page);
      box.appendChild(b);
    });
  });

  // Wysyła zmianę stron i czeka na potwierdzenie serwera.
  function emitAck(event, data) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ error: 'Serwer nie odpowiada – spróbuj jeszcze raz' }), 20000);
      socket.emit(event, data, (res) => { clearTimeout(timer); resolve(res || {}); });
    });
  }

  // Po odrzuconej zmianie pobierz od serwera aktualny stan tablicy.
  const resync = () => socket.emit('join', roomId);

  // ---------- kreski ----------
  function addStroke(s) {
    s._drawn = 0;
    strokes.set(s.id, s);
    if (!byPage.has(s.page)) byPage.set(s.page, []);
    byPage.get(s.page).push(s);
  }

  function removeStroke(id) {
    const s = strokes.get(id);
    if (!s) return;
    strokes.delete(id);
    const list = byPage.get(s.page);
    if (list) list.splice(list.indexOf(s), 1);
    markPage(s.page);
  }

  function clearPageLocal(pageId) {
    for (const s of byPage.get(pageId) || []) strokes.delete(s.id);
    byPage.delete(pageId);
    markPage(pageId);
  }

  // Rysowanie odbywa się raz na klatkę: albo całą stronę od nowa, albo tylko nowe odcinki kresek.
  const dirtyPages = new Set();
  const dirtyStrokes = new Set();
  let frameRequested = false;

  function markPage(id) { dirtyPages.add(id); requestFrame(); }
  function markStroke(s) { dirtyStrokes.add(s); requestFrame(); }
  function requestFrame() {
    if (frameRequested) return;
    frameRequested = true;
    requestAnimationFrame(flushFrame);
  }
  function flushFrame() {
    frameRequested = false;
    for (const id of dirtyPages) {
      const p = pageById.get(id);
      if (p && p.mounted) redrawInk(p);
    }
    for (const s of dirtyStrokes) {
      const p = pageById.get(s.page);
      if (!p || !p.mounted || dirtyPages.has(s.page) || !strokes.has(s.id)) continue;
      const ctx = p.ink.getContext('2d');
      drawStroke(ctx, s, s._drawn, p.ink.width);
      s._drawn = s.pts.length / 2;
    }
    dirtyPages.clear();
    dirtyStrokes.clear();
  }

  function redrawInk(p) {
    const ctx = p.ink.getContext('2d');
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, p.ink.width, p.ink.height);
    for (const s of byPage.get(p.id) || []) {
      drawStroke(ctx, s, 0, p.ink.width);
      s._drawn = s.pts.length / 2;
    }
  }

  // Rysuje kreskę od punktu `from` do końca; k = piksele na jednostkę (szerokość strony).
  function drawStroke(ctx, s, from, k) {
    const pts = s.pts;
    const n = pts.length / 2;
    if (n === 0 || from >= n) return;
    const erase = s.tool === 'eraser';
    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = ctx.fillStyle = erase ? '#000' : s.color;
    ctx.lineWidth = s.size * k;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const start = Math.max(from - 1, 0);
    if (n === 1) {
      ctx.beginPath();
      ctx.arc(pts[0] * k, pts[1] * k, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[start * 2] * k, pts[start * 2 + 1] * k);
    for (let i = start + 1; i < n; i++) ctx.lineTo(pts[i * 2] * k, pts[i * 2 + 1] * k);
    ctx.stroke();
  }

  // ---------- strony ----------
  // Lista stron przychodzi z serwera (albo od razu z tego urządzenia, np. po dodaniu pustej strony).
  // Istniejące strony zostają na miejscu – razem z narysowaną już treścią – dochodzą tylko nowe.
  const sameDesc = (a, b) => a.t === b.t && a.a === b.a && a.n === b.n && a.w === b.w && a.h === b.h;

  function applyPages(list, { reset = false } = {}) {
    const anchor = reset ? null : captureAnchor();
    const next = [];
    for (const d of list) {
      let p = pageById.get(d.id);
      if (!p) {
        p = { id: d.id, desc: d, aspect: d.h / d.w, baseW: d.w, mounted: false, gen: 0 };
        p.el = document.createElement('div');
        p.el.className = 'page';
        p.el.dataset.id = d.id;
        pageById.set(d.id, p);
        observer.observe(p.el);
      } else if (!sameDesc(p.desc, d)) {
        const wasMounted = p.mounted;
        unmount(p);
        Object.assign(p, { desc: d, aspect: d.h / d.w, baseW: d.w, pdfPage: null });
        if (wasMounted) mount(p); // nadal widoczna – obserwator nie zgłosi jej drugi raz
      }
      next.push(p);
    }
    const keep = new Set(list.map((d) => d.id));
    for (const p of pages) {
      if (keep.has(p.id)) continue;
      observer.unobserve(p.el);
      unmount(p);
      p.el.remove();
      pageById.delete(p.id);
    }
    pages = next;
    for (const id of [...byPage.keys()]) if (!pageById.has(id)) clearPageLocal(id);

    // Kolejność na ekranie: „+”, strona 1, „+”, strona 2, …, „+”
    pagesEl.querySelectorAll('.gap').forEach((g) => g.remove());
    const frag = document.createDocumentFragment();
    if (pages.length) frag.appendChild(insertGap(0));
    pages.forEach((p, i) => {
      p.index = i;
      p.el.dataset.n = i + 1;
      frag.appendChild(p.el);
      frag.appendChild(insertGap(i + 1));
    });
    pagesEl.appendChild(frag);
    $('#empty').hidden = pages.length > 0;

    layout();
    if (reset) viewer.scrollTop = 0;
    else restoreAnchor(anchor);
    if (jumpToId && pageById.has(jumpToId)) {
      goToPage(pageById.get(jumpToId).index);
      jumpToId = null;
    }
    updateCurrentPage();
  }

  // Zapamiętuje, która strona jest u góry ekranu – po zmianie listy stron widok się nie przesuwa.
  function captureAnchor() {
    const top = viewer.scrollTop;
    for (const p of pages) {
      if (p.el.offsetTop + p.el.offsetHeight > top) return { id: p.id, offset: top - p.el.offsetTop };
    }
    return null;
  }
  function restoreAnchor(anchor) {
    const p = anchor && pageById.get(anchor.id);
    if (p) viewer.scrollTop = p.el.offsetTop + anchor.offset;
  }

  function insertGap(at) {
    const gap = document.createElement('div');
    gap.className = 'gap';
    const b = document.createElement('button');
    b.className = 'insert';
    b.dataset.at = at;
    b.title = 'Wstaw tutaj stronę';
    b.setAttribute('aria-label', 'Wstaw tutaj stronę');
    b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
    gap.appendChild(b);
    return gap;
  }

  const pageWidth = () => Math.max(200, Math.min(viewer.clientWidth - 2 * GUTTER, MAX_PAGE_WIDTH)) * zoom;

  function layout() {
    // Drugi przebieg, gdy pojawienie się paska przewijania zmieniło dostępną szerokość.
    for (let pass = 0; pass < 2; pass++) {
      const before = viewer.clientWidth;
      const w = pageWidth();
      pagesEl.style.width = w + 2 * GUTTER > before ? w + 2 * GUTTER + 'px' : '';
      for (const p of pages) {
        p.el.style.width = w + 'px';
        p.el.style.height = w * p.aspect + 'px';
      }
      if (viewer.clientWidth === before) break;
    }
    lastViewerWidth = viewer.clientWidth;
  }

  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const p = pageById.get(e.target.dataset.id);
      if (!p || p.el !== e.target) continue;
      e.isIntersecting ? mount(p) : unmount(p);
    }
  }, { root: viewer, rootMargin: '80% 0px' });

  function mount(p) {
    if (p.mounted) return;
    p.mounted = true;
    p.ink = document.createElement('canvas');
    p.el.appendChild(p.ink);
    renderPage(p);
  }

  function unmount(p) {
    if (!p.mounted) return;
    p.mounted = false;
    p.gen++;
    if (p.task) p.task.cancel();
    for (const c of [p.pdfCanvas, p.ink]) if (c) { c.width = c.height = 0; c.remove(); }
    if (p.bg) { p.bg.removeAttribute('src'); p.bg.remove(); }
    p.pdfCanvas = p.ink = p.bg = null;
  }

  function canvasSize(p) {
    let w = pageWidth() * Math.min(window.devicePixelRatio || 1, 2);
    let h = w * p.aspect;
    if (w * h > MAX_CANVAS_PIXELS) {
      const f = Math.sqrt(MAX_CANVAS_PIXELS / (w * h));
      w *= f; h *= f;
    }
    return [Math.round(w), Math.round(h)];
  }

  // Strona PDF-a; przy okazji poprawia proporcje, jeśli zapisane różnią się od prawdziwych.
  function getPdfPage(p) {
    if (!p.pdfPage) {
      const { a, n } = p.desc;
      p.pdfPage = getPdfDoc(a).then((doc) => doc.getPage(n + 1)).then((pg) => {
        const vp = pg.getViewport({ scale: 1 });
        if (Math.abs(vp.height / vp.width - p.aspect) > 0.005) {
          p.aspect = vp.height / vp.width;
          relayoutSoon();
        }
        p.baseW = vp.width;
        return pg;
      });
      p.pdfPage.catch(() => { p.pdfPage = null; });
    }
    return p.pdfPage;
  }

  let relayoutTimer = null;
  function relayoutSoon() {
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(() => {
      const anchor = captureAnchor();
      layout();
      restoreAnchor(anchor);
      rerenderSoon();
    }, 50);
  }

  async function renderPage(p) {
    const gen = ++p.gen;
    const [w, h] = canvasSize(p);
    p.ink.width = w;
    p.ink.height = h;
    redrawInk(p); // zapiski widać od razu, zanim dojdzie treść strony

    const d = p.desc;
    if (d.t === 'blank') return;
    if (d.t === 'img') {
      if (!p.bg) {
        p.bg = new Image();
        p.bg.className = 'bg';
        p.bg.decoding = 'async';
        p.bg.alt = '';
        p.bg.src = localImages.get(d.a) || assetUrl(d.a);
        p.el.insertBefore(p.bg, p.ink);
      }
      return;
    }

    let pdfPage;
    try {
      pdfPage = await getPdfPage(p);
    } catch (err) {
      console.error(err);
      if (gen === p.gen) toast('Nie udało się wczytać strony PDF – odśwież tablicę');
      return;
    }
    if (gen !== p.gen || !p.mounted) return;
    if (p.task) p.task.cancel();
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const viewport = pdfPage.getViewport({ scale: w / pdfPage.getViewport({ scale: 1 }).width });
    const task = pdfPage.render({ canvasContext: c.getContext('2d'), viewport });
    p.task = task;
    try {
      await task.promise;
    } catch {
      c.width = c.height = 0;
      return;
    }
    if (gen !== p.gen || !p.mounted) { c.width = c.height = 0; return; }
    p.task = null;
    if (p.pdfCanvas) { p.pdfCanvas.width = p.pdfCanvas.height = 0; p.pdfCanvas.remove(); }
    p.pdfCanvas = c;
    p.el.insertBefore(c, p.ink);
  }

  let rerenderTimer = null;
  function rerenderSoon() {
    clearTimeout(rerenderTimer);
    rerenderTimer = setTimeout(() => pages.forEach((p) => p.mounted && renderPage(p)), 220);
  }

  // ---------- powiększenie ----------
  function setZoom(z, fx = viewer.clientWidth / 2, fy = viewer.clientHeight / 2) {
    z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    if (Math.abs(z - zoom) < 1e-3) return;
    const r = z / zoom;
    const cx = viewer.scrollLeft + fx;
    const cy = viewer.scrollTop + fy;
    zoom = z;
    layout();
    viewer.scrollLeft = cx * r - fx;
    viewer.scrollTop = cy * r - fy;
    rerenderSoon();
  }

  $('#zoomIn').onclick = () => setZoom(zoom * 1.25);
  $('#zoomOut').onclick = () => setZoom(zoom / 1.25);

  window.addEventListener('resize', () => {
    if (viewer.clientWidth === lastViewerWidth) return;
    const ratio = viewer.scrollTop / Math.max(1, pagesEl.scrollHeight);
    lastViewerWidth = viewer.clientWidth;
    layout();
    viewer.scrollTop = ratio * pagesEl.scrollHeight;
    rerenderSoon();
  });

  // ---------- bieżąca strona ----------
  function updateCurrentPage() {
    let best = 0;
    const mid = viewer.scrollTop + viewer.clientHeight / 2;
    for (const p of pages) {
      if (p.el.offsetTop <= mid) best = p.index; else break;
    }
    if (best !== currentPage) {
      currentPage = best;
      socket.emit('view', currentPage);
    }
    updatePageInfo();
  }
  function updatePageInfo() {
    $('#pageInfo').textContent = pages.length ? `${currentPage + 1} / ${pages.length}` : '– / –';
  }
  let scrollQueued = false;
  viewer.addEventListener('scroll', () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => { scrollQueued = false; updateCurrentPage(); });
  });

  function goToPage(i) {
    const p = pages[i];
    if (p) viewer.scrollTop = p.el.offsetTop - 8;
  }

  $('#pageInfo').onclick = () => {
    if (!pages.length) return;
    const n = parseInt(prompt(`Przejdź do strony (1–${pages.length}):`, currentPage + 1), 10);
    if (n >= 1 && n <= pages.length) goToPage(n - 1);
  };

  // ---------- narzędzia ----------
  function loadColors() {
    try {
      const c = JSON.parse(localStorage.getItem('tablica.colors5'));
      if (Array.isArray(c) && c.length === DEFAULT_COLORS.length) return c;
    } catch { /* brak */ }
    return DEFAULT_COLORS.slice();
  }
  function loadNumber(key, fallback, count) {
    try {
      const n = parseInt(localStorage.getItem(key), 10);
      if (n >= 0 && n < count) return n;
    } catch { /* brak */ }
    return fallback;
  }
  function store(key, value) {
    try { localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); } catch { /* brak */ }
  }

  // Przyciski kolorów i grubości tworzone z list powyżej.
  const colorButtons = colors.map((_, i) => {
    const b = document.createElement('button');
    b.className = 'tool swatch';
    b.title = `Kolor ${i + 1} (dotknij ponownie, aby zmienić)`;
    b.setAttribute('aria-label', `Kolor ${i + 1}`);
    b.appendChild(document.createElement('span'));
    b.onclick = () => selectColor(i, true);
    $('#colors').appendChild(b);
    return b;
  });
  const sizeButtons = PEN_SIZES.map((size, i) => {
    const b = document.createElement('button');
    b.className = 'tool size';
    b.title = SIZE_NAMES[i];
    b.setAttribute('aria-label', 'Grubość: ' + SIZE_NAMES[i]);
    const dot = document.createElement('span');
    dot.style.width = dot.style.height = Math.round(3 + i * 4.5) + 'px';
    b.appendChild(dot);
    b.onclick = () => selectSize(i);
    $('#sizes').appendChild(b);
    return b;
  });

  function renderTools() {
    colorButtons.forEach((b, i) => {
      b.style.setProperty('--c', colors[i]);
      b.classList.toggle('active', tool === 'pen' && i === colorIndex);
    });
    sizeButtons.forEach((b, i) => {
      b.style.setProperty('--c', tool === 'eraser' ? '#9ca3af' : colors[colorIndex]);
      b.classList.toggle('active', i === sizeIndex);
    });
    $('#eraser').classList.toggle('active', tool === 'eraser');
    pagesEl.classList.toggle('erasing', tool === 'eraser');
  }

  function selectColor(i, fromClick) {
    if (fromClick && tool === 'pen' && i === colorIndex) {
      editingColor = i;
      colorInput.value = colors[i];
      colorInput.click();
      return;
    }
    tool = 'pen';
    colorIndex = i;
    store('tablica.color', String(i));
    renderTools();
  }

  function selectSize(i) {
    sizeIndex = Math.max(0, Math.min(PEN_SIZES.length - 1, i));
    store('tablica.size', String(sizeIndex));
    renderTools();
  }

  const colorInput = $('#colorInput');
  let editingColor = 0;
  colorInput.addEventListener('input', () => {
    colors[editingColor] = colorInput.value;
    store('tablica.colors5', colors);
    renderTools();
  });

  $('#eraser').onclick = () => { tool = 'eraser'; renderTools(); };

  $('#finger').onclick = (e) => {
    fingerDraws = !fingerDraws;
    e.currentTarget.setAttribute('aria-pressed', fingerDraws);
    toast(fingerDraws ? 'Palec rysuje – przewijaj kółkiem myszy albo wyłącz tę opcję' : 'Palec przewija, rysik pisze');
  };

  function undo() {
    while (myStrokes.length) {
      const id = myStrokes.pop();
      if (strokes.has(id)) {
        removeStroke(id);
        socket.emit('stroke:remove', id);
        return;
      }
    }
    toast('Nie ma nic do cofnięcia');
  }
  $('#undo').onclick = undo;

  // Kosz: wyczyść zapiski na bieżącej stronie albo usuń całą stronę.
  const pageDialog = $('#pageDialog');
  let dialogPage = null;
  $('#clear').onclick = () => {
    if (!pages.length) return;
    dialogPage = pages[currentPage];
    $('#pageDialogTitle').textContent = `Strona ${currentPage + 1}`;
    $('#pageDelete').disabled = pages.length < 2;
    pageDialog.showModal();
  };
  $('#pageClear').onclick = () => {
    pageDialog.close();
    clearPageLocal(dialogPage.id);
    socket.emit('page:clear', dialogPage.id);
  };
  $('#pageDelete').onclick = () => { pageDialog.close(); deletePage(dialogPage); };
  $('#pageCancel').onclick = () => pageDialog.close();

  // „+” między stronami: pusta strona albo zdjęcia/PDF w wybranym miejscu.
  const insertDialog = $('#insertDialog');
  let insertAt = 0;
  let pendingInsertAt = null; // ustawione, gdy wybór plików ma trafić w konkretne miejsce
  pagesEl.addEventListener('click', (e) => {
    const b = e.target.closest('.insert');
    if (!b) return;
    insertAt = +b.dataset.at;
    $('#insertTitle').textContent =
      insertAt === 0 ? 'Wstaw przed stroną 1'
        : insertAt >= pages.length ? `Wstaw na końcu (po stronie ${pages.length})`
          : `Wstaw między stroną ${insertAt} a ${insertAt + 1}`;
    insertDialog.showModal();
  });
  $('#insertBlank').onclick = () => { insertDialog.close(); insertBlank(insertAt); };
  $('#insertFiles').onclick = () => {
    insertDialog.close();
    pendingInsertAt = insertAt;
    fileInput.click(); // w tym samym kliknięciu – inaczej iPad nie otworzy wyboru plików
  };
  $('#insertCancel').onclick = () => insertDialog.close();
  $('#emptyBlank').onclick = () => insertBlank(0);

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    else if (e.ctrlKey || e.metaKey || e.altKey) return;
    else if (e.key >= '1' && e.key <= String(colors.length)) selectColor(+e.key - 1, false);
    else if (e.key === '[') selectSize(sizeIndex - 1);
    else if (e.key === ']') selectSize(sizeIndex + 1);
    else if (e.key.toLowerCase() === 'e') { tool = 'eraser'; renderTools(); }
  });

  // ---------- dodawanie i usuwanie stron ----------
  const round2 = (v) => Math.round(v * 100) / 100;
  const descs = () => pages.map((p) => p.desc);

  // Rozmiar sąsiedniej strony – pusta strona i zdjęcia dopasowują się do niego.
  function neighbourSize(at) {
    const ref = pages[Math.min(Math.max(at - 1, 0), pages.length - 1)];
    return ref ? { w: ref.baseW, h: ref.baseW * ref.aspect } : A4;
  }

  // Pusta strona to tylko wpis na liście stron – pojawia się od razu, bez wysyłania plików.
  async function insertBlank(at) {
    const { w, h } = neighbourSize(at);
    const page = { id: randomId(10), t: 'blank', w: round2(w), h: round2(h) };
    const list = descs();
    list.splice(at, 0, page);
    jumpToId = page.id;
    applyPages(list);
    const res = await emitAck('pages:insert', { at, pages: [page] });
    if (res.error) { toast(res.error); resync(); }
  }

  async function deletePage(p) {
    applyPages(descs().filter((d) => d.id !== p.id));
    const res = await emitAck('pages:delete', p.id);
    if (res.error) { toast(res.error); resync(); } else toast(`Usunięto stronę ${p.index + 1}`);
  }

  const fileInput = $('#fileInput');
  $('#upload').onclick = $('#emptyUpload').onclick = () => {
    pendingInsertAt = null;
    fileInput.click();
  };

  // Zdjęcia są zmniejszane i zapisywane jako JPEG w przeglądarce – wysyła się kilkaset kB zamiast kilku MB.
  const MAX_IMAGE_SIDE = 2000;
  const isPdfFile = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files);
    fileInput.value = '';
    const at = pendingInsertAt;
    pendingInsertAt = null;
    if (!files.length) return;

    if (at !== null && pages.length) { addFiles(files, at); return; }
    if (!pages.length) { addFiles(files, null); return; }
    const mode = await askUploadMode();
    if (mode === 'append') addFiles(files, pages.length);
    else if (mode === 'replace') addFiles(files, null);
  });

  // Wgrywa pliki i wstawia ich strony przed pozycją `at` (null = zastąp całą tablicę).
  // Każdy plik idzie na serwer raz; strony pokazują się od razu z pamięci tego urządzenia.
  let adding = false;
  async function addFiles(files, at) {
    if (adding) { toast('Poczekaj – trwa dodawanie poprzednich plików'); return; }
    adding = true;
    try {
      const width = at === null ? A4.w : neighbourSize(at).w;
      const newPages = [];
      let name = '';
      for (const [k, f] of files.entries()) {
        const of = files.length > 1 ? ` ${k + 1}/${files.length}` : '';
        if (isPdfFile(f)) {
          setStatus(`Czytam PDF${of}…`, 'add');
          const lib = await pdfjs();
          const doc = await lib.getDocument({ ...PDF_OPTIONS, data: new Uint8Array(await f.arrayBuffer()), worker: pdfWorker }).promise;
          const sizes = [];
          for (let i = 1; i <= doc.numPages; i++) {
            const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
            sizes.push({ w: round2(vp.width), h: round2(vp.height) });
          }
          const { id } = await uploadAsset(f, `Wysyłanie PDF${of}`, doc.numPages);
          pdfDocs.set(id, Promise.resolve(doc)); // już jest w pamięci – nie trzeba go pobierać z powrotem
          rememberFile(id, f, 'application/pdf');
          sizes.forEach((s, n) => newPages.push({ id: randomId(10), t: 'pdf', a: id, n, ...s }));
          name = name || f.name;
        } else {
          setStatus(`Przygotowuję zdjęcie${of}…`, 'add');
          const img = await imageToJpeg(f);
          const { id } = await uploadAsset(img.blob, `Wysyłanie zdjęcia${of}`);
          localImages.set(id, URL.createObjectURL(img.blob)); // zdjęcia zapamiętuje zwykła pamięć przeglądarki
          newPages.push({ id: randomId(10), t: 'img', a: id, w: round2(width), h: round2(width * img.height / img.width) });
          name = name || f.name.replace(/\.[^.]+$/, '');
        }
      }
      setStatus('Dodaję strony…', 'add');
      let res;
      if (at === null) {
        res = await emitAck('pages:replace', { pages: newPages, name });
      } else {
        jumpToId = newPages[0].id;
        res = await emitAck('pages:insert', { at, pages: newPages, name });
      }
      if (res.error) throw Object.assign(new Error(res.error), { userMessage: res.error });
      toast(newPages.length === 1 ? 'Dodano stronę' : `Dodano strony: ${newPages.length}`);
    } catch (err) {
      jumpToId = null;
      console.error(err);
      toast(err.userMessage || 'Nie udało się dodać plików');
    } finally {
      adding = false;
      clearStatus('add');
    }
  }

  function uploadAsset(blob, label, pdfPages) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/room/${roomId}/asset`);
      xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(blob.name || ''));
      if (pdfPages) xhr.setRequestHeader('X-Pages', String(pdfPages));
      xhr.upload.onprogress = (e) => e.lengthComputable &&
        setStatus(`${label}… ${Math.round(e.loaded / e.total * 100)}%`, 'add');
      xhr.onload = () => {
        if (xhr.status === 200) resolve(JSON.parse(xhr.responseText));
        else reject(Object.assign(new Error(xhr.responseText), { userMessage: xhr.responseText || 'Błąd serwera' }));
      };
      xhr.onerror = () => reject(Object.assign(new Error('network'), { userMessage: 'Nie udało się wysłać pliku' }));
      xhr.send(blob);
    });
  }

  async function imageToJpeg(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      try { await img.decode(); } catch {
        throw Object.assign(new Error('decode'), { userMessage: `Nie można odczytać pliku „${file.name}”` });
      }
      const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; // przezroczyste tło (np. PNG) -> białe
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
      const result = { blob, width: c.width, height: c.height };
      c.width = c.height = 0;
      return result;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const uploadDialog = $('#uploadDialog');
  function askUploadMode() {
    return new Promise((resolve) => {
      uploadDialog.returnValue = 'cancel';
      uploadDialog.addEventListener('close', () => resolve(uploadDialog.returnValue || 'cancel'), { once: true });
      uploadDialog.showModal();
    });
  }

  $('#share').onclick = async () => {
    const url = `${publicOrigin || location.origin}/?b=${roomId}`;
    const note = publicOrigin ? '' : ' (uwaga: ten adres działa tylko w Twojej sieci domowej)';
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title: 'Tablica PDF', url }); if (note) toast('Link' + note, 5000); return; } catch { /* anulowano */ }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Link skopiowany – wyślij go uczniowi' + note, note ? 5000 : 2200);
    } catch {
      prompt('Skopiuj ten link i wyślij uczniowi:', url);
    }
  };

  // ---------- pobieranie PDF z notatkami ----------
  // Strony z PDF-ów zostają oryginalne (tekst nadal ostry), puste strony i zdjęcia dochodzą jako nowe
  // strony, a notatki z każdej strony są nakładane na nią jako przezroczysty obraz.
  const EXPORT_SCALE = 3; // piksele obrazu notatek na punkt PDF (~216 dpi)
  let exporting = false;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { s.remove(); reject(new Error('Nie udało się wczytać ' + src)); };
      document.head.appendChild(s);
    });
  }

  async function loadPdfLib() {
    if (!window.PDFLib) await loadScript('/vendor/pdf-lib/pdf-lib.min.js');
    return window.PDFLib;
  }

  // Bajty pliku do PDF-a z notatkami – najpierw z pamięci (PDF otwarty na tablicy, pamięć urządzenia),
  // z serwera tylko to, czego jeszcze nie ma.
  async function assetBytes(a, type) {
    if (type === 'pdf') return (await getPdfDoc(a)).getData();
    const r = await fetch(localImages.get(a) || assetUrl(a));
    if (!r.ok) throw new Error('Brak pliku ' + a);
    return r.arrayBuffer();
  }

  function inkPng(pageId, width, height) {
    const c = document.createElement('canvas');
    c.width = Math.round(width * EXPORT_SCALE);
    c.height = Math.round(height * EXPORT_SCALE);
    const ctx = c.getContext('2d');
    for (const s of byPage.get(pageId) || []) drawStroke(ctx, s, 0, c.width);
    return new Promise((resolve) => c.toBlob((blob) => {
      c.width = c.height = 0;
      blob.arrayBuffer().then(resolve);
    }, 'image/png'));
  }

  async function exportPdf() {
    if (exporting) return;
    if (!pages.length) { toast('Tablica nie ma jeszcze stron'); return; }
    exporting = true;
    try {
      setStatus('Przygotowuję PDF…', 'export');
      const [{ PDFDocument, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject }, lib] =
        await Promise.all([loadPdfLib(), pdfjs()]);
      const out = await PDFDocument.create();

      // Strony z PDF-ów: kopiowane naraz z każdego pliku (wspólne czcionki trafiają do wyniku raz).
      const copies = new Map(); // id strony tablicy -> skopiowana strona
      const byAsset = new Map();
      for (const p of pages) if (p.desc.t === 'pdf') {
        if (!byAsset.has(p.desc.a)) byAsset.set(p.desc.a, []);
        byAsset.get(p.desc.a).push(p);
      }
      for (const [a, list] of byAsset) {
        const src = await PDFDocument.load(await assetBytes(a, 'pdf'), { ignoreEncryption: true });
        const copied = await out.copyPages(src, list.map((p) => p.desc.n));
        list.forEach((p, i) => copies.set(p.id, copied[i]));
      }

      const images = new Map(); // assetId -> osadzone zdjęcie
      for (const p of pages) {
        setStatus(`Przygotowuję PDF… strona ${p.index + 1} z ${pages.length}`, 'export');
        const d = p.desc;
        let page, w, h, m;
        if (d.t === 'pdf') {
          page = out.addPage(copies.get(p.id));
          // Widok pdf.js (z obrotem i przycięciem strony) -> układ współrzędnych PDF.
          const vp = (await getPdfPage(p)).getViewport({ scale: 1 });
          w = vp.width; h = vp.height;
          m = lib.Util.transform(lib.Util.inverseTransform(vp.transform), [w, 0, 0, -h, 0, h]);
        } else {
          w = d.w; h = d.h;
          page = out.addPage([w, h]);
          m = [w, 0, 0, h, 0, 0];
          if (d.t === 'img') {
            if (!images.has(d.a)) images.set(d.a, await out.embedJpg(await assetBytes(d.a, 'jpg')));
            page.drawImage(images.get(d.a), { x: 0, y: 0, width: w, height: h });
          }
        }
        if (!(byPage.get(p.id) || []).some((s) => s.tool === 'pen')) continue;
        const png = await out.embedPng(await inkPng(p.id, w, h));
        const name = page.node.newXObject('Notatki', png.ref);
        page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m), drawObject(name), popGraphicsState());
      }

      const blob = new Blob([await out.save()], { type: 'application/pdf' });
      const date = new Date().toISOString().slice(0, 10);
      const base = (boardTitle || docName || 'tablica').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '-');
      saveFile(blob, `${base} – notatki ${date}.pdf`);
      toast('PDF z notatkami gotowy');
    } catch (err) {
      console.error(err);
      toast('Nie udało się przygotować PDF-a');
    } finally {
      exporting = false;
      clearStatus('export');
    }
  }

  function saveFile(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  $('#download').onclick = exportPdf;

  // ---------- komunikaty ----------
  let toastTimer = null;
  function toast(msg, ms = 2200) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  // Stały pasek postępu (pobieranie, wysyłanie) – widoczny, dopóki trwa praca; ostatni komunikat wygrywa.
  const statusMsgs = new Map();
  function setStatus(text, key) {
    statusMsgs.delete(key);
    statusMsgs.set(key, text);
    showStatus();
  }
  function clearStatus(key) {
    statusMsgs.delete(key);
    showStatus();
  }
  function showStatus() {
    const el = $('#status');
    const last = [...statusMsgs.values()].pop();
    el.hidden = !last;
    if (last) el.textContent = last;
  }

  // ---------- rysowanie i gesty ----------
  const drawing = new Map();   // pointerId -> { stroke, rect, pending }
  const touches = new Map();   // pointerId -> {x, y} (palce przewijające)
  let penBusyUntil = 0;        // ignoruj dłoń opartą o ekran podczas pisania rysikiem
  let gesture = null;
  let momentum = null;

  viewer.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  viewer.addEventListener('contextmenu', (e) => e.preventDefault());

  viewer.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#empty, button')) return; // np. „+” między stronami – zwykłe kliknięcie
    if (e.pointerType === 'pen') {
      penBusyUntil = Infinity;
      cancelTouches();
    }
    const isTouch = e.pointerType === 'touch';
    if (isTouch && (!fingerDraws || touches.size)) {
      if (performance.now() < penBusyUntil) return;
      startTouch(e);
      return;
    }
    if (isTouch && performance.now() < penBusyUntil) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const pageEl = e.target.closest('.page');
    const page = pageEl && pageById.get(pageEl.dataset.id);
    if (!page) {
      if (isTouch) startTouch(e);
      return;
    }
    e.preventDefault();
    stopMomentum();
    const eraser = tool === 'eraser' || (e.buttons & 32) !== 0;
    const stroke = {
      id: `${clientId}-${++strokeCounter}`,
      page: page.id,
      tool: eraser ? 'eraser' : 'pen',
      color: eraser ? '#000' : colors[colorIndex],
      size: eraser ? ERASER_SIZES[sizeIndex] : PEN_SIZES[sizeIndex],
      pts: [],
    };
    const d = { stroke, rect: pageEl.getBoundingClientRect(), pending: [] };
    pushPoint(d, e);
    d.pending = [];
    addStroke(stroke);
    myStrokes.push(stroke.id);
    drawing.set(e.pointerId, d);
    viewer.setPointerCapture(e.pointerId);
    socket.emit('stroke:begin', stroke);
    markStroke(stroke);
  });

  viewer.addEventListener('pointermove', (e) => {
    const d = drawing.get(e.pointerId);
    if (d) {
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (events.length) events.forEach((ev) => pushPoint(d, ev)); else pushPoint(d, e);
      markStroke(d.stroke);
      return;
    }
    if (touches.has(e.pointerId)) moveTouch(e);
  });

  const endPointer = (e) => {
    if (e.pointerType === 'pen') penBusyUntil = performance.now() + 600;
    const d = drawing.get(e.pointerId);
    if (d) {
      drawing.delete(e.pointerId);
      flushPoints(d);
      socket.emit('stroke:end', d.stroke.id);
      return;
    }
    if (touches.has(e.pointerId)) endTouch(e);
  };
  viewer.addEventListener('pointerup', endPointer);
  viewer.addEventListener('pointercancel', endPointer);

  function pushPoint(d, e) {
    const x = (e.clientX - d.rect.left) / d.rect.width;
    const y = (e.clientY - d.rect.top) / d.rect.width;
    const pts = d.stroke.pts;
    const n = pts.length;
    if (n >= 2) {
      const dx = x - pts[n - 2], dy = y - pts[n - 1];
      if (dx * dx + dy * dy < 1e-8) return; // pomiń punkty w tym samym miejscu
    }
    // 4 miejsca po przecinku = 0,1 px przy stronie szerokiej na 1000 px; mniej danych do wysłania.
    const rx = Math.round(x * 1e4) / 1e4, ry = Math.round(y * 1e4) / 1e4;
    pts.push(rx, ry);
    d.pending.push(rx, ry);
  }

  function flushPoints(d) {
    if (!d.pending.length) return;
    socket.emit('stroke:add', { id: d.stroke.id, pts: d.pending });
    d.pending = [];
  }
  setInterval(() => drawing.forEach(flushPoints), SEND_INTERVAL);

  // Przewijanie jednym palcem (z bezwładnością) i powiększanie dwoma palcami.
  function startTouch(e) {
    stopMomentum();
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    viewer.setPointerCapture(e.pointerId);
    beginGesture();
  }

  function beginGesture() {
    const pts = [...touches.values()];
    const rect = viewer.getBoundingClientRect();
    const mid = center(pts);
    gesture = {
      dist: pts.length > 1 ? distance(pts) : 0,
      zoom,
      mx: mid.x - rect.left,
      my: mid.y - rect.top,
      vx: 0, vy: 0, t: performance.now(),
    };
  }

  function moveTouch(e) {
    const prevMid = center([...touches.values()]);
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...touches.values()];
    const mid = center(pts);
    const dx = mid.x - prevMid.x, dy = mid.y - prevMid.y;

    if (pts.length > 1 && gesture.dist > 0) {
      const rect = viewer.getBoundingClientRect();
      setZoom(gesture.zoom * distance(pts) / gesture.dist, mid.x - rect.left, mid.y - rect.top);
    }
    viewer.scrollLeft -= dx;
    viewer.scrollTop -= dy;

    const now = performance.now();
    const dt = Math.max(1, now - gesture.t);
    gesture.vx = 0.8 * (-dx / dt) + 0.2 * gesture.vx;
    gesture.vy = 0.8 * (-dy / dt) + 0.2 * gesture.vy;
    gesture.t = now;
  }

  function endTouch(e) {
    touches.delete(e.pointerId);
    if (touches.size) { beginGesture(); return; }
    const g = gesture;
    gesture = null;
    if (g && performance.now() - g.t < 80) startMomentum(g.vx, g.vy);
  }

  function cancelTouches() {
    touches.clear();
    gesture = null;
    stopMomentum();
  }

  function startMomentum(vx, vy) {
    let last = performance.now();
    const step = (now) => {
      const dt = now - last;
      last = now;
      viewer.scrollLeft += vx * dt;
      viewer.scrollTop += vy * dt;
      const decay = Math.pow(0.995, dt);
      vx *= decay; vy *= decay;
      if (Math.hypot(vx, vy) > 0.02) momentum = requestAnimationFrame(step);
      else momentum = null;
    };
    momentum = requestAnimationFrame(step);
  }
  function stopMomentum() {
    if (momentum) cancelAnimationFrame(momentum);
    momentum = null;
  }

  const center = (pts) => ({
    x: pts.reduce((a, p) => a + p.x, 0) / pts.length,
    y: pts.reduce((a, p) => a + p.y, 0) / pts.length,
  });
  const distance = (pts) => Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);

  // Ctrl + kółko myszy / gest szczypania na touchpadzie = powiększenie
  viewer.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const rect = viewer.getBoundingClientRect();
    setZoom(zoom * Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  renderTools();
  updatePageInfo();
})();
