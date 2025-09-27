(() => {
  // app/src/renderer.ts
  var enc = new TextEncoder();
  var dec = new TextDecoder();
  var statusDot = document.getElementById("statusDot");
  var statusText = document.getElementById("statusText");
  var cfg = document.getElementById("cfg");
  var toggleCfg = document.getElementById("toggleCfg");
  var msgsEl = document.getElementById("msgs");
  var input = document.getElementById("msg");
  var joinBtn = document.getElementById("joinBtn");
  var leaveBtn = document.getElementById("leaveBtn");
  var sendBtn = document.getElementById("sendBtn");
  var roomEl = document.getElementById("room");
  var signalUrlEl = document.getElementById("signalUrl");
  var turnEl = document.getElementById("turn");
  var ws = null;
  var peers = /* @__PURE__ */ new Map();
  var joined = false;
  function setStatus(connected) {
    statusDot.classList.toggle("on", !!connected);
    statusText.textContent = connected ? "Connected" : "Disconnected";
  }
  function pad(n) {
    return n < 10 ? "0" + n : "" + n;
  }
  function tsLabel(ts) {
    const d = ts ? new Date(ts) : /* @__PURE__ */ new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function bubble({ self, text, ts }) {
    const row = document.createElement("div");
    row.className = "row " + (self ? "me" : "them");
    const b = document.createElement("div");
    b.className = "bubble";
    b.textContent = text;
    const meta = document.createElement("div");
    meta.className = "meta";
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
  function iceServers(turnUrl) {
    const arr = [{ urls: ["stun:stun.l.google.com:19302"] }];
    if (turnUrl) arr.push({ urls: [turnUrl], username: "demoUser", credential: "demoPass_ChangeMe" });
    return arr;
  }
  function toU8(d) {
    if (d instanceof Uint8Array) return d;
    if (d instanceof ArrayBuffer) return new Uint8Array(d);
    if (d && d.data instanceof ArrayBuffer) return new Uint8Array(d.data);
    if (typeof d === "string") return enc.encode(d);
    try {
      return enc.encode(String(d));
    } catch {
      return new Uint8Array();
    }
  }
  function startPeer(peerId, initiator, turnUrl) {
    if (peers.has(peerId)) return peers.get(peerId);
    const p = new SimplePeer({
      initiator,
      trickle: false,
      config: { iceServers: iceServers(turnUrl) }
    });
    peers.set(peerId, p);
    p.on("signal", (data) => {
      ws?.send(JSON.stringify({ type: "signal", target: peerId, data }));
    });
    p.on("connect", () => bubble({ self: false, text: `Connected to ${peerId}`, ts: Date.now() }));
    p.on("close", () => {
      peers.delete(peerId);
      bubble({ self: false, text: `Closed ${peerId}`, ts: Date.now() });
    });
    p.on("error", (e) => bubble({ self: false, text: `Peer error: ${e.message}`, ts: Date.now() }));
    p.on("data", (data) => {
      const u8 = toU8(data);
      let text = "";
      try {
        text = dec.decode(u8);
      } catch {
        bubble({ self: false, text: `[binary ${u8.byteLength}B]`, ts: Date.now() });
        return;
      }
      try {
        const obj = JSON.parse(text);
        if (obj && obj.type === "chat") {
          bubble({ self: false, text: obj.text, ts: obj.ts });
          return;
        }
      } catch {
      }
      bubble({ self: false, text, ts: Date.now() });
    });
    return p;
  }
  toggleCfg.addEventListener("click", () => {
    cfg.classList.toggle("hidden");
  });
  joinBtn.addEventListener("click", () => {
    if (joined) return;
    let room = (roomEl.value || "demo-room-1").trim().toLowerCase();
    const url = (signalUrlEl.value || "").trim();
    const turn = (turnEl.value || "").trim();
    if (!url) {
      alert("Enter signaling URL");
      return;
    }
    ws = new WebSocket(url);
    ws.onopen = () => {
      setStatus(true);
      ws.send(JSON.stringify({ type: "join", room }));
      cfg.classList.add("hidden");
    };
    ws.onerror = () => {
      setStatus(false);
    };
    ws.onclose = () => {
      setStatus(false);
      joined = false;
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === "peers") {
        joined = true;
        for (const pid of msg.peers) startPeer(pid, true, turn);
      } else if (msg.type === "new-peer") {
        startPeer(msg.id, false, turn);
      } else if (msg.type === "signal") {
        const p = peers.get(msg.from) || startPeer(msg.from, false, turn);
        p.signal(msg.data);
      }
    };
  });
  leaveBtn.addEventListener("click", () => {
    try {
      ws?.close();
    } catch {
    }
    for (const [, p] of peers) {
      try {
        p.destroy();
      } catch {
      }
    }
    peers.clear();
    setStatus(false);
    joined = false;
    bubble({ self: false, text: "You left the room", ts: Date.now() });
  });
  function sendCurrent() {
    const text = input.value.trim();
    if (!text) return;
    const payload = enc.encode(JSON.stringify({ type: "chat", text, ts: Date.now() }));
    for (const [, p] of peers) {
      try {
        p.send(payload);
      } catch {
      }
    }
    bubble({ self: true, text, ts: Date.now() });
    input.value = "";
  }
  sendBtn.addEventListener("click", sendCurrent);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendCurrent();
    }
  });
})();
