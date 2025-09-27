// server/server.cjs  (CommonJS)
// run: ADMIN_TOKEN=... node server/server.cjs
const { WebSocketServer } = require('ws');
const express = require('express');
const cors = require('cors');
const { nanoid } = require('nanoid');
const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT = process.env.PORT || 8080;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me-admin-token';

// ---- data dir
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const reportsPath   = path.join(dataDir, 'reports.json');
const bansPath      = path.join(dataDir, 'bans.json');
const repuPath      = path.join(dataDir, 'reputation.json');
const bannedHashTxt = path.join(dataDir, 'banned-hashes.txt');

function loadJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function saveJson(p, obj){ fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

let reports = loadJson(reportsPath, []);   // [{id, room, offenderId, reporterId, message, ts}]
let bans    = loadJson(bansPath, {});      // { [room]: { [peerId]: true } }
let repu    = loadJson(repuPath, {});      // { [thumb]: score }
if (!fs.existsSync(bannedHashTxt)) fs.writeFileSync(bannedHashTxt, '# sha256 hex per line\n');

// ---- Express API
const app = express();
app.use(cors());
app.use(express.json({ limit:'512kb' }));

app.get('/health', (_,res)=>res.json({ok:true}));

app.get('/banned-hashes', (_req,res) => {
  res.setHeader('Content-Type','text/plain; charset=utf-8');
  fs.createReadStream(bannedHashTxt).pipe(res);
});

app.post('/report', (req,res)=>{
  const { room, offenderId, reporterId, message, ts } = req.body || {};
  if (!room || !offenderId || !reporterId || !message) return res.status(400).json({ok:false, err:'missing fields'});
  const item = { id:nanoid(), room, offenderId, reporterId, message: String(message).slice(0,4000), ts: ts||Date.now() };
  reports.push(item);
  saveJson(reportsPath, reports);
  return res.json({ok:true, id:item.id});
});

app.get('/admin/reports', (req,res)=>{
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) return res.status(403).end();
  res.json(reports.slice(-500).reverse());
});

app.delete('/admin/reports/:id', (req,res)=>{
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) return res.status(403).end();
  reports = reports.filter(r => r.id !== req.params.id);
  saveJson(reportsPath, reports);
  res.json({ok:true});
});

app.post('/admin/ban', (req,res)=>{
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) return res.status(403).end();
  const { room, peerId } = req.body || {};
  if (!room || !peerId) return res.status(400).end();
  bans[room] = bans[room] || {};
  bans[room][peerId] = true;
  saveJson(bansPath, bans);
  res.json({ok:true});
});

app.post('/admin/unban', (req,res)=>{
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) return res.status(403).end();
  const { room, peerId } = req.body || {};
  if (!room || !peerId) return res.status(400).end();
  if (bans[room]) delete bans[room][peerId];
  saveJson(bansPath, bans);
  res.json({ok:true});
});

app.get('/admin/bans', (req,res)=>{
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) return res.status(403).end();
  res.json(bans);
});

// reputation
app.post('/endorse', (req,res)=>{
  const { targetThumb, delta = 1 } = req.body || {};
  if (!targetThumb) return res.status(400).end();
  const d = Math.max(-5, Math.min(5, Number(delta)));
  repu[targetThumb] = (repu[targetThumb] || 0) + d;
  saveJson(repuPath, repu);
  res.json({ok:true, score: repu[targetThumb]});
});
app.get('/reputation/:thumb', (req,res)=>{
  res.json({ ok:true, score: repu[req.params.thumb] || 0 });
});

// ---- WebSocket signaling
const rooms = new Map();    // room -> Map(peerId -> ws)
const peerMeta = new Map(); // peerId -> { room, thumb?:string }

function joinRoom(room, peerId, ws, thumb) {
  if (bans[room]?.[peerId]) { try { ws.close(); } catch {} return; }
  if (!rooms.has(room)) rooms.set(room, new Map());
  rooms.get(room).set(peerId, ws);
  peerMeta.set(peerId, { room, thumb });
}

function leave(peerId) {
  const meta = peerMeta.get(peerId);
  if (!meta) return;
  const { room } = meta;
  const m = rooms.get(room);
  if (m) m.delete(peerId);
  peerMeta.delete(peerId);
  if (m && m.size===0) rooms.delete(room);
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const id = nanoid(8);

  ws.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()) } catch { return; }
    if (msg.type === 'join') {
      const room = String(msg.room || '').toLowerCase().slice(0,64) || 'default';
      const thumb = typeof msg.thumb === 'string' ? msg.thumb.slice(0,128) : undefined;
      joinRoom(room, id, ws, thumb);

      const peers = Array.from(rooms.get(room).keys()).filter(p => p !== id);
      ws.send(JSON.stringify({ type:'peers', peers }));
      for (const pid of peers) {
        const pws = rooms.get(room).get(pid);
        pws && pws.send(JSON.stringify({ type:'new-peer', id }));
      }
    } else if (msg.type === 'signal' && typeof msg.target === 'string') {
      const meta = peerMeta.get(id);
      if (!meta) return;
      const m = rooms.get(meta.room);
      const t = m && m.get(msg.target);
      t && t.send(JSON.stringify({ type:'signal', from: id, data: msg.data }));
    }
  });

  ws.on('close', () => leave(id));
});

server.listen(PORT, () => {
  console.log(`Signaling/HTTP on http://0.0.0.0:${PORT}`);
});
