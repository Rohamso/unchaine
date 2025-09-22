import { WebSocketServer } from 'ws'
import { randomUUID } from 'crypto'

const wss = new WebSocketServer({ port: 8080 })
const rooms = new Map() // room -> Map(peerId -> ws)

function send(ws, obj) { try { ws.send(JSON.stringify(obj)) } catch {} }

wss.on('connection', (ws, req) => {
  const id = randomUUID().slice(0,8)
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  console.log('[conn]', id, 'from', ip)

  // heartbeat
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })

  let room = null

  ws.on('message', (raw) => {
    // Log raw & parsed to catch whitespace issues
    const txt = raw.toString()
    console.log(`[msg] ${id} bytes=${raw.length} text=${txt}`)
    let msg; try { msg = JSON.parse(txt) } catch (e) {
      console.log('[warn] bad JSON from', id, e.message); return
    }

    if (msg.type === 'join' && typeof msg.room === 'string') {
      const original = msg.room
      const normalized = original.trim().toLowerCase()
      console.log(`[join-req] ${id} roomRaw="${original}" len=${original.length} -> norm="${normalized}"`)
      room = normalized

      if (!rooms.has(room)) rooms.set(room, new Map())
      const peers = rooms.get(room)
      peers.set(id, ws)

      // tell the joiner who is here
      const others = [...peers.keys()].filter(p => p !== id)
      send(ws, { type: 'peers', self: id, peers: others })

      // notify others
      for (const [pid, pw] of peers.entries()) if (pid !== id) send(pw, { type: 'new-peer', id })

      console.log('[join]', id, '-> room', room, 'peers:', peers.size)

    } else if (msg.type === 'signal' && msg.target && msg.data && room) {
      const peers = rooms.get(room)
      const target = peers?.get(msg.target)
      if (target) {
        send(target, { type: 'signal', from: id, data: msg.data })
      } else {
        console.log('[signal-miss] no target', msg.target, 'in room', room)
      }
    } else {
      console.log('[info] unhandled message from', id, msg)
    }
  })

  ws.on('close', () => {
    if (!room) return
    const peers = rooms.get(room); if (!peers) return
    peers.delete(id)
    console.log('[leave]', id, 'room', room, 'remaining:', peers.size)
    for (const [pid, pw] of peers.entries()) send(pw, { type: 'peer-left', id })
    if (peers.size === 0) rooms.delete(room)
  })
})

// ping clients every 25s (avoid idle timeouts)
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate()
    ws.isAlive = false
    try { ws.ping() } catch {}
  })
}, 25000)

console.log('Signaling server on ws://0.0.0.0:8080')
