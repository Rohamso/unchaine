// server/server.js  (simple WebSocket signaling & room presence)
import { WebSocketServer } from 'ws'
import { randomUUID } from 'crypto'

const wss = new WebSocketServer({ port: 8080 })
const rooms = new Map() // room -> Map(peerId -> ws)

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)) } catch {}
}

wss.on('connection', (ws) => {
  const id = randomUUID().slice(0,8)
  let room = null
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    if (msg.type === 'join' && msg.room) {
      room = msg.room
      if (!rooms.has(room)) rooms.set(room, new Map())
      const peers = rooms.get(room)
      peers.set(id, ws)
      // tell the newcomer who is here
      send(ws, { type: 'peers', self: id, peers: [...peers.keys()].filter(p => p !== id) })
      // tell others a new peer arrived
      for (const [pid, pw] of peers.entries()) {
        if (pid !== id) send(pw, { type: 'new-peer', id })
      }
    } else if (msg.type === 'signal' && msg.target && msg.data && room) {
      const peers = rooms.get(room)
      const target = peers?.get(msg.target)
      if (target) send(target, { type: 'signal', from: id, data: msg.data })
    }
  })
  ws.on('close', () => {
    if (!room) return
    const peers = rooms.get(room)
    if (!peers) return
    peers.delete(id)
    for (const [pid, pw] of peers.entries()) {
      send(pw, { type: 'peer-left', id })
    }
    if (peers.size === 0) rooms.delete(room)
  })
})

console.log('Signaling server on ws://0.0.0.0:8080')

