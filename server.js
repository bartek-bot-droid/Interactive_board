// Tablica PDF – serwer: przechowuje PDF i kreski każdej tablicy, rozsyła zmiany na żywo.
const path = require('path');
const fs = require('fs');
const http = require('http');
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
// room = { id, pdf: {version, name} | null, strokes: [stroke], saveTimer }
// stroke = { id, page, tool: 'pen'|'eraser', color, size, pts: [x,y,x,y,...], done }
const rooms = new Map();

const pdfFile = (id) => path.join(DATA_DIR, id + '.pdf');
const jsonFile = (id) => path.join(DATA_DIR, id + '.json');

function getRoom(id) {
  let room = rooms.get(id);
  if (room) return room;
  room = { id, pdf: null, strokes: [], saveTimer: null };
  try {
    const saved = JSON.parse(fs.readFileSync(jsonFile(id), 'utf8'));
    if (saved.pdf && fs.existsSync(pdfFile(id))) room.pdf = saved.pdf;
    room.strokes = (saved.strokes || []).map((s) => ({ ...s, done: true }));
  } catch { /* nowa tablica */ }
  rooms.set(id, room);
  return room;
}

function scheduleSave(room) {
  clearTimeout(room.saveTimer);
  room.saveTimer = setTimeout(() => {
    const data = JSON.stringify({ pdf: room.pdf, strokes: room.strokes });
    fs.writeFile(jsonFile(room.id), data, (err) => err && console.error('Zapis nieudany', err));
  }, 1500);
}

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
    room.strokes = [];
    scheduleSave(room);
    io.to(id).emit('state', { pdf: room.pdf, strokes: [] });
    res.json(room.pdf);
  });
});

app.get('/api/room/:id/pdf', (req, res) => {
  const { id } = req.params;
  if (!ROOM_RE.test(id)) return res.sendStatus(400);
  const room = getRoom(id);
  if (!room.pdf) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=31536000, immutable'); // URL zawiera ?v=wersja
  res.sendFile(pdfFile(id));
});

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

  socket.on('join', (id) => {
    if (typeof id !== 'string' || !ROOM_RE.test(id)) return;
    if (room) socket.leave(room.id);
    room = getRoom(id);
    socket.join(id);
    socket.emit('state', { pdf: room.pdf, strokes: room.strokes });
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
