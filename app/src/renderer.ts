// app/src/renderer.ts
type AnyWS = WebSocket;

declare const SimplePeer: any; // from CDN
const enc = new TextEncoder();
const dec = new TextDecoder();

// UI refs
const statusDot = document.getElementById('statusDot') as HTMLElement;
const statusText = document.getElementById('statusText') as HTMLElement;
const cfg = document.getElementById('cfg') as HTMLElement;
const toggleCfg = document.getElementById('toggleCfg') as HTMLButtonElement;
const msgsEl = document.getElementById('msgs') as HTMLElement;
const input = document.getElementById('msg') as HTMLTextAreaElement;

const joinBtn = document.getElementById('joinBtn') as HTMLButtonElement;
const leaveBtn = document.getElementById('leaveBtn') as HTMLButtonElement;
const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;

const roomEl = document.getElementById('room') as HTMLInputElement;
const signalUrlEl = document.getElementById('signalUrl') as HTMLInputElement;
const turnEl = document.getElementById('turn') as HTMLInputElement;

let ws: AnyWS | null = null;
const peers = new Map<string, any>();
let joined = false;

function setStatus(connected: boolean) {
  statusDot.classList.toggle('on', !!connected);
  statusText.textContent = connected ? 'Connected' : 'Disconnected';
}

function pad(n: number) { return n < 10 ? '0' + n : '' + n }
function tsLabel(ts?: number) {
  const d = ts ? new Date(ts) : new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function bubble({ self, text, ts }: { self: boolean; text: string; ts?: number }) {
  const row = document.createElement('div');
  row.className = 'row ' + (self ? 'me' : 'them');
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = text;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = tsLabel(ts);

  if (self) {
    row.appendChild(b);
    row.appendChild(meta);
  } else {
    row.appendChild(meta);
    row.appendChild(b);
  }
  msgsEl.appendChild(row);
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

function iceServers(turnUrl: string) {
  const arr = [{ urls: ['stun:stun.l.google.com:19302'] }];
  if (turnUrl) arr.push({ urls: [turnUrl], username: 'demoUser', credential: 'demoPass_ChangeMe' });
  return arr;
}

function toU8(d: any): Uint8Array {
  if (d instanceof Uint8Array) return d;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (d && d.data instanceof ArrayBuffer) return new Uint8Array(d.data);
  if (typeof d === 'string') return enc.encode(d);
  try { return enc.encode(String(d)); } catch { return new Uint8Array(); }
}

function startPeer(peerId: string, initiator: boolean, turnUrl: string) {
  if (peers.has(peerId)) return peers.get(peerId);
  const p = new SimplePeer({
    initiator,
    trickle: false,
    config: { iceServers: iceServers(turnUrl) }
  });
  peers.set(peerId, p);

  p.on('signal', (data: any) => { ws?.send(JSON.stringify({ type: 'signal', target: peerId, data })); });
  p.on('connect', () => bubble({ self: false, text: `Connected to ${peerId}`, ts: Date.now() }));
  p.on('close', () => { peers.delete(peerId); bubble({ self: false, text: `Closed ${peerId}`, ts: Date.now() }); });
  p.on('error', (e: any) => bubble({ self: false, text: `Peer error: ${e.message}`, ts: Date.now() }));

  p.on('data', (data: any) => {
    const u8 = toU8(data);
    let text = '';
    try { text = dec.decode(u8); } catch { bubble({ self: false, text: `[binary ${u8.byteLength}B]`, ts: Date.now() }); return; }
    try {
      const obj = JSON.parse(text);
      if (obj && obj.type === 'chat') { bubble({ self: false, text: obj.text, ts: obj.ts }); return; }
    } catch { /* not JSON */ }
    bubble({ self: false, text, ts: Date.now() });
  });

  return p;
}

toggleCfg.addEventListener('click', () => { cfg.classList.toggle('hidden'); });

joinBtn.addEventListener('click', () => {
  if (joined) return;
  let room = (roomEl.value || 'demo-room-1').trim().toLowerCase();
  const url = (signalUrlEl.value || '').trim();
  const turn = (turnEl.value || '').trim();
  if (!url) { alert('Enter signaling URL'); return; }

  ws = new WebSocket(url);
  ws.onopen = () => { setStatus(true); ws!.send(JSON.stringify({ type: 'join', room })); cfg.classList.add('hidden'); };
  ws.onerror = () => { setStatus(false); };
  ws.onclose = () => { setStatus(false); joined = false; };

  ws.onmessage = (ev: MessageEvent) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.type === 'peers') {
      joined = true;
      for (const pid of msg.peers) startPeer(pid, true, turn);
    } else if (msg.type === 'new-peer') {
      startPeer(msg.id, false, turn);
    } else if (msg.type === 'signal') {
      const p = peers.get(msg.from) || startPeer(msg.from, false, turn);
      p.signal(msg.data);
    }
  };
});

leaveBtn.addEventListener('click', () => {
  try { ws?.close(); } catch {}
  for (const [, p] of peers) { try { p.destroy(); } catch {} }
  peers.clear();
  setStatus(false); joined = false;
  bubble({ self: false, text: 'You left the room', ts: Date.now() });
});

function sendCurrent() {
  const text = input.value.trim();
  if (!text) return;
  const payload = enc.encode(JSON.stringify({ type: 'chat', text, ts: Date.now() }));
  for (const [, p] of peers) { try { p.send(payload); } catch {} }
  bubble({ self: true, text, ts: Date.now() });
  input.value = '';
}
sendBtn.addEventListener('click', sendCurrent);
input.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(); }
});
