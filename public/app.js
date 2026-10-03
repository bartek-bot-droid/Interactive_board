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

  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';

  const $ = (s) => document.querySelector(s);
  const viewer = $('#viewer');
  const pagesEl = $('#pages');

  // ---------- identyfikator tablicy w adresie ----------
  const params = new URLSearchParams(location.search);
  let roomId = (params.get('b') || '').toLowerCase();
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

  // ---------- stan ----------
  let pdfDoc = null;
  let pdfVersion;                 // undefined = jeszcze nic nie wczytano
  let pdfInfo = null;             // { version, name }
  let boardTitle = '';            // nazwa nadana na liście tablic
  let pages = [];                 // { index, el, pdfPage, baseW, aspect, mounted, pdfCanvas, ink, task, gen }
  const strokes = new Map();      // id -> stroke
  const byPage = new Map();       // nr strony -> [stroke]
  const myStrokes = [];           // moje kreski – do cofania
  let zoom = 1;
  let lastViewerWidth = viewer.clientWidth;
  let currentPage = 0;
  let colors = loadColors();
  let tool = 'pen';               // 'pen' | 'eraser'
  let colorIndex = loadNumber('tablica.color', 1, colors.length);
  let sizeIndex = loadNumber('tablica.size', 1, PEN_SIZES.length);
  let fingerDraws = false;

  // ---------- socket ----------
  const socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    $('#conn').classList.add('on');
    socket.emit('join', roomId);
    socket.emit('view', currentPage);
  });
  socket.on('disconnect', () => $('#conn').classList.remove('on'));
  socket.on('title', (t) => { boardTitle = t || ''; updateTitle(); });

  function updateTitle() {
    const name = boardTitle || (pdfInfo ? pdfInfo.name.replace(/\.pdf$/i, '') : '');
    document.title = name ? name + ' – Tablica PDF' : 'Tablica PDF';
  }

  // Przycisk powrotu do listy widzi tylko nauczyciel (urządzenie zalogowane PIN-em).
  try { if (localStorage.getItem('tablica.teacherToken')) $('#boards').hidden = false; } catch { /* brak */ }

  // Darmowy Render usypia serwer po 15 min bez zapytań HTTP (i kasuje wtedy tablice),
  // więc dopóki tablica jest otwarta, co 4 minuty dajemy znać, że ktoś z niej korzysta.
  setInterval(() => fetch('/api/ping', { cache: 'no-store' }).catch(() => {}), 4 * 60 * 1000);

  socket.on('state', async (st) => {
    strokes.clear();
    byPage.clear();
    for (const s of st.strokes) addStroke(s);
    for (let i = myStrokes.length - 1; i >= 0; i--) if (!strokes.has(myStrokes[i])) myStrokes.splice(i, 1);

    pdfInfo = st.pdf;
    boardTitle = st.title || '';
    updateTitle();
    const v = st.pdf ? st.pdf.version : null;
    if (v !== pdfVersion) {
      pdfVersion = v;
      await loadPdf(st.pdf);
    } else {
      pages.forEach((p) => p.mounted && redrawInk(p));
    }
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
  socket.on('page:clear', (page) => clearPageLocal(page));

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

  function clearPageLocal(page) {
    for (const s of byPage.get(page) || []) strokes.delete(s.id);
    byPage.delete(page);
    markPage(page);
  }

  // Rysowanie odbywa się raz na klatkę: albo całą stronę od nowa, albo tylko nowe odcinki kresek.
  const dirtyPages = new Set();
  const dirtyStrokes = new Set();
  let frameRequested = false;

  function markPage(i) { dirtyPages.add(i); requestFrame(); }
  function markStroke(s) { dirtyStrokes.add(s); requestFrame(); }
  function requestFrame() {
    if (frameRequested) return;
    frameRequested = true;
    requestAnimationFrame(flushFrame);
  }
  function flushFrame() {
    frameRequested = false;
    for (const i of dirtyPages) if (pages[i] && pages[i].mounted) redrawInk(pages[i]);
    for (const s of dirtyStrokes) {
      const p = pages[s.page];
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
    for (const s of byPage.get(p.index) || []) {
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

  // ---------- PDF i strony ----------
  async function loadPdf(info) {
    // Gdy zapiski zostały (doklejono strony), zostań w tym samym miejscu dokumentu.
    const prevScroll = strokes.size ? viewer.scrollTop : 0;
    teardownPages();
    pdfDoc && pdfDoc.destroy();
    pdfDoc = null;
    $('#empty').hidden = !!info;
    if (!info) { updatePageInfo(); return; }

    $('#loading').hidden = false;
    try {
      const doc = await pdfjsLib.getDocument({
        url: `/api/room/${roomId}/pdf?v=${info.version}`,
        cMapUrl: '/vendor/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/vendor/fonts/',
      }).promise;
      if (info.version !== pdfVersion) { doc.destroy(); return; }
      pdfDoc = doc;
      const pdfPages = await Promise.all(
        Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1))
      );
      if (info.version !== pdfVersion) return;
      pages = pdfPages.map((pdfPage, index) => {
        const vp = pdfPage.getViewport({ scale: 1 });
        const el = document.createElement('div');
        el.className = 'page';
        el.dataset.index = index;
        el.dataset.n = index + 1;
        pagesEl.appendChild(el);
        return { index, el, pdfPage, baseW: vp.width, aspect: vp.height / vp.width, mounted: false, gen: 0 };
      });
      layout();
      pages.forEach((p) => observer.observe(p.el));
      viewer.scrollTop = prevScroll;
      if (jumpToPage !== null) { goToPage(jumpToPage); jumpToPage = null; }
      updateCurrentPage();
    } catch (err) {
      console.error(err);
      toast('Nie udało się otworzyć PDF-a');
    } finally {
      $('#loading').hidden = true;
    }
  }

  function teardownPages() {
    pages.forEach((p) => { observer.unobserve(p.el); unmount(p); });
    pages = [];
    pagesEl.textContent = '';
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
      const p = pages[+e.target.dataset.index];
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
    p.pdfCanvas = p.ink = null;
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

  async function renderPage(p) {
    const gen = ++p.gen;
    const [w, h] = canvasSize(p);
    p.ink.width = w;
    p.ink.height = h;
    redrawInk(p);

    if (p.task) p.task.cancel();
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const viewport = p.pdfPage.getViewport({ scale: w / p.baseW });
    const task = p.pdfPage.render({ canvasContext: c.getContext('2d'), viewport });
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

  $('#clear').onclick = () => {
    if (!pages.length) return;
    if (!confirm(`Wyczyścić wszystkie zapiski na stronie ${currentPage + 1}?`)) return;
    clearPageLocal(currentPage);
    socket.emit('page:clear', currentPage);
  };

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    else if (e.ctrlKey || e.metaKey || e.altKey) return;
    else if (e.key >= '1' && e.key <= String(colors.length)) selectColor(+e.key - 1, false);
    else if (e.key === '[') selectSize(sizeIndex - 1);
    else if (e.key === ']') selectSize(sizeIndex + 1);
    else if (e.key.toLowerCase() === 'e') { tool = 'eraser'; renderTools(); }
  });

  // ---------- wgrywanie PDF i link ----------
  const fileInput = $('#fileInput');
  $('#upload').onclick = () => fileInput.click();
  $('#emptyUpload').onclick = () => fileInput.click();

  // Można wybrać PDF-y i/lub zdjęcia (kilka naraz). Zdjęcia są zamieniane na strony PDF w przeglądarce.
  const MAX_IMAGE_SIDE = 2400;  // dłuższy bok zdjęcia w pikselach (zdjęcia z telefonu są zmniejszane)
  const IMAGE_PAGE_WIDTH = 595; // szerokość strony ze zdjęciem w punktach PDF (jak A4)
  let jumpToPage = null;

  const isPdfFile = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files);
    fileInput.value = '';
    if (!files.length) return;

    let mode = 'replace';
    if (pdfDoc) {
      mode = await askUploadMode();
      if (mode === 'cancel') return;
    }

    try {
      let blob = files[0];
      let name = files[0].name;
      const oldCount = pages.length;
      if (mode === 'append') {
        toast('Przygotowuję strony…', 60000);
        const current = await fetch(`/api/room/${roomId}/pdf?v=${pdfInfo.version}`).then((r) => r.blob());
        blob = await buildPdf([current, ...files]);
        name = pdfInfo.name;
      } else if (files.length > 1 || !isPdfFile(files[0])) {
        toast('Przygotowuję strony…', 60000);
        blob = await buildPdf(files);
        name = files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') + '.pdf' : `Tablica ${new Date().toISOString().slice(0, 10)}.pdf`;
      }
      if (mode === 'append') jumpToPage = oldCount; // po wczytaniu przewiń do pierwszej nowej strony
      await uploadPdf(blob, name, mode === 'append');
    } catch (err) {
      jumpToPage = null;
      console.error(err);
      toast(err.userMessage || 'Nie udało się przygotować plików');
    }
  });

  function uploadPdf(blob, name, keep) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/room/${roomId}/pdf${keep ? '?keep=1' : ''}`);
      xhr.setRequestHeader('Content-Type', 'application/pdf');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(name));
      xhr.upload.onprogress = (e) => e.lengthComputable && toast(`Wysyłanie… ${Math.round(e.loaded / e.total * 100)}%`, 60000);
      xhr.onload = () => {
        if (xhr.status === 200) { toast('Wgrane'); resolve(); }
        else reject(Object.assign(new Error(xhr.responseText), { userMessage: 'Błąd: ' + xhr.responseText }));
      };
      xhr.onerror = () => reject(Object.assign(new Error('network'), { userMessage: 'Nie udało się wysłać pliku' }));
      xhr.send(blob);
    });
  }

  // Skleja pliki (PDF-y i zdjęcia) w jeden PDF, w kolejności wyboru.
  async function buildPdf(files) {
    if (!window.PDFLib) await loadScript('/vendor/pdf-lib/pdf-lib.min.js');
    const out = await PDFLib.PDFDocument.create();
    for (const f of files) {
      if (isPdfFile(f)) {
        const src = await PDFLib.PDFDocument.load(await f.arrayBuffer(), { ignoreEncryption: true });
        const copied = await out.copyPages(src, src.getPageIndices());
        copied.forEach((p) => out.addPage(p));
      } else {
        const img = await out.embedJpg(await imageToJpeg(f));
        const h = IMAGE_PAGE_WIDTH * img.height / img.width;
        out.addPage([IMAGE_PAGE_WIDTH, h]).drawImage(img, { x: 0, y: 0, width: IMAGE_PAGE_WIDTH, height: h });
      }
    }
    return new Blob([await out.save()], { type: 'application/pdf' });
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
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
      c.width = c.height = 0;
      return blob.arrayBuffer();
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
    const url = location.href;
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title: 'Tablica PDF', url }); return; } catch { /* anulowano */ }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Link skopiowany – wyślij go uczniowi');
    } catch {
      prompt('Skopiuj ten link i wyślij uczniowi:', url);
    }
  };

  // ---------- pobieranie PDF z notatkami ----------
  // Oryginalny PDF zostaje bez zmian (tekst nadal ostry), a notatki z każdej strony
  // są nakładane na nią jako przezroczysty obraz.
  const EXPORT_SCALE = 3; // piksele obrazu notatek na punkt PDF (~216 dpi)
  let exporting = false;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Nie udało się wczytać ' + src));
      document.head.appendChild(s);
    });
  }

  function inkPng(page, width, height) {
    const c = document.createElement('canvas');
    c.width = Math.round(width * EXPORT_SCALE);
    c.height = Math.round(height * EXPORT_SCALE);
    const ctx = c.getContext('2d');
    for (const s of byPage.get(page) || []) drawStroke(ctx, s, 0, c.width);
    return new Promise((resolve) => c.toBlob((blob) => {
      c.width = c.height = 0;
      blob.arrayBuffer().then(resolve);
    }, 'image/png'));
  }

  async function exportPdf() {
    if (exporting) return;
    if (!pdfDoc || !pdfInfo) { toast('Najpierw wgraj PDF'); return; }
    exporting = true;
    try {
      toast('Przygotowuję PDF…', 60000);
      if (!window.PDFLib) await loadScript('/vendor/pdf-lib/pdf-lib.min.js');
      const { PDFDocument, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = PDFLib;

      const bytes = await fetch(`/api/room/${roomId}/pdf?v=${pdfInfo.version}`).then((r) => r.arrayBuffer());
      const out = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const outPages = out.getPages();

      for (const p of pages) {
        const list = byPage.get(p.index) || [];
        if (!list.some((s) => s.tool === 'pen') || !outPages[p.index]) continue;
        toast(`Przygotowuję PDF… strona ${p.index + 1} z ${pages.length}`, 60000);

        // Widok pdf.js (z obrotem i przycięciem strony) -> układ współrzędnych PDF.
        const vp = p.pdfPage.getViewport({ scale: 1 });
        const png = await out.embedPng(await inkPng(p.index, vp.width, vp.height));
        const toView = [vp.width, 0, 0, -vp.height, 0, vp.height];       // obraz 1×1 -> widok
        const m = pdfjsLib.Util.transform(pdfjsLib.Util.inverseTransform(vp.transform), toView);

        const page = outPages[p.index];
        const name = page.node.newXObject('Notatki', png.ref);
        page.pushOperators(
          pushGraphicsState(),
          concatTransformationMatrix(...m),
          drawObject(name),
          popGraphicsState(),
        );
      }

      const blob = new Blob([await out.save()], { type: 'application/pdf' });
      const date = new Date().toISOString().slice(0, 10);
      const base = (boardTitle || pdfInfo.name || 'tablica').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '-');
      saveFile(blob, `${base} – notatki ${date}.pdf`);
      toast('PDF z notatkami gotowy');
    } catch (err) {
      console.error(err);
      toast('Nie udało się przygotować PDF-a');
    } finally {
      exporting = false;
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

  let toastTimer = null;
  function toast(msg, ms = 2200) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
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
    if (e.target.closest('#empty')) return;
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
    if (!pageEl) {
      if (isTouch) startTouch(e);
      return;
    }
    e.preventDefault();
    stopMomentum();
    const page = +pageEl.dataset.index;
    const eraser = tool === 'eraser' || (e.buttons & 32) !== 0;
    const stroke = {
      id: `${clientId}-${++strokeCounter}`,
      page,
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
    const rx = Math.round(x * 1e5) / 1e5, ry = Math.round(y * 1e5) / 1e5;
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
