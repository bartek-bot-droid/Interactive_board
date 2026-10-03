// Tablica PDF – serwer: przechowuje PDF i kreski każdej tablicy, rozsyła zmiany na żywo.
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_PDF_MB = 150;
const ROOM_RE = /^[a-z0-9]{4,32}$/;

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/pdfjs', express.static(path.join(__dirname, 'node_modules/pdfjs-dist/build')));
app.use('/vendor/cmaps', express.static(path.join(__dirname, 'node_modules/pdfjs-dist/cmaps')));
app.use('/vendor/pdf-lib', express.static(path.join(__dirname, 'node_modules/pdf-lib/dist')));
app.use('/vendor/fonts',express.static(path.join(__dirname, 'node_modules/pdfjs-dist/standard_fonts')));

// ---------- stan tablic ----------
// room = { id, title, createdAt, updatedAt, pdf: {version, name} | null, strokes: [stroke], saveTimer }
// stroke = { id, page, tool: 'pen'|'eraser', color, size, pts: [x,y,x,y,...], done }
const rooms = new Map();

const pdfFile = (id) => path.join(DATA_DIR, id + '.pdf');
const jsonFile = (id) => path.join(DATA_DIR, id + '.json');

function getRoom(id) {
  let room = rooms.get(id);
  if (room) return room;
  room = { id, title: '', createdAt: Date.now(), updatedAt: 0, pdf: null, strokes: [], saveTimer: null };
  try {
    const saved = JSON.parse(fs.readFileSync(jsonFile(id), 'utf8'));
    if (saved.pdf && fs.existsSync(pdfFile(id))) room.pdf = saved.pdf;
    room.strokes = (saved.strokes || []).map((s) => ({ ...s, done: true }));
    room.title = saved.title || '';
    room.updatedAt = saved.updatedAt || fs.statSync(jsonFile(id)).mtimeMs;
    room.createdAt = saved.createdAt || room.updatedAt;
  } catch { /* nowa tablica */ }
  rooms.set(id, room);
  return room;
}

function writeRoom(room) {
  const data = JSON.stringify({
    title: room.title, createdAt: room.createdAt, updatedAt: room.updatedAt,
    pdf: room.pdf, strokes: room.strokes,
  });
  fs.writeFile(jsonFile(room.id), data, (err) => err && console.error('Zapis nieudany', err));
}

function scheduleSave(room) {
  if (room.deleted) return;
  room.updatedAt = Date.now();
  clearTimeout(room.saveTimer);
  room.saveTimer = setTimeout(() => writeRoom(room), 1500);
}

const roomState = (room) => ({ title: room.title, pdf: room.pdf, strokes: room.strokes });

const findStroke = (room, id) => room.strokes.find((s) => s.id === id);

// ---------- HTTP: PDF ----------
app.post('/api/room/:id/pdf', express.raw({ type: '*/*', limit: MAX_PDF_MB + 'mb' }), (req, res) => {
  const { id } = req.params;
  if (!ROOM_RE.test(id)) return res.status(400).send('Zły identyfikator tablicy');
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length < 5 || body.subarray(0, 5).toString() !== '%PDF-') {
    return res.status(400).send('To nie jest plik PDF');
  }
  const room = getRoom(id);
  fs.writeFile(pdfFile(id), body, (err) => {
    if (err) return res.status(500).send('Nie udało się zapisać pliku');
    const name = String(req.get('X-File-Name') || 'dokument.pdf').slice(0, 200);
    room.pdf = { version: Date.now(), name: decodeURIComponent(name) };
    // keep=1: nowe strony doklejone na końcu, więc dotychczasowe zapiski zostają na swoich stronach
    if (req.query.keep !== '1') room.strokes = [];
    scheduleSave(room);
    io.to(id).emit('state', roomState(room));
    res.json(room.pdf);
  });
});

// Strona wysyła tu zapytanie co kilka minut, żeby darmowy serwer nie usnął w trakcie lekcji.
app.get('/api/ping', (req, res) => res.sendStatus(204));

app.get('/api/room/:id/pdf', (req, res) => {
  const { id } = req.params;
  if (!ROOM_RE.test(id)) return res.sendStatus(400);
  const room = getRoom(id);
  if (!room.pdf) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=31536000, immutable'); // URL zawiera ?v=wersja
  res.sendFile(pdfFile(id));
});

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

admin.get('/boards', requireTeacher, (req, res) => {
  const ids = new Set(rooms.keys());
  for (const f of fs.readdirSync(DATA_DIR)) {
    const m = /^([a-z0-9]{4,32})\.json$/.exec(f);
    if (m) ids.add(m[1]);
  }
  const boards = [];
  for (const id of ids) {
    const room = getRoom(id);
    if (!room.title && !room.pdf && !room.strokes.length) continue; // ktoś tylko otworzył pusty link
    boards.push({
      id,
      title: room.title,
      pdfName: room.pdf ? room.pdf.name : '',
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
    const existing = getRoom(id);
    if (existing.title || existing.pdf || existing.strokes.length) return res.status(409).send('Tablica z tym kodem już istnieje');
  } else {
    do id = crypto.randomBytes(8).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
    while (id.length < 8 || fs.existsSync(jsonFile(id)) || rooms.has(id));
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
  for (const f of [jsonFile(id), pdfFile(id)]) fs.rmSync(f, { force: true });
  io.to(id).emit('state', { title: '', pdf: null, strokes: [] });
  res.sendStatus(204);
});

app.use('/api/admin', admin);

// ---------- WebSocket: kreski na żywo ----------
function broadcastPeers(roomId) {
  const peers = [];
  for (const sid of io.sockets.adapter.rooms.get(roomId) || []) {
    const s = io.sockets.sockets.get(sid);
    if (s) peers.push({ id: s.id, page: s.data.page || 0 });
  }
  io.to(roomId).emit('peers', peers);
}

io.on('connection', (socket) => {
  let room = null;

  // Tablica usunięta z listy, a ktoś ma ją jeszcze otwartą: pisze dalej na nowej, pustej tablicy.
  socket.use((packet, next) => {
    if (room && room.deleted) room = getRoom(room.id);
    next();
  });

  socket.on('join', (id) => {
    if (typeof id !== 'string' || !ROOM_RE.test(id)) return;
    if (room) socket.leave(room.id);
    room = getRoom(id);
    socket.join(id);
    socket.emit('state', roomState(room));
    broadcastPeers(id);
  });

  socket.on('stroke:begin', (s) => {
    if (!room || !s || typeof s.id !== 'string' || findStroke(room, s.id)) return;
    const stroke = {
      id: s.id.slice(0, 40),
      page: s.page | 0,
      tool: s.tool === 'eraser' ? 'eraser' : 'pen',
      color: String(s.color || '#000').slice(0, 20),
      size: Number(s.size) || 0.003,
      pts: Array.isArray(s.pts) ? s.pts.map(Number) : [],
      done: false,
    };
    room.strokes.push(stroke);
    socket.to(room.id).emit('stroke:begin', stroke);
  });

  socket.on('stroke:add', ({ id, pts } = {}) => {
    const stroke = room && findStroke(room, id);
    if (!stroke || !Array.isArray(pts)) return;
    for (const v of pts) stroke.pts.push(Number(v));
    socket.to(room.id).emit('stroke:add', { id, pts });
  });

  socket.on('stroke:end', (id) => {
    const stroke = room && findStroke(room, id);
    if (!stroke) return;
    stroke.done = true;
    scheduleSave(room);
  });

  socket.on('stroke:remove', (id) => {
    if (!room) return;
    const i = room.strokes.findIndex((s) => s.id === id);
    if (i < 0) return;
    room.strokes.splice(i, 1);
    socket.to(room.id).emit('stroke:remove', id);
    scheduleSave(room);
  });

  socket.on('page:clear', (page) => {
    if (!room) return;
    room.strokes = room.strokes.filter((s) => s.page !== page);
    socket.to(room.id).emit('page:clear', page);
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
