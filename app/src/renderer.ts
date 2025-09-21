// Loaded via <script src="https://unpkg.com/simple-peer@9.11.1/simplepeer.min.js">
declare const SimplePeer: any

type PeerMap = Map<string, any>
const peers: PeerMap = new Map()
let ws: WebSocket | null = null
let selfId = ''
let joined = false

// Simple in-memory "files"
const FILES = new Map<string, Uint8Array>() // key/hash -> payload

// UI helpers
const chatLog = document.getElementById('chatLog') as HTMLTextAreaElement
const filesLog = document.getElementById('files') as HTMLTextAreaElement
function logChat(s: string) { chatLog.value += s + '\n'; chatLog.scrollTop = chatLog.scrollHeight }
function logFile(s: string) { filesLog.value += s + '\n'; filesLog.scrollTop = filesLog.scrollHeight }

function getIceServers() {
  const turn = (document.getElementById('turn') as HTMLInputElement)?.value?.trim()
  const user = (document.getElementById('turnUser') as HTMLInputElement)?.value?.trim() || 'user'
  const pass = (document.getElementById('turnPass') as HTMLInputElement)?.value?.trim() || 'pass'
  const servers: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302'] }]
  if (turn) servers.push({ urls: [turn], username: user, credential: pass })
  return servers
}

// ---------- signaling ----------
function connectToSignaling(url: string, room: string) {
  ws = new WebSocket(url)

  ws.onopen = () => {
    ws!.send(JSON.stringify({ type: 'join', room }))
  }

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)

    if (msg.type === 'peers') {
      selfId = msg.self
      ;(document.getElementById('self') as HTMLElement).innerText = selfId
      for (const pid of msg.peers) startPeer(pid, true) // initiate to existing peers
    } else if (msg.type === 'new-peer') {
      startPeer(msg.id, false) // wait/respond to the newcomer
    } else if (msg.type === 'signal') {
      let p = peers.get(msg.from)
      if (!p) {
        // If a signal arrived before we created a peer, become responder
        p = startPeer(msg.from, false)
      }
      p.signal(msg.data)
    } else if (msg.type === 'peer-left') {
      const p = peers.get(msg.id)
      if (p) { p.destroy(); peers.delete(msg.id) }
      logChat(`Peer left: ${msg.id}`)
    }
  }

  ws.onclose = () => logChat('Disconnected from signaling server.')
}

// ---------- WebRTC peers ----------
function startPeer(peerId: string, initiator: boolean) {
  if (peers.has(peerId)) return peers.get(peerId)

  const p = new SimplePeer({
    initiator,
    trickle: false, // simpler offer/answer flow for demos
    config: { iceServers: getIceServers() }
  })
  peers.set(peerId, p)

  p.on('signal', (data: any) => {
    ws?.send(JSON.stringify({ type: 'signal', target: peerId, data }))
  })
  p.on('connect', () => logChat(`Connected to ${peerId}`))
  p.on('close', () => { peers.delete(peerId); logChat(`Closed ${peerId}`) })
  p.on('error', (err: any) => logChat(`Peer error (${peerId}): ${err.message}`))

  p.on('data', (buf: Uint8Array) => {
    try {
      const msg = JSON.parse(new TextDecoder().decode(buf))
      if (msg.type === 'chat') logChat(`[${peerId}] ${msg.text}`)
      if (msg.type === 'file-announce') logFile(`Announced by ${peerId}: ${msg.hash}`)
      if (msg.type === 'file-req') {
        const data = FILES.get(msg.hash)
        if (data) {
          const out = JSON.stringify({ type: 'file-data', hash: msg.hash, data: Array.from(data) })
          p.send(new TextEncoder().encode(out))
        }
      }
      if (msg.type === 'file-data') {
        const u8 = new Uint8Array(msg.data)
        logFile(`Received ${msg.hash}: ${new TextDecoder().decode(u8)}`)
      }
    } catch {
      // ignore bad JSON
    }
  })

  return p
}

function broadcast(obj: any) {
  const data = new TextEncoder().encode(JSON.stringify(obj))
  for (const [, p] of peers) { try { p.send(data) } catch { /* ignore */ } }
}

// ---------- wire up UI ----------
window.addEventListener('DOMContentLoaded', () => {
  ;(document.getElementById('signalUrl') as HTMLInputElement).value = 'ws://YOUR_MAC_LAN_IP:8080'
  ;(document.getElementById('turn') as HTMLInputElement).value = 'turn:YOUR_MAC_LAN_IP:3478'
  ;(document.getElementById('turnUser') as HTMLInputElement).value = 'user'
  ;(document.getElementById('turnPass') as HTMLInputElement).value = 'pass'

  document.getElementById('join')!.addEventListener('click', () => {
    if (joined) { logChat('Already joined.'); return }
    const room = (document.getElementById('room') as HTMLInputElement).value.trim() || 'demo-room-1'
    const url  = (document.getElementById('signalUrl') as HTMLInputElement).value.trim()
    if (!url) { alert('Enter signaling server URL'); return }
    joined = true
    connectToSignaling(url, room)
    logChat(`Joining room: ${room}`)
  })

  document.getElementById('send')!.addEventListener('click', () => {
    const input = (document.getElementById('chatInput') as HTMLInputElement)
    const text = input.value.trim()
    if (!text) return
    broadcast({ type: 'chat', text })
    logChat(`[me] ${text}`)
    input.value = ''
  })

  document.getElementById('announce')!.addEventListener('click', () => {
    const input = (document.getElementById('fileHash') as HTMLInputElement)
    const hash = input.value.trim()
    if (!hash) return
    FILES.set(hash, new TextEncoder().encode(`Payload for ${hash} from ${selfId || 'desktop'}`))
    broadcast({ type: 'file-announce', hash })
    logFile(`Announced: ${hash}`)
    input.value = ''
  })

  document.getElementById('fetch')!.addEventListener('click', () => {
    const input = (document.getElementById('fetchHash') as HTMLInputElement)
    const hash = input.value.trim()
    if (!hash) return
    broadcast({ type: 'file-req', hash })
    logFile(`Requested: ${hash}`)
    input.value = ''
  })
})
