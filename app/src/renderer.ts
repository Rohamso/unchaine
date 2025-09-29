// --- helpers: base64url <-> string
function b64urlEncode(str: string): string {
  const b64 = btoa(str);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,'');
}
function b64urlDecode(b64url: string): string {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  return atob(b64 + pad);
}

// --- helpers: create/parse invite payload
function makeInvitePayload({ room }: { room: string }): string {
  const payload = {
    v: 1,
    room: (room || '').trim().toLowerCase(),
    n: Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b=>b.toString(16).padStart(2,'0')).join(''),
    ts: Date.now()
  };
  return b64urlEncode(JSON.stringify(payload));
}

function parseInviteFromUrl(urlOrHash: string): any {
  try {
    // supports "#invite=...." or "unchaine://join#...."
    if (urlOrHash.includes('invite=')) {
      const h = new URL(urlOrHash, location.origin).hash || urlOrHash;
      const m = h.match(/invite=([^&]+)/);
      if (!m) return null;
      return JSON.parse(b64urlDecode(m[1]));
    } else if (urlOrHash.includes('#')) {
      const frag = urlOrHash.split('#')[1];
      return JSON.parse(b64urlDecode(frag));
    }
  } catch (e) {
    console.warn('Bad invite payload', e);
  }
  return null;
}

function renderIncomingMessage({ text, fromPeerId, ts }: { text: string, fromPeerId?: string, ts?: number }) {
  const row = document.createElement('div');
  row.className = 'row them';

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = new Date(ts || Date.now()).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;

  const more = document.createElement('button');
  more.textContent = '⋯';
  (more as any).style = 'border:none;background:transparent;color:#889;cursor:pointer;font-size:16px;';
  more.title = 'More';
  more.onclick = (ev) => {
    ev.stopPropagation();
    showMessageMenu(more, { text, offenderId: fromPeerId || 'unknown', ts });
  };

  row.append(meta, bubble, more);
  document.getElementById('msgs')!.appendChild(row);
}

// --- message menu helpers
let openMenu: HTMLElement | null;
function closeAnyMenu() {
  if (openMenu) { openMenu.classList.remove('open'); openMenu.remove(); openMenu = null; }
}
document.addEventListener('click', (e) => {
  if (openMenu && !openMenu.contains(e.target as Node)) closeAnyMenu();
});
function showMessageMenu(anchorBtn: HTMLElement, { text, offenderId, ts }: { text: string, offenderId?: string, ts?: number }) {
  closeAnyMenu();
  const menu = document.createElement('div');
  menu.className = 'msg-menu';
  const btn = document.createElement('button');
  btn.textContent = 'Report';
  btn.onclick = async () => {
    closeAnyMenu();
    if (!confirm('Report this message?')) return;
    await reportMessage({ text, offenderId, ts });
    alert('Thanks—reported.');
  };
  menu.appendChild(btn);
  document.body.appendChild(menu);
  const r = anchorBtn.getBoundingClientRect();
  menu.style.left = `${window.scrollX + r.left - 10}px`;
  menu.style.top  = `${window.scrollY + r.bottom + 6}px`;
  menu.classList.add('open');
  openMenu = menu;
}
(window as any).showMessageMenu = showMessageMenu;
(window as any).closeAnyMenu = closeAnyMenu;
// --- moderation helpers
let bannedHashes = new Set<string>();
const SIGNAL_BASE = 'https://signal.unchaine.com'; // or http://127.0.0.1:8080 for local tests
let myPeerId: string | null = null; // set if you expose it

async function fetchBannedHashes(){
  try {
    const res = await fetch(`${SIGNAL_BASE}/banned-hashes`, { cache: 'no-store' });
    const txt = await res.text();
    bannedHashes = new Set(
      txt.split(/\r?\n/).map(s=>s.trim()).filter(Boolean).filter(l=>!l.startsWith('#'))
    );
    console.log('Banned hashes loaded', bannedHashes.size);
  } catch(e){ console.warn('banned-hashes fetch failed', e); }
}

async function sha256Hex(str: string): Promise<string> {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

async function reportMessage(payload: { text: string; offenderId?: string; ts?: number }){
  const room = (document.getElementById('room') as HTMLInputElement)?.value?.trim().toLowerCase() || 'default';
  const reporterId = myPeerId || ('app-'+Math.random().toString(36).slice(2));
  const body = JSON.stringify({
    room,
    reporterId,
    offenderId: payload.offenderId || 'unknown',
    message: payload.text,
    ts: payload.ts || Date.now(),
  });
  try {
    const r = await fetch(`${SIGNAL_BASE}/report`, { method:'POST', headers:{'Content-Type':'application/json'}, body });
    const j = await r.json();
    alert(j.ok ? 'Reported. Thank you.' : 'Report failed.');
  } catch { alert('Report failed (network).'); }
}

window.addEventListener('load', fetchBannedHashes);
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
function bubble({ self, text, ts, fromPeerId }: { self: boolean; text: string; ts?: number; fromPeerId?: string }) {
  if (self) {
    const row = document.createElement('div');
    row.className = 'row me';
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = text;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = tsLabel(ts);
    row.appendChild(b);
    row.appendChild(meta);
    msgsEl.appendChild(row);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  } else {
    renderIncomingMessage(text, fromPeerId, ts);
  }
}
  // --- message menu helpers
  let openMenu: HTMLElement | null;
  function closeAnyMenu() {
    if (openMenu) { openMenu.classList.remove('open'); openMenu.remove(); openMenu = null; }
  }
  document.addEventListener('click', (e) => {
    if (openMenu && !openMenu.contains(e.target as Node)) closeAnyMenu();
  });
  function showMessageMenu(anchorBtn: HTMLElement, { text, offenderId, ts }: { text: string, offenderId?: string, ts?: number }) {
    closeAnyMenu();
    const menu = document.createElement('div');
    menu.className = 'msg-menu';
    const btn = document.createElement('button');
    btn.textContent = 'Report';
    btn.onclick = async () => {
      closeAnyMenu();
      if (!confirm('Report this message?')) return;
      await reportMessage({ text, offenderId, ts });
      alert('Thanks—reported.');
    };
    menu.appendChild(btn);
    document.body.appendChild(menu);
    const r = anchorBtn.getBoundingClientRect();
    menu.style.left = `${window.scrollX + r.left - 10}px`;
    menu.style.top  = `${window.scrollY + r.bottom + 6}px`;
    menu.classList.add('open');
    openMenu = menu;
  }
  (window as any).showMessageMenu = showMessageMenu;

function renderIncomingMessage(text: string, fromPeerId?: string, ts?: number) {
  const row = document.createElement('div');
  row.className = 'row them';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = new Date(ts || Date.now()).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  const more = document.createElement('button');
  more.textContent = '⋯';
  (more as any).style = 'border:none;background:transparent;color:#889;cursor:pointer;font-size:16px;';
  more.title = 'Report message';
  more.onclick = ()=> reportMessage({ text, offenderId: fromPeerId, ts });
  row.append(meta, bubble, more);
  (document.getElementById('msgs') as HTMLElement).appendChild(row);
  msgsEl.scrollTop = msgsEl.scrollHeight;
    more.onclick = (ev) => {
      ev.stopPropagation();
      (window as any).showMessageMenu(more, { text, offenderId: fromPeerId || 'unknown', ts });
    };
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
      if (obj && obj.type === 'chat') { bubble({ self: false, text: obj.text, ts: obj.ts, fromPeerId: 'unknown' }); return; }
    } catch { /* not JSON */ }
    bubble({ self: false, text, ts: Date.now(), fromPeerId: 'unknown' });
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

async function sendCurrent() {
  const text = (input.value || '').trim();
  if (!text) return;
  const h = await sha256Hex(text);
  if (bannedHashes.has(h)) { alert('This content is blocked by policy.'); return; }
  const payload = enc.encode(JSON.stringify({ type: 'chat', text, ts: Date.now() }));
  for (const [, p] of peers) { try { p.send(payload); } catch {} }
  bubble({ self: true, text, ts: Date.now() });
  input.value = '';
}
(sendBtn as HTMLButtonElement).onclick = () => { void sendCurrent(); };
input.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendCurrent(); }
});

function bindInviteUI() {
  const roomEl = document.getElementById('room') as HTMLInputElement;
  const createBtn = document.getElementById('createInviteBtn') as HTMLButtonElement;
  const inviteLinkEl = document.getElementById('inviteLink') as HTMLInputElement;
  const copyBtn = document.getElementById('copyInviteBtn') as HTMLButtonElement;
  const pasteEl = document.getElementById('pasteInvite') as HTMLInputElement | null;
  const useBtn = document.getElementById('useInviteBtn') as HTMLButtonElement | null;

  // --- Invite popover helpers ---
  let invitePopover: HTMLDivElement | null = null;
  function closeInvitePopover() {
    if (invitePopover) { invitePopover.remove(); invitePopover = null; }
  }

  createBtn.onclick = () => {
    const room = (roomEl.value || '').trim();
    if (!room) { alert('Enter a room name first'); return; }
    const token = makeInvitePayload({ room });
    const webLink = `https://unchaine.pages.dev/#invite=${token}`;
    const appLink = `unchaine://join#${token}`;
    const expiresIn = 30 * 60 * 1000; // 30 min in ms
    const expiryText = 'Link expires in 30 min.';
    closeInvitePopover();
    invitePopover = document.createElement('div');
    invitePopover.style.position = 'absolute';
    invitePopover.style.zIndex = '9999';
    invitePopover.style.background = '#fff';
    invitePopover.style.border = '1px solid #e5e7eb';
    invitePopover.style.borderRadius = '10px';
    invitePopover.style.boxShadow = '0 10px 30px rgba(0,0,0,.08)';
    invitePopover.style.padding = '16px';
    invitePopover.style.minWidth = '320px';
    invitePopover.style.top = (createBtn.getBoundingClientRect().bottom + window.scrollY + 8) + 'px';
    invitePopover.style.left = (createBtn.getBoundingClientRect().left + window.scrollX) + 'px';
    invitePopover.innerHTML = `
      <div style="font-weight:600;margin-bottom:8px;">Share this invite</div>
      <div style="margin-bottom:8px;word-break:break-all;">
        <span style="font-size:13px;color:#888;">Web link:</span><br>
        <input type='text' value='${webLink}' readonly style='width:100%;margin-bottom:6px;'>
        <span style="font-size:13px;color:#888;">App link:</span><br>
        <input type='text' value='${appLink}' readonly style='width:100%;'>
      </div>
      <div style="margin-bottom:8px;color:#666;font-size:13px;">${expiryText}</div>
      <div style="display:flex;gap:8px;">
        <button id="shareInviteBtn">Share</button>
        <button id="copyWebInviteBtn">Copy Web Link</button>
        <button id="copyAppInviteBtn">Copy App Link</button>
        <button id="closeInvitePopoverBtn">Close</button>
      </div>
    `;
    document.body.appendChild(invitePopover);
    // Share button (uses Web Share API if available)
    const shareBtn = invitePopover.querySelector('#shareInviteBtn') as HTMLButtonElement;
    shareBtn.onclick = async () => {
      if (navigator.share) {
        try {
          await navigator.share({ title: 'Join my chat', text: 'Join my chat room:', url: webLink });
        } catch {}
      } else {
        alert('Web Share not supported. Copy the link instead.');
      }
    };
    // Copy buttons
    (invitePopover.querySelector('#copyWebInviteBtn') as HTMLButtonElement).onclick = async () => {
      try { await navigator.clipboard.writeText(webLink); alert('Copied'); } catch { alert('Copy failed'); }
    };
    (invitePopover.querySelector('#copyAppInviteBtn') as HTMLButtonElement).onclick = async () => {
      try { await navigator.clipboard.writeText(appLink); alert('Copied'); } catch { alert('Copy failed'); }
    };
    (invitePopover.querySelector('#closeInvitePopoverBtn') as HTMLButtonElement).onclick = closeInvitePopover;
    // Dismiss on outside click
    setTimeout(() => {
      document.addEventListener('mousedown', outsideClick, { once: true });
      function outsideClick(e: MouseEvent) {
        if (invitePopover && !invitePopover.contains(e.target as Node)) closeInvitePopover();
      }
    }, 0);
  };

  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(inviteLinkEl.value);
      alert('Copied');
    } catch { alert('Copy failed'); }
  };

  if (useBtn && pasteEl) {
    useBtn.onclick = () => {
      const raw = (pasteEl.value || '').trim();
      if (!raw) return;
      const payload = parseInviteFromUrl(raw) || (() => {
        // allow pasting just the token
        try { return JSON.parse(b64urlDecode(raw)); } catch { return null; }
      })();
      if (payload && payload.room) {
        roomEl.value = payload.room;
        // call your existing join handler
        if (typeof (window as any).join === 'function') (window as any).join();
      } else {
        alert('Invalid invite');
      }
    };
  }

  // Auto-handle if Electron opened with an URL-like arg (future: custom protocol)
  // For now, we also parse location.hash if you load a webview-like wrapper.
  const p = parseInviteFromUrl(location.href);
  if (p?.room) {
    roomEl.value = p.room;
    if (typeof (window as any).join === 'function') (window as any).join();
  }
}

window.addEventListener('DOMContentLoaded', bindInviteUI);
