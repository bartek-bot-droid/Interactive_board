// Tablica PDF – serwer: przechowuje strony, pliki (PDF-y, zdjęcia) i kreski każdej tablicy, rozsyła zmiany na żywo.
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const { Server } = require('socket.io');
const { PDFDocument } = require('pdf-lib');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_PDF_MB = 150;
const MAX_IMAGE_MB = 25;
const MAX_PAGES = 3000;
const ROOM_RE = /^[a-z0-9]{4,32}$/;
const ID_RE = /^[a-z0-9]{6,24}$/;

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
// perMessageDeflate: stan tablicy z wieloma kreskami idzie przez wolne łącze (Funnel) kilka razy mniejszy.
const io = new Server(server, { maxHttpBufferSize: 5e6, perMessageDeflate: { threshold: 2048 } });

// Kompresja programu (JS/CSS/HTML/JSON) – PDF-y i zdjęcia są już skompresowane, więc je pomija.
app.use(compression());
app.use(express.static(path.join(__dirname, 'public')));
// Biblioteki mają stałą wersję, więc przeglądarka może je trzymać w pamięci przez tydzień.
const vendor = (dir) => express.static(path.join(__dirname, 'node_modules', dir), { maxAge: '7d' });
app.use('/vendor/pdfjs', vendor('pdfjs-dist/build'));
app.use('/vendor/cmaps', vendor('pdfjs-dist/cmaps'));
app.use('/vendor/pdf-lib', vendor('pdf-lib/dist'));
app.use('/vendor/fonts', vendor('pdfjs-dist/standard_fonts'));

// ---------- stan tablic ----------
// room = { id, title, name, createdAt, updatedAt, pages, assets, strokes, saveTimer }
// page = { id, t: 'pdf', a: assetId, n: nr strony w pliku, w, h }   (w, h – rozmiar w punktach PDF)
//      | { id, t: 'blank', w, h }
//      | { id, t: 'img', a: assetId, w, h }
// asset = { type: 'pdf' | 'jpg', name, pages (pdf), size, created }
// stroke = { id, page: page.id, tool: 'pen'|'eraser', color, size, pts: [x,y,x,y,...], done }
// Wstawienie/usunięcie strony to tylko zmiana listy `pages` – pliki i kreski zostają, jak są.
const rooms = new Map();

const jsonFile = (id) => path.join(DATA_DIR, id + '.json');
const legacyPdfFile = (id) => path.join(DATA_DIR, id + '.pdf'); // PDF tablic sprzed listy stron (plik „main”)
const assetDir = (id) => path.join(DATA_DIR, 'assets', id);
const assetFile = (id, a, type) =>
  (a === 'main' ? legacyPdfFile(id) : path.join(assetDir(id), a + (type === 'pdf' ? '.pdf' : '.jpg')));
const newId = (len = 10) => {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(len), (b) => abc[b % abc.length]).join('');
};

function getRoom(id) {
  let room = rooms.get(id);
  if (room) return room;
  room = {
    id, title: '', name: '', createdAt: Date.now(), updatedAt: 0,
    pages: [], assets: {}, strokes: [], strokeIndex: new Map(), saveTimer: null,
  };
  try {
    const saved = JSON.parse(fs.readFileSync(jsonFile(id), 'utf8'));
    room.title = saved.title || '';
    room.updatedAt = saved.updatedAt || fs.statSync(jsonFile(id)).mtimeMs;
    room.createdAt = saved.createdAt || room.updatedAt;
    room.strokes = (saved.strokes || []).map((s) => ({ ...s, done: true }));
    if (Array.isArray(saved.pages)) {
      room.pages = saved.pages;
      room.assets = saved.assets || {};
      room.name = saved.name || '';
    } else if (saved.pdf && fs.existsSync(legacyPdfFile(id))) {
      room.pages = null; // stara tablica: listę stron zbuduje migrate() przy pierwszym otwarciu
      room.legacyPdf = saved.pdf;
      room.name = saved.pdf.name || '';
    }
  } catch { /* nowa tablica */ }
  for (const s of room.strokes) room.strokeIndex.set(s.id, s);
  rooms.set(id, room);
  return room;
}

// Rozmiary stron PDF-a (w punktach, z obrotem) – potrzebne, żeby od razu ułożyć strony na ekranie.
async function pdfPageSizes(file) {
  const buf = await fs.promises.readFile(file);
  try {
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    return doc.getPages().map((p) => {
      const box = p.getCropBox();
      const rot = ((p.getRotation().angle % 360) + 360) % 360;
      return rot === 90 || rot === 270 ? { w: box.height, h: box.width } : { w: box.width, h: box.height };
    });
  } catch (err) {
    // Nietypowy PDF: policz strony „na oko”, rozmiar A4 – przeglądarka i tak poprawi proporcje.
    console.error('Nie udało się odczytać stron PDF-a', file, err.message);
    const count = (buf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) || []).length || 1;
    return Array.from({ length: count }, () => ({ w: 595, h: 842 }));
  }
}

// Stara tablica (jeden PDF, kreski z numerami stron) -> lista stron; kreski dostają id swojej strony.
const migrations = new Map();
function migrate(room) {
  if (room.pages) return Promise.resolve();
  if (!migrations.has(room.id)) {
    migrations.set(room.id, (async () => {
      const sizes = await pdfPageSizes(legacyPdfFile(room.id));
      const pages = sizes.map(({ w, h }, n) => ({ id: newId(), t: 'pdf', a: 'main', n, w, h }));
      room.assets = { main: { type: 'pdf', name: room.legacyPdf.name || 'dokument.pdf', pages: pages.length, created: 0 } };
      room.strokes = room.strokes.filter((s) => pages[s.page]);
      for (const s of room.strokes) s.page = pages[s.page].id;
      room.pages = pages;
      delete room.legacyPdf;
      writeRoom(room);
    })().finally(() => migrations.delete(room.id)));
  }
  return migrations.get(room.id);
}

function roomJson(room) {
  const data = { title: room.title, createdAt: room.createdAt, updatedAt: room.updatedAt, strokes: room.strokes };
  if (room.pages) Object.assign(data, { name: room.name, pages: room.pages, assets: room.assets });
  else data.pdf = room.legacyPdf; // jeszcze nie przeniesiona – zapisz w starym formacie
  return JSON.stringify(data);
}

function writeRoom(room) {
  if (room.deleted) return;
  fs.writeFile(jsonFile(room.id), roomJson(room), (err) => err && console.error('Zapis nieudany', err));
}

function scheduleSave(room) {
  if (room.deleted) return;
  room.updatedAt = Date.now();
  clearTimeout(room.saveTimer);
  room.saveTimer = setTimeout(() => { room.saveTimer = null; writeRoom(room); }, 1500);
}

// „Uruchom ponownie” / restart NAS-a wysyła SIGTERM: zapisz zaległe zmiany i zakończ się czysto
// (bez tego Docker po 10 s zabija proces, a Synology pokazuje „nieoczekiwane zatrzymanie”).
function shutdown() {
  for (const room of rooms.values()) {
    if (!room.saveTimer || room.deleted) continue;
    clearTimeout(room.saveTimer);
    try { fs.writeFileSync(jsonFile(room.id), roomJson(room)); } catch (err) { console.error('Zapis nieudany', err); }
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const roomState = (room) => ({ title: room.title, name: room.name, pages: room.pages || [], strokes: room.strokes });

// Usuwa pliki, do których nie prowadzi już żadna strona. Świeże (< 10 min) zostają, bo ktoś mógł je
// właśnie wgrać i za chwilę wstawić.
function cleanAssets(room) {
  const used = new Set(room.pages.map((p) => p.a).filter(Boolean));
  for (const [a, meta] of Object.entries(room.assets)) {
    if (used.has(a) || Date.now() - (meta.created || 0) < 10 * 6e4) continue;
    fs.rm(assetFile(room.id, a, meta.type), { force: true }, () => {});
    delete room.assets[a];
  }
}

// ---------- HTTP: pliki stron ----------
// Wgranie pliku (PDF albo zdjęcie JPEG). Strony z niego dodaje potem klient przez „pages:insert”.
app.post('/api/room/:id/asset', express.raw({ type: '*/*', limit: MAX_PDF_MB + 'mb' }), async (req, res) => {
  const { id } = req.params;
  if (!ROOM_RE.test(id)) return res.status(400).send('Zły identyfikator tablicy');
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length < 5) return res.status(400).send('Pusty plik');
  let type;
  if (body.subarray(0, 5).toString() === '%PDF-') type = 'pdf';
  else if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) type = 'jpg';
  else return res.status(400).send('Obsługiwane są pliki PDF i zdjęcia');
  if (type === 'jpg' && body.length > MAX_IMAGE_MB * 1048576) return res.status(413).send('Zdjęcie jest za duże');

  const room = getRoom(id);
  await migrate(room).catch(() => {});
  const a = newId(12);
  try {
    await fs.promises.mkdir(assetDir(id), { recursive: true });
    await fs.promises.writeFile(assetFile(id, a, type), body);
  } catch {
    return res.status(500).send('Nie udało się zapisać pliku');
  }
  const pages = Number.parseInt(req.get('X-Pages'), 10);
  room.assets[a] = {
    type,
    name: decodeURIComponent(String(req.get('X-File-Name') || '')).slice(0, 200),
    pages: type === 'pdf' && pages > 0 ? Math.min(pages, MAX_PAGES) : undefined,
    size: body.length,
    created: Date.now(),
  };
  scheduleSave(room);
  res.json({ id: a });
});

app.get('/api/room/:id/asset/:a', async (req, res) => {
  const { id, a } = req.params;
  if (!ROOM_RE.test(id) || !(a === 'main' || ID_RE.test(a))) return res.sendStatus(400);
  const room = getRoom(id);
  const meta = room.assets[a] || (a === 'main' && room.legacyPdf ? { type: 'pdf' } : null);
  if (!meta) return res.sendStatus(404);
  // Zawartość pliku o danym id nigdy się nie zmienia, więc przeglądarka może go pamiętać na zawsze.
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type(meta.type === 'pdf' ? 'application/pdf' : 'image/jpeg');
  res.sendFile(assetFile(id, a, meta.type), (err) => err && !res.headersSent && res.sendStatus(404));
});

// Strona wysyła tu zapytanie co kilka minut (podtrzymanie połączenia przez Funnel).
app.get('/api/ping', (req, res) => res.sendStatus(204));

// ---------- lista tablic (tylko dla nauczyciela, chroniona PIN-em) ----------
// PIN (skrót scrypt) i sesje trzyma plik _config.json – podkreślnik nie pasuje do ROOM_RE,
// więc nie da się go pomylić z tablicą.
const CONFIG_FILE = path.join(DATA_DIR, '_config.json');
const SESSION_DAYS = 180;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

let config = { pin: null, sessions: {} }; // pin = {salt, hash}; sessions = {sha256(token): wygasa}
try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch { /* brak PIN-u */ }
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config));

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashPin = (pin, salt) => crypto.scryptSync(pin, salt, 32).toString('hex');
const validPin = (pin) => typeof pin === 'string' && /^\d{4,8}$/.test(pin);

function pinMatches(pin) {
  const a = Buffer.from(hashPin(pin, config.pin.salt), 'hex');
  return crypto.timingSafeEqual(a, Buffer.from(config.pin.hash, 'hex'));
}

function setPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  config.pin = { salt, hash: hashPin(pin, salt) };
}

function newSession() {
  const now = Date.now();
  for (const [k, exp] of Object.entries(config.sessions)) if (exp < now) delete config.sessions[k];
  const token = crypto.randomBytes(32).toString('hex');
  config.sessions[sha256(token)] = now + SESSION_DAYS * 864e5;
  saveConfig();
  return token;
}

// Wszystkie zapytania przychodzą przez Tailscale z 127.0.0.1, więc blokada prób jest wspólna:
// po 5 błędnych PIN-ach logowanie jest wstrzymane na 15 min (zalogowane urządzenia działają dalej).
let failedLogins = [];
function loginLockedFor() {
  const since = Date.now() - LOCK_MINUTES * 6e4;
  failedLogins = failedLogins.filter((t) => t > since);
  if (failedLogins.length < MAX_FAILS) return 0;
  return Math.ceil((failedLogins[0] + LOCK_MINUTES * 6e4 - Date.now()) / 6e4);
}

function requireTeacher(req, res, next) {
  const token = req.get('X-Teacher-Token') || '';
  const exp = config.sessions[sha256(token)];
  if (token && exp && exp > Date.now()) return next();
  res.status(401).send('Zaloguj się PIN-em');
}

const admin = express.Router();
admin.use(express.json());

admin.get('/status', (req, res) => res.json({ pinSet: !!config.pin }));

// Adres internetowy tablicy (np. Tailscale). Gdy nauczyciel otworzy tablicę przez szybki adres w sieci
// domowej, przycisk „Link” i tak da uczniowi ten adres. Zapamiętuje go urządzenie zalogowane PIN-em.
admin.get('/public-url', (req, res) => res.json({ url: process.env.PUBLIC_URL || config.publicUrl || null }));
admin.post('/public-url', requireTeacher, (req, res) => {
  const url = String(req.body.url || '');
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(url)) return res.sendStatus(400);
  if (config.publicUrl !== url) { config.publicUrl = url; saveConfig(); }
  res.sendStatus(204);
});

admin.post('/setup', (req, res) => {
  if (config.pin) return res.status(409).send('PIN jest już ustawiony');
  if (!validPin(req.body.pin)) return res.status(400).send('PIN musi mieć od 4 do 8 cyfr');
  setPin(req.body.pin);
  res.json({ token: newSession() });
});

admin.post('/login', (req, res) => {
  if (!config.pin) return res.status(409).send('Najpierw ustaw PIN');
  const wait = loginLockedFor();
  if (wait) return res.status(429).send(`Za dużo błędnych prób. Spróbuj za ${wait} min.`);
  if (!validPin(req.body.pin) || !pinMatches(req.body.pin)) {
    failedLogins.push(Date.now());
    return res.status(403).send('Zły PIN');
  }
  res.json({ token: newSession() });
});

admin.post('/logout', requireTeacher, (req, res) => {
  delete config.sessions[sha256(req.get('X-Teacher-Token'))];
  saveConfig();
  res.sendStatus(204);
});

admin.post('/pin', requireTeacher, (req, res) => {
  if (!validPin(req.body.oldPin) || !pinMatches(req.body.oldPin)) return res.status(403).send('Obecny PIN jest nieprawidłowy');
  if (!validPin(req.body.newPin)) return res.status(400).send('Nowy PIN musi mieć od 4 do 8 cyfr');
  setPin(req.body.newPin);
  config.sessions = {}; // wyloguj wszystkie inne urządzenia
  res.json({ token: newSession() });
});

const isEmptyRoom = (room) => !room.title && !room.legacyPdf && !(room.pages && room.pages.length) && !room.strokes.length;

admin.get('/boards', requireTeacher, (req, res) => {
  const ids = new Set(rooms.keys());
  for (const f of fs.readdirSync(DATA_DIR)) {
    const m = /^([a-z0-9]{4,32})\.json$/.exec(f);
    if (m) ids.add(m[1]);
  }
  const boards = [];
  for (const id of ids) {
    const room = getRoom(id);
    if (isEmptyRoom(room)) continue; // ktoś tylko otworzył pusty link
    boards.push({
      id,
      title: room.title,
      pdfName: room.name,
      pageCount: room.pages ? room.pages.length : null,
      notes: room.strokes.filter((s) => s.tool === 'pen').length,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt || room.createdAt,
      online: (io.sockets.adapter.rooms.get(id) || new Set()).size,
    });
  }
  boards.sort((a, b) => b.updatedAt - a.updatedAt);
  res.json(boards);
});

const cleanTitle = (t) => String(t || '').trim().slice(0, 80);

admin.post('/boards', requireTeacher, (req, res) => {
  let id = String(req.body.code || '').toLowerCase();
  if (id) {
    if (!ROOM_RE.test(id)) return res.status(400).send('Kod: tylko małe litery i cyfry, od 4 do 32 znaków');
    if (!isEmptyRoom(getRoom(id))) return res.status(409).send('Tablica z tym kodem już istnieje');
  } else {
    do id = newId(10);
    while (fs.existsSync(jsonFile(id)) || rooms.has(id));
  }
  const room = getRoom(id);
  room.title = cleanTitle(req.body.title) || 'Nowa tablica';
  room.createdAt = room.updatedAt = Date.now();
  writeRoom(room);
  res.json({ id });
});

admin.patch('/boards/:id', requireTeacher, (req, res) => {
  const { id } = req.params;
  if (!ROOM_RE.test(id)) return res.sendStatus(400);
  const room = getRoom(id);
  room.title = cleanTitle(req.body.title);
  clearTimeout(room.saveTimer);
  writeRoom(room); // bez zmiany daty ostatniej pracy
  io.to(id).emit('title', room.title);
  res.sendStatus(204);
});

admin.delete('/boards/:id', requireTeacher, (req, res) => {
  const { id } = req.params;
  if (!ROOM_RE.test(id)) return res.sendStatus(400);
  const room = rooms.get(id);
  if (room) { clearTimeout(room.saveTimer); room.deleted = true; }
  rooms.delete(id);
  for (const f of [jsonFile(id), legacyPdfFile(id)]) fs.rmSync(f, { force: true });
  fs.rmSync(assetDir(id), { recursive: true, force: true });
  io.to(id).emit('state', { title: '', name: '', pages: [], strokes: [] });
  res.sendStatus(204);
});

app.use('/api/admin', admin);

// ---------- WebSocket: strony i kreski na żywo ----------
function broadcastPeers(roomId) {
  const peers = [];
  for (const sid of io.sockets.adapter.rooms.get(roomId) || []) {
    const s = io.sockets.sockets.get(sid);
    if (s) peers.push({ id: s.id, page: s.data.page || 0 });
  }
  io.to(roomId).emit('peers', peers);
}

// Sprawdza strony przysłane przez klienta; zwraca poprawioną listę albo komunikat błędu.
function checkPages(room, list) {
  if (!Array.isArray(list) || !list.length) return 'Brak stron';
  if (room.pages.length + list.length > MAX_PAGES) return `Tablica może mieć najwyżej ${MAX_PAGES} stron`;
  const taken = new Set(room.pages.map((p) => p.id));
  const size = (v) => Math.min(20000, Math.max(10, Number(v) || 0));
  const out = [];
  for (const p of list) {
    if (!p || typeof p.id !== 'string' || !ID_RE.test(p.id) || taken.has(p.id)) return 'Zły identyfikator strony';
    taken.add(p.id);
    const page = { id: p.id, t: p.t, w: size(p.w), h: size(p.h) };
    const asset = room.assets[p.a];
    if (p.t === 'blank') { /* tylko rozmiar */ } else if (p.t === 'img') {
      if (!asset || asset.type !== 'jpg') return 'Brak pliku zdjęcia';
      page.a = p.a;
    } else if (p.t === 'pdf') {
      const n = Number(p.n);
      if (!asset || asset.type !== 'pdf' || !Number.isInteger(n) || n < 0 || (asset.pages && n >= asset.pages)) {
        return 'Brak strony PDF-a';
      }
      Object.assign(page, { a: p.a, n });
    } else return 'Nieznany rodzaj strony';
    out.push(page);
  }
  return out;
}

const reply = (ack, data) => typeof ack === 'function' && ack(data);

io.on('connection', (socket) => {
  let room = null;

  // Tablica usunięta z listy, a ktoś ma ją jeszcze otwartą: pisze dalej na nowej, pustej tablicy.
  socket.use((packet, next) => {
    if (room && room.deleted) room = getRoom(room.id);
    next();
  });

  const sendPages = (reset = false) =>
    io.to(room.id).emit('pages', { pages: room.pages, name: room.name, reset });

  socket.on('join', async (id) => {
    if (typeof id !== 'string' || !ROOM_RE.test(id)) return;
    if (room) socket.leave(room.id);
    room = getRoom(id);
    socket.join(id);
    try { await migrate(room); } catch (err) { console.error('Migracja nieudana', id, err); room.pages = room.pages || []; }
    socket.emit('state', roomState(room));
    broadcastPeers(id);
  });

  // Wstawienie stron przed pozycją `at` (at = liczba stron: na końcu).
  socket.on('pages:insert', ({ at, pages, name } = {}, ack) => {
    if (!room || !room.pages) return reply(ack, { error: 'Tablica jeszcze się wczytuje' });
    const list = checkPages(room, pages);
    if (typeof list === 'string') return reply(ack, { error: list });
    const i = Math.min(Math.max(Number.parseInt(at, 10) || 0, 0), room.pages.length);
    room.pages.splice(i, 0, ...list);
    if (!room.name && name) room.name = String(name).slice(0, 200);
    scheduleSave(room);
    sendPages();
    reply(ack, { ok: true });
  });

  socket.on('pages:delete', (pageId, ack) => {
    if (!room || !room.pages) return reply(ack, { error: 'Tablica jeszcze się wczytuje' });
    const i = room.pages.findIndex((p) => p.id === pageId);
    if (i < 0) return reply(ack, { ok: true }); // już usunięta
    room.pages.splice(i, 1);
    room.strokes = room.strokes.filter((s) => s.page !== pageId);
    room.strokeIndex = new Map(room.strokes.map((s) => [s.id, s]));
    cleanAssets(room);
    scheduleSave(room);
    sendPages();
    reply(ack, { ok: true });
  });

  // Nowy dokument zamiast całej tablicy: nowe strony, bez starych zapisków.
  socket.on('pages:replace', ({ pages, name } = {}, ack) => {
    if (!room || !room.pages) return reply(ack, { error: 'Tablica jeszcze się wczytuje' });
    const old = room.pages;
    room.pages = [];
    const list = checkPages(room, pages);
    if (typeof list === 'string') { room.pages = old; return reply(ack, { error: list }); }
    room.pages = list;
    room.name = String(name || '').slice(0, 200);
    room.strokes = [];
    room.strokeIndex = new Map();
    cleanAssets(room);
    scheduleSave(room);
    io.to(room.id).emit('state', { ...roomState(room), reset: true });
    reply(ack, { ok: true });
  });

  socket.on('stroke:begin', (s) => {
    if (!room || !s || typeof s.id !== 'string' || room.strokeIndex.has(s.id)) return;
    const stroke = {
      id: s.id.slice(0, 40),
      page: String(s.page).slice(0, 40),
      tool: s.tool === 'eraser' ? 'eraser' : 'pen',
      color: String(s.color || '#000').slice(0, 20),
      size: Number(s.size) || 0.003,
      pts: Array.isArray(s.pts) ? s.pts.map(Number) : [],
      done: false,
    };
    room.strokes.push(stroke);
    room.strokeIndex.set(stroke.id, stroke);
    socket.to(room.id).emit('stroke:begin', stroke);
  });

  socket.on('stroke:add', ({ id, pts } = {}) => {
    const stroke = room && room.strokeIndex.get(id);
    if (!stroke || !Array.isArray(pts)) return;
    for (const v of pts) stroke.pts.push(Number(v));
    socket.to(room.id).emit('stroke:add', { id, pts });
  });

  socket.on('stroke:end', (id) => {
    const stroke = room && room.strokeIndex.get(id);
    if (!stroke) return;
    stroke.done = true;
    scheduleSave(room);
  });

  socket.on('stroke:remove', (id) => {
    if (!room || !room.strokeIndex.has(id)) return;
    room.strokes.splice(room.strokes.indexOf(room.strokeIndex.get(id)), 1);
    room.strokeIndex.delete(id);
    socket.to(room.id).emit('stroke:remove', id);
    scheduleSave(room);
  });

  socket.on('page:clear', (pageId) => {
    if (!room) return;
    room.strokes = room.strokes.filter((s) => s.page !== pageId);
    room.strokeIndex = new Map(room.strokes.map((s) => [s.id, s]));
    socket.to(room.id).emit('page:clear', pageId);
    scheduleSave(room);
  });

  socket.on('view', (page) => {
    socket.data.page = page | 0;
    if (room) broadcastPeers(room.id);
  });

  socket.on('disconnect', () => {
    if (room) broadcastPeers(room.id);
  });
});

server.listen(PORT, () => {
  console.log(`Tablica PDF działa: http://localhost:${PORT}`);
});
