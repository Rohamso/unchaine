(() => {
  // app/src/renderer.ts
  var peers = /* @__PURE__ */ new Map();
  var ws = null;
  var selfId = "";
  var joined = false;
  var FILES = /* @__PURE__ */ new Map();
  var chatLog = document.getElementById("chatLog");
  var filesLog = document.getElementById("files");
  function logChat(s) {
    chatLog.value += s + "\n";
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  function logFile(s) {
    filesLog.value += s + "\n";
    filesLog.scrollTop = filesLog.scrollHeight;
  }
  function getIceServers() {
    const turn = document.getElementById("turn")?.value?.trim();
    const user = document.getElementById("turnUser")?.value?.trim() || "user";
    const pass = document.getElementById("turnPass")?.value?.trim() || "pass";
    const servers = [{ urls: ["stun:stun.l.google.com:19302"] }];
    if (turn) servers.push({ urls: [turn], username: user, credential: pass });
    return servers;
  }
  function connectToSignaling(url, room) {
    ws = new WebSocket(url);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "join", room }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "peers") {
        selfId = msg.self;
        document.getElementById("self").innerText = selfId;
        for (const pid of msg.peers) startPeer(pid, true);
      } else if (msg.type === "new-peer") {
        startPeer(msg.id, false);
      } else if (msg.type === "signal") {
        let p = peers.get(msg.from);
        if (!p) {
          p = startPeer(msg.from, false);
        }
        p.signal(msg.data);
      } else if (msg.type === "peer-left") {
        const p = peers.get(msg.id);
        if (p) {
          p.destroy();
          peers.delete(msg.id);
        }
        logChat(`Peer left: ${msg.id}`);
      }
    };
    ws.onclose = () => logChat("Disconnected from signaling server.");
  }
  function startPeer(peerId, initiator) {
    if (peers.has(peerId)) return peers.get(peerId);
    const p = new SimplePeer({
      initiator,
      trickle: false,
      // simpler offer/answer flow for demos
      config: { iceServers: getIceServers() }
    });
    peers.set(peerId, p);
    p.on("signal", (data) => {
      ws?.send(JSON.stringify({ type: "signal", target: peerId, data }));
    });
    p.on("connect", () => logChat(`Connected to ${peerId}`));
    p.on("close", () => {
      peers.delete(peerId);
      logChat(`Closed ${peerId}`);
    });
    p.on("error", (err) => logChat(`Peer error (${peerId}): ${err.message}`));
    p.on("data", (buf) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(buf));
        if (msg.type === "chat") logChat(`[${peerId}] ${msg.text}`);
        if (msg.type === "file-announce") logFile(`Announced by ${peerId}: ${msg.hash}`);
        if (msg.type === "file-req") {
          const data = FILES.get(msg.hash);
          if (data) {
            const out = JSON.stringify({ type: "file-data", hash: msg.hash, data: Array.from(data) });
            p.send(new TextEncoder().encode(out));
          }
        }
        if (msg.type === "file-data") {
          const u8 = new Uint8Array(msg.data);
          logFile(`Received ${msg.hash}: ${new TextDecoder().decode(u8)}`);
        }
      } catch {
      }
    });
    return p;
  }
  function broadcast(obj) {
    const data = new TextEncoder().encode(JSON.stringify(obj));
    for (const [, p] of peers) {
      try {
        p.send(data);
      } catch {
      }
    }
  }
  window.addEventListener("DOMContentLoaded", () => {
    ;
    document.getElementById("signalUrl").value = "ws://YOUR_MAC_LAN_IP:8080";
    document.getElementById("turn").value = "turn:YOUR_MAC_LAN_IP:3478";
    document.getElementById("turnUser").value = "user";
    document.getElementById("turnPass").value = "pass";
    document.getElementById("join").addEventListener("click", () => {
      if (joined) {
        logChat("Already joined.");
        return;
      }
      const room = document.getElementById("room").value.trim() || "demo-room-1";
      const url = document.getElementById("signalUrl").value.trim();
      if (!url) {
        alert("Enter signaling server URL");
        return;
      }
      joined = true;
      connectToSignaling(url, room);
      logChat(`Joining room: ${room}`);
    });
    document.getElementById("send").addEventListener("click", () => {
      const input = document.getElementById("chatInput");
      const text = input.value.trim();
      if (!text) return;
      broadcast({ type: "chat", text });
      logChat(`[me] ${text}`);
      input.value = "";
    });
    document.getElementById("announce").addEventListener("click", () => {
      const input = document.getElementById("fileHash");
      const hash = input.value.trim();
      if (!hash) return;
      FILES.set(hash, new TextEncoder().encode(`Payload for ${hash} from ${selfId || "desktop"}`));
      broadcast({ type: "file-announce", hash });
      logFile(`Announced: ${hash}`);
      input.value = "";
    });
    document.getElementById("fetch").addEventListener("click", () => {
      const input = document.getElementById("fetchHash");
      const hash = input.value.trim();
      if (!hash) return;
      broadcast({ type: "file-req", hash });
      logFile(`Requested: ${hash}`);
      input.value = "";
    });
  });
})();
