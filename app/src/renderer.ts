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

// ---- Base64url helpers
function b64urlEncodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i=0;i<bytes.length;i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function b64urlDecodeToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g,'+').replace(/_/g,'/'); 
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlEncodeJSON(obj: any): string { return b64urlEncodeBytes(new TextEncoder().encode(JSON.stringify(obj))); }
function b64urlDecodeJSON(b64: string): any { return JSON.parse(new TextDecoder().decode(b64urlDecodeToBytes(b64))); }

// --- helpers: create/parse invite payload
type InvitePayload = {
  v: number;
  room: string;
  nonce: string;
  exp: number;
  ts: number;
  inviterPub: JsonWebKey;
  sig: string;
};

type InviteToken = { token: string; payload: InvitePayload };

type PendingInviteRecord = {
  room: string;
  exp: number;
  privJwk: JsonWebKey;
  privKey?: CryptoKey | null;
};

type ActiveInviteState = {
  payload: InvitePayload;
  used: boolean;
  handshakePeerId?: string;
};

const INVITE_TTL_MS = 30 * 60 * 1000;
const PENDING_INVITES_STORE_KEY = 'unch_pending_invites_v1';
const USED_INVITES_STORE_KEY = 'unch_used_invites_v1';
const CONSUMED_INVITES_STORE_KEY = 'unch_consumed_invites_v1';

const pendingInvites = new Map<string, PendingInviteRecord>();
const usedInviteNonces = new Set<string>();
const consumedInviteNonces = new Set<string>();
let activeInvite: ActiveInviteState | null = null;

loadPendingInvitesFromStorage();
cleanupExpiredPendingInvites();
loadUsedInviteNonces();
loadConsumedInviteNonces();

async function makeInvitePayload({ room }: { room: string }): Promise<InviteToken> {
  const cleanRoom = (room || '').trim().toLowerCase();
  const nonce = randNonceHex(16);
  const exp = Date.now() + INVITE_TTL_MS;
  const ts = Date.now();

  const keyPair = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const privJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey) as JsonWebKey;
  const pubJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const minimalPub: JsonWebKey = {
    kty: pubJwk.kty,
    crv: pubJwk.crv,
    x: pubJwk.x,
    y: pubJwk.y
  };

  pendingInvites.set(nonce, { room: cleanRoom, exp, privJwk, privKey: keyPair.privateKey });
  persistPendingInvites();

  const payloadFields: Pick<InvitePayload, 'room' | 'nonce' | 'exp' | 'ts' | 'inviterPub'> = {
    room: cleanRoom,
    nonce,
    exp,
    ts,
    inviterPub: minimalPub
  };

  const sigBytes = await crypto.subtle.sign(SIG, keyPair.privateKey, inviteSignatureBytes(payloadFields));
  const signature = b64urlEncodeBytes(new Uint8Array(sigBytes));

  const payload: InvitePayload = {
    v: 2,
    ...payloadFields,
    sig: signature
  };

  return { token: b64urlEncode(JSON.stringify(payload)), payload };
}

function parseInviteFromUrl(urlOrHash: string): InvitePayload | null {
  try {
    // supports "#invite=...." or "unchaine://join#...."
    if (urlOrHash.includes('invite=')) {
      const h = new URL(urlOrHash, location.origin).hash || urlOrHash;
      const m = h.match(/invite=([^&]+)/);
      if (!m) return null;
      return decodeInviteToken(m[1]);
    } else if (urlOrHash.includes('#')) {
      const frag = urlOrHash.split('#')[1];
      return decodeInviteToken(frag);
    }
  } catch (e) {
    console.warn('Bad invite payload', e);
  }
  return null;
}

function decodeInviteToken(token: string): InvitePayload | null {
  try {
    const raw = b64urlDecode(token.trim());
    return parseInviteJson(raw);
  } catch (err) {
    console.warn('Unable to decode invite token', err);
    return null;
  }
}

function parseInviteJson(json: string): InvitePayload | null {
  try {
    const data = JSON.parse(json);
    if (!data || typeof data !== 'object') return null;
    if (data.v !== 2) return null;
    if (!data.room || !data.nonce || !data.exp || !data.inviterPub || !data.sig) return null;
    return {
      v: 2,
      room: String(data.room || '').trim().toLowerCase(),
      nonce: String(data.nonce),
      exp: Number(data.exp),
      ts: Number(data.ts || 0),
      inviterPub: {
        kty: data.inviterPub.kty,
        crv: data.inviterPub.crv,
        x: data.inviterPub.x,
        y: data.inviterPub.y
      },
      sig: String(data.sig || '').trim()
    };
  } catch (err) {
    console.warn('Invalid invite JSON', err);
    return null;
  }
}

function inviteSignatureBytes(payload: Pick<InvitePayload, 'room' | 'nonce' | 'exp' | 'ts' | 'inviterPub'>): Uint8Array {
  const canonical = JSON.stringify({
    room: payload.room,
    nonce: payload.nonce,
    exp: payload.exp,
    ts: payload.ts,
    inviterPub: {
      kty: payload.inviterPub.kty,
      crv: payload.inviterPub.crv,
      x: payload.inviterPub.x,
      y: payload.inviterPub.y
    }
  });
  return new TextEncoder().encode(canonical);
}

async function verifyInviteTokenSignature(payload: InvitePayload): Promise<boolean> {
  if (!payload.sig) return false;
  try {
    const pubKey = await crypto.subtle.importKey('jwk', payload.inviterPub, ALG, true, ['verify']);
    const sig = b64urlDecodeToBytes(payload.sig);
    return await crypto.subtle.verify(SIG, pubKey, sig, inviteSignatureBytes(payload));
  } catch (err) {
    console.warn('Invite signature verification failed', err);
    return false;
  }
}

function loadPendingInvitesFromStorage() {
  try {
    const raw = localStorage.getItem(PENDING_INVITES_STORE_KEY);
    if (!raw) return;
    const list = JSON.parse(raw) as Array<{ nonce: string; room: string; exp: number; privJwk: JsonWebKey }>;
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (!entry || !entry.nonce) continue;
      pendingInvites.set(entry.nonce, { room: entry.room, exp: entry.exp, privJwk: entry.privJwk, privKey: null });
    }
  } catch (err) {
    console.warn('Failed to load pending invites', err);
  }
}

function persistPendingInvites() {
  try {
    const list = Array.from(pendingInvites.entries()).map(([nonce, rec]) => ({
      nonce,
      room: rec.room,
      exp: rec.exp,
      privJwk: rec.privJwk
    }));
    localStorage.setItem(PENDING_INVITES_STORE_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn('Failed to persist pending invites', err);
  }
}

function cleanupExpiredPendingInvites() {
  const now = Date.now();
  let changed = false;
  for (const [nonce, rec] of pendingInvites.entries()) {
    if (rec.exp && rec.exp < now) {
      pendingInvites.delete(nonce);
      changed = true;
    }
  }
  if (changed) persistPendingInvites();
}

function loadUsedInviteNonces() {
  try {
    const raw = localStorage.getItem(USED_INVITES_STORE_KEY);
    if (!raw) return;
    const list = JSON.parse(raw) as string[];
    if (!Array.isArray(list)) return;
    for (const nonce of list) {
      if (typeof nonce === 'string') usedInviteNonces.add(nonce);
    }
  } catch (err) {
    console.warn('Failed to load used invites', err);
  }
}

function persistUsedInviteNonces() {
  try {
    localStorage.setItem(USED_INVITES_STORE_KEY, JSON.stringify(Array.from(usedInviteNonces.values())));
  } catch (err) {
    console.warn('Failed to persist used invites', err);
  }
}

function loadConsumedInviteNonces() {
  try {
    const raw = localStorage.getItem(CONSUMED_INVITES_STORE_KEY);
    if (!raw) return;
    const list = JSON.parse(raw) as string[];
    if (!Array.isArray(list)) return;
    for (const nonce of list) {
      if (typeof nonce === 'string') consumedInviteNonces.add(nonce);
    }
  } catch (err) {
    console.warn('Failed to load consumed invites', err);
  }
}

function persistConsumedInviteNonces() {
  try {
    localStorage.setItem(CONSUMED_INVITES_STORE_KEY, JSON.stringify(Array.from(consumedInviteNonces.values())));
  } catch (err) {
    console.warn('Failed to persist consumed invites', err);
  }
}

function markInviteNonceUsed(nonce: string) {
  usedInviteNonces.add(nonce);
  persistUsedInviteNonces();
}

function isInviteNonceUsed(nonce: string): boolean {
  return usedInviteNonces.has(nonce);
}

function markInviteNonceConsumed(nonce: string) {
  consumedInviteNonces.add(nonce);
  persistConsumedInviteNonces();
}

function isInviteNonceConsumed(nonce: string): boolean {
  return consumedInviteNonces.has(nonce);
}

async function resolvePendingInvite(nonce: string): Promise<PendingInviteRecord | null> {
  const record = pendingInvites.get(nonce);
  if (!record) return null;
  if (!record.privKey) {
    try {
      record.privKey = await crypto.subtle.importKey('jwk', record.privJwk, ALG, true, ['sign']);
    } catch (err) {
      console.warn('Failed to import invite key', err);
      return null;
    }
  }
  return record;
}

function removePendingInvite(nonce: string) {
  if (pendingInvites.delete(nonce)) persistPendingInvites();
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

interface PeerState {
  handshakeComplete: boolean;
  handshakeRequested?: boolean;
  handshakeNonce?: string;
}

const peerStates = new Map<string, PeerState>();

function ensurePeerState(peerId: string): PeerState {
  let state = peerStates.get(peerId);
  if (!state) {
    state = { handshakeComplete: !(activeInvite && !activeInvite.used) };
    peerStates.set(peerId, state);
  }
  return state;
}

function clearPeerState(peerId: string) {
  peerStates.delete(peerId);
}

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
  const state = ensurePeerState(peerId);

  p.on('signal', (data: any) => { ws?.send(JSON.stringify({ type: 'signal', target: peerId, data })); });
  p.on('connect', () => {
    bubble({ self: false, text: `Connected to ${peerId}`, ts: Date.now() });
    void sendHandshakeRequest(p, peerId);
    if (!(activeInvite && !activeInvite.used)) state.handshakeComplete = true;
  });
  p.on('close', () => {
    peers.delete(peerId);
    clearPeerState(peerId);
    bubble({ self: false, text: `Closed ${peerId}`, ts: Date.now() });
  });
  p.on('error', (e: any) => bubble({ self: false, text: `Peer error: ${e.message}`, ts: Date.now() }));

  p.on('data', (data: any) => {
    const u8 = toU8(data);
    let text = '';
    try { text = dec.decode(u8); } catch { bubble({ self: false, text: `[binary ${u8.byteLength}B]`, ts: Date.now() }); return; }
    let obj: any = null;
    try { obj = JSON.parse(text); } catch { obj = null; }
    if (obj && obj.type === 'invite-handshake') { void processInviteHandshakeMessage(peerId, p, obj); return; }
    if (obj && obj.type === 'chat') {
      const peerState = ensurePeerState(peerId);
      if (activeInvite && !activeInvite.used && !peerState.handshakeComplete) {
        console.warn('Ignoring chat before invite verification from', peerId);
        return;
      }
      bubble({ self: false, text: obj.text, ts: obj.ts, fromPeerId: 'unknown' });
      return;
    }
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
  peerStates.clear();
  setStatus(false); joined = false;
  bubble({ self: false, text: 'You left the room', ts: Date.now() });
});

async function sendCurrent() {
  const text = (input.value || '').trim();
  if (!text) return;
  if (activeInvite && !activeInvite.used) {
    alert('Waiting for invite verification before sending messages.');
    return;
  }
  const h = await sha256Hex(text);
  if (bannedHashes.has(h)) { alert('This content is blocked by policy.'); return; }
  const payload = enc.encode(JSON.stringify({ type: 'chat', text, ts: Date.now() }));
  for (const [peerId, p] of peers) {
    const state = ensurePeerState(peerId);
    if (activeInvite && !state.handshakeComplete) continue;
    try { p.send(payload); } catch {}
  }
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

  async function applyInvite(payload: InvitePayload, opts: { autoJoin?: boolean } = {}) {
    const hasValidSignature = await verifyInviteTokenSignature(payload);
    if (!hasValidSignature) {
      alert('Invalid invite signature.');
      return false;
    }
    if (Date.now() > payload.exp) {
      alert('This invite has expired.');
      return false;
    }
    if (isInviteNonceConsumed(payload.nonce)) {
      alert('This invite has already been used.');
      return false;
    }
    if (isInviteNonceUsed(payload.nonce)) {
      alert('This invite has already been used on this device.');
      return false;
    }
    const token = b64urlEncode(JSON.stringify(payload));
    inviteLinkEl.value = token;
    roomEl.value = payload.room;
    activeInvite = { payload, used: false };
    if (opts.autoJoin && typeof (window as any).join === 'function') (window as any).join();
    return true;
  }

  createBtn.onclick = async () => {
    const room = (roomEl.value || '').trim();
    if (!room) { alert('Enter a room name first'); return; }
    try {
      const tokenInfo = await makeInvitePayload({ room });
      inviteLinkEl.value = tokenInfo.token;
      const webLink = `https://unchaine.pages.dev/#invite=${tokenInfo.token}`;
      const appLink = `unchaine://join#${tokenInfo.token}`;
      const expiryText = `Link expires at ${new Date(tokenInfo.payload.exp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
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
    } catch (err) {
      console.error('Failed to create invite', err);
      alert('Failed to create invite.');
    }
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
      const payload = parseInviteFromUrl(raw) || decodeInviteToken(raw);
      if (!payload) {
        alert('Invalid invite');
        return;
      }
      void applyInvite(payload, { autoJoin: true });
    };
  }

  // Auto-handle if Electron opened with an URL-like arg (future: custom protocol)
  // For now, we also parse location.hash if you load a webview-like wrapper.
  const p = parseInviteFromUrl(location.href);
  if (p) void applyInvite(p, { autoJoin: true });
}

// ---- Keys (ECDSA P-256)
const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIG = { name: 'ECDSA', hash: 'SHA-256' };

async function verifyInviteSignature(pubJwk: any, bytes: Uint8Array, sigB64: string): Promise<boolean> {
  const pubKey = await crypto.subtle.importKey('jwk', pubJwk, ALG, true, ['verify']);
  const sig = b64urlDecodeToBytes(sigB64);
  return await crypto.subtle.verify(SIG, pubKey, sig, bytes);
}

function handshakeToBytes(room: string, nonce: string, ts: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ room, nonce, ts }));
}

function sendJson(peer: any, obj: unknown) {
  try {
    peer.send(JSON.stringify(obj));
  } catch (err) {
    console.warn('Failed to send message', err);
  }
}

async function sendHandshakeRequest(peer: any, peerId: string) {
  if (!activeInvite || activeInvite.used) return;
  const state = ensurePeerState(peerId);
  if (state.handshakeRequested) return;
  state.handshakeRequested = true;
  state.handshakeNonce = activeInvite.payload.nonce;
  const msg = {
    type: 'invite-handshake',
    phase: 'request',
    room: activeInvite.payload.room,
    nonce: activeInvite.payload.nonce,
    exp: activeInvite.payload.exp,
    ts: Date.now()
  };
  sendJson(peer, msg);
}

async function processInviteHandshakeMessage(peerId: string, peer: any, msg: any) {
  if (!msg || msg.type !== 'invite-handshake') return;
  if (msg.phase === 'request') {
    const nonce = String(msg.nonce || '');
    const room = String(msg.room || '').trim().toLowerCase();
    const record = await resolvePendingInvite(nonce);
    if (!record) {
      if (isInviteNonceConsumed(nonce)) {
        sendJson(peer, { type: 'invite-handshake', phase: 'reject', nonce, reason: 'already-used' });
      }
      return;
    }
    if (room !== record.room) {
      sendJson(peer, { type: 'invite-handshake', phase: 'reject', nonce, reason: 'room-mismatch' });
      return;
    }
    if (Date.now() > record.exp) {
      removePendingInvite(nonce);
      sendJson(peer, { type: 'invite-handshake', phase: 'reject', nonce, reason: 'expired', exp: record.exp });
      return;
    }
    if (!record.privKey) {
      console.warn('Invite record missing key for nonce', nonce);
      sendJson(peer, { type: 'invite-handshake', phase: 'reject', nonce, reason: 'missing-key' });
      return;
    }
    const ts = Date.now();
    const sigBytes = await crypto.subtle.sign(SIG, record.privKey, handshakeToBytes(record.room, nonce, ts));
    const signature = b64urlEncodeBytes(new Uint8Array(sigBytes));
    markInviteNonceConsumed(nonce);
    removePendingInvite(nonce);
    const state = ensurePeerState(peerId);
    state.handshakeComplete = true;
    sendJson(peer, { type: 'invite-handshake', phase: 'response', room, nonce, ts, signature, exp: record.exp });
    return;
  }

  if (msg.phase === 'response') {
    if (!activeInvite || activeInvite.used) return;
    const nonce = String(msg.nonce || '');
    if (activeInvite.payload.nonce !== nonce) return;
    const ts = Number(msg.ts || 0);
    if (!Number.isFinite(ts)) return;
    if (Date.now() > activeInvite.payload.exp) {
      alert('Invite expired before verification.');
      activeInvite.used = true;
      markInviteNonceUsed(nonce);
      return;
    }
    if (ts > activeInvite.payload.exp) {
      alert('Inviter response timestamp is after expiry.');
      return;
    }
    const valid = await verifyInviteSignature(activeInvite.payload.inviterPub, handshakeToBytes(msg.room, nonce, ts), String(msg.signature || ''));
    if (!valid) {
      alert('Invite signature failed verification.');
      return;
    }
    activeInvite.used = true;
    activeInvite.handshakePeerId = peerId;
    markInviteNonceUsed(nonce);
    const state = ensurePeerState(peerId);
    state.handshakeComplete = true;
    bubble({ self: false, text: 'Invite verified. Secure channel ready.', ts: Date.now() });
    return;
  }

  if (msg.phase === 'reject') {
    const reason = String(msg.reason || '');
    const nonce = String(msg.nonce || '');
    if (activeInvite && activeInvite.payload.nonce === nonce) {
      if (reason === 'expired') {
        alert('Invite expired. Request a new one.');
        activeInvite = null;
      } else if (reason === 'already-used') {
        alert('This invite has already been used.');
        markInviteNonceUsed(nonce);
        activeInvite = null;
      } else if (reason === 'room-mismatch') {
        alert('Invite does not match this room.');
        activeInvite = null;
      }
    }
    console.warn('Invite handshake rejected', reason);
  }
}

// Utility
function randNonceHex(n=16): string { // 16 bytes -> 32 hex chars
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return Array.from(a).map(b=>b.toString(16).padStart(2,'0')).join('');
}

window.addEventListener('DOMContentLoaded', bindInviteUI);
