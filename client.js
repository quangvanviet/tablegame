/* client.js - HTML5 Canvas client (ES6+)
   - Render board
   - Mouse drag/drop
   - Send intents to authoritative server via WebSocket
   - Receive filtered state per-player (privacy for hand zone)
*/

const WS_URL = (() => {
  // server.js mặc định chạy 8080
  const host = location.hostname || "localhost";
  return `ws://${host}:8080`;
})();

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

// UI elements
const roomInput = document.getElementById("roomInput");
const createBtn = document.getElementById("createBtn");
const joinBtn = document.getElementById("joinBtn");
const statusEl = document.getElementById("status");
const meTag = document.getElementById("meTag");
const playersLegend = document.getElementById("playersLegend");

const btnDraw = document.getElementById("btnDraw");
const btnShuffle = document.getElementById("btnShuffle");
const btnFlip = document.getElementById("btnFlip");
const btnStack = document.getElementById("btnStack");
const btnUnstack = document.getElementById("btnUnstack");

const chatLog = document.getElementById("chatLog");
const chatInput = document.getElementById("chatInput");

// ---------- Client state (render only) ----------
let ws = null;
let connected = false;

let my = {
  playerId: null,
  color: "#ffffff",
  roomId: null,
  seatIndex: null
};

let view = {
  roomId: null,
  players: [],            // [{playerId, colorName, colorHex, seatIndex}]
  tableCards: [],         // cards visible on table/deck/discard (+ my hand cards)
  stacks: [],             // [{stackId, x,y, cardIds:[...]}]
  zones: null,            // geometry
  hands: {},              // {playerId:{count}}
  deckCount: 0,
  discardCount: 0,
  serverTime: 0
};

// selection & dragging
let selected = { type: null, id: null }; // {type:'card'|'stack', id}
let hover = { type: null, id: null };
let dragging = null; // {type,id, offsetX, offsetY}
let lastMoveSentAt = 0;

// Asset cache
const images = new Map();
function loadImage(url) {
  if (!url) return null;
  if (images.has(url)) return images.get(url);
  const img = new Image();
  img.src = url;
  images.set(url, img);
  return img;
}

// ---------- Room helpers ----------
function genRoomCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[(Math.random() * chars.length) | 0];
  return out;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function addChatLine({ name, colorHex, text, system }) {
  const div = document.createElement("div");
  div.className = "msg";
  if (system) {
    div.innerHTML = `<span class="muted">${escapeHtml(text)}</span>`;
  } else {
    div.innerHTML = `<span class="name" style="color:${colorHex}">${escapeHtml(name)}:</span><span>${escapeHtml(text)}</span>`;
  }
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

// ---------- WebSocket ----------
function connect(roomId, mode /* 'create' | 'join' */) {
  if (ws) ws.close();

  ws = new WebSocket(WS_URL);
  ws.addEventListener("open", () => {
    connected = true;
    setStatus("Connected");
    // Join handshake
    send({
      type: "ROOM_JOIN",
      roomId,
      mode,
      name: `P${Math.floor(Math.random()*1000)}`
    });
  });

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    handleServerMessage(msg);
  });

  ws.addEventListener("close", () => {
    connected = false;
    setStatus("Disconnected");
  });

  ws.addEventListener("error", () => {
    connected = false;
    setStatus("Error");
  });
}

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

// ---------- Server messages ----------
function handleServerMessage(msg) {
  switch (msg.type) {
    case "ROOM_JOINED": {
      my.playerId = msg.playerId;
      my.color = msg.colorHex;
      my.roomId = msg.roomId;
      my.seatIndex = msg.seatIndex;

      meTag.textContent = `me: ${my.playerId} (${msg.colorName})`;
      setStatus(`In room ${msg.roomId} (seat ${my.seatIndex+1}/4)`);

      // Put room code in URL hash for share link
      location.hash = msg.roomId;
      roomInput.value = msg.roomId;

      addChatLine({ system:true, text: `Joined room ${msg.roomId}. Share link: ${location.href}` });
      break;
    }
    case "ROOM_ERROR": {
      addChatLine({ system:true, text: msg.message });
      setStatus(msg.message);
      break;
    }
    case "STATE": {
      // filtered state for THIS client (privacy enforced server-side)
      view.roomId = msg.roomId;
      view.players = msg.players;
      view.tableCards = msg.cards;
      view.stacks = msg.stacks;
      view.hands = msg.hands;
      view.zones = msg.zones;
      view.deckCount = msg.deckCount;
      view.discardCount = msg.discardCount;
      view.serverTime = msg.serverTime;

      renderPlayersLegend();
      break;
    }
    case "CHAT": {
      addChatLine(msg);
      break;
    }
    default:
      break;
  }
}

function renderPlayersLegend() {
  playersLegend.innerHTML = "";
  for (const p of view.players) {
    const span = document.createElement("span");
    span.className = "pill";
    const count = view.hands?.[p.playerId]?.count ?? 0;
    span.innerHTML = `<span class="dot" style="background:${p.colorHex}"></span>${escapeHtml(p.playerId)} • hand:${count}`;
    playersLegend.appendChild(span);
  }
  const deck = document.createElement("span");
  deck.className = "pill";
  deck.textContent = `deck:${view.deckCount}`;
  playersLegend.appendChild(deck);

  const discard = document.createElement("span");
  discard.className = "pill";
  discard.textContent = `discard:${view.discardCount}`;
  playersLegend.appendChild(discard);
}

// ---------- Input actions ----------
createBtn.addEventListener("click", () => {
  const roomId = genRoomCode(6);
  connect(roomId, "create");
});

joinBtn.addEventListener("click", () => {
  const roomId = (roomInput.value || "").trim().toUpperCase();
  if (!roomId) return;
  connect(roomId, "join");
});

btnDraw.addEventListener("click", () => {
  send({ type:"ACTION", action:{ kind:"DRAW" } });
});

btnShuffle.addEventListener("click", () => {
  send({ type:"ACTION", action:{ kind:"SHUFFLE_DECK" } });
});

btnFlip.addEventListener("click", () => {
  if (!selected.id) return;
  send({ type:"ACTION", action:{ kind:"FLIP", target:selected } });
});

btnStack.addEventListener("click", () => {
  // Stack selected with current hover (must be different)
  if (!selected.id || !hover.id) return;
  if (selected.type !== "card" || hover.type !== "card") return;
  if (selected.id === hover.id) return;
  send({ type:"ACTION", action:{ kind:"STACK", aCardId:selected.id, bCardId:hover.id } });
});

btnUnstack.addEventListener("click", () => {
  // Unstack top from selected stack (or stack that contains selected card)
  if (!selected.id) return;
  send({ type:"ACTION", action:{ kind:"UNSTACK_TOP", target:selected } });
});

// chat
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = "";
    send({ type:"CHAT", text });
  }
});

// Auto-join from URL hash
window.addEventListener("load", () => {
  const hashRoom = (location.hash || "").replace("#", "").trim().toUpperCase();
  if (hashRoom) {
    roomInput.value = hashRoom;
    connect(hashRoom, "join");
  }
});

// ---------- Canvas rendering ----------
function resizeCanvasToDisplaySize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}
window.addEventListener("resize", resizeCanvasToDisplaySize);

// Geometry helpers
function worldToScreen(x,y){ return {x,y}; }
function screenToWorld(x,y){ return {x,y}; }

function drawRoundedRect(x,y,w,h,r){
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y, x+w,y+h, r);
  ctx.arcTo(x+w,y+h, x,y+h, r);
  ctx.arcTo(x,y+h, x,y, r);
  ctx.arcTo(x,y, x+w,y, r);
  ctx.closePath();
}

function drawCardFace(card, x, y, w, h) {
  // If card.frontImage is missing (privacy), draw generic back
  const faceUp = card.faceUp && !!card.frontImage;
  const url = faceUp ? card.frontImage : card.backImage;
  const img = loadImage(url);

  // card border
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  drawRoundedRect(x, y, w, h, 10);
  ctx.fill();
  ctx.stroke();

  if (img && img.complete && img.naturalWidth > 0) {
    // cover-ish fit
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const scale = Math.max(w / iw, h / ih);
    const sw = iw * scale;
    const sh = ih * scale;
    const dx = x + (w - sw)/2;
    const dy = y + (h - sh)/2;
    ctx.save();
    drawRoundedRect(x, y, w, h, 10);
    ctx.clip();
    ctx.drawImage(img, dx, dy, sw, sh);
    ctx.restore();
  } else {
    // fallback text
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.font = "14px system-ui";
    ctx.fillText(faceUp ? "FRONT" : "BACK", x+10, y+22);
  }

  // id label
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(x+8, y+h-26, w-16, 18);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.font = "12px system-ui";
  ctx.fillText(card.id, x+12, y+h-13);

  ctx.restore();
}

function drawZones(z) {
  if (!z) return;

  // table
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 2;
  ctx.setLineDash([6,6]);
  ctx.strokeRect(z.table.x, z.table.y, z.table.w, z.table.h);
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.font = "14px system-ui";
  ctx.fillText("TABLE", z.table.x + 10, z.table.y + 20);

  // deck/discard
  ctx.strokeRect(z.deck.x, z.deck.y, z.deck.w, z.deck.h);
  ctx.fillText("DECK", z.deck.x + 10, z.deck.y + 20);

  ctx.strokeRect(z.discard.x, z.discard.y, z.discard.w, z.discard.h);
  ctx.fillText("DISCARD", z.discard.x + 10, z.discard.y + 20);

  // my hand
  ctx.strokeRect(z.myHand.x, z.myHand.y, z.myHand.w, z.myHand.h);
  ctx.fillText("MY HAND (private)", z.myHand.x + 10, z.myHand.y + 20);

  ctx.restore();
}

function getRenderList() {
  // Combine stacks + loose cards (cards not in stacks)
  const stacked = new Set();
  for (const st of view.stacks) for (const cid of st.cardIds) stacked.add(cid);

  const loose = view.tableCards.filter(c => !stacked.has(c.id));
  return { stacks: view.stacks, loose };
}

function draw() {
  resizeCanvasToDisplaySize();

  // Clear
  ctx.clearRect(0,0,canvas.width,canvas.height);

  // Background grid (simple)
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  const step = 40 * (window.devicePixelRatio || 1);
  for (let x=0; x<canvas.width; x+=step) {
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,canvas.height); ctx.stroke();
  }
  for (let y=0; y<canvas.height; y+=step) {
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(canvas.width,y); ctx.stroke();
  }
  ctx.restore();

  // Zones
  drawZones(view.zones);

  const CARD_W = 90 * (window.devicePixelRatio || 1);
  const CARD_H = 126 * (window.devicePixelRatio || 1);

  const { stacks, loose } = getRenderList();

  // Draw stacks (top card visible)
  for (const st of stacks) {
    const topId = st.cardIds[st.cardIds.length - 1];
    const top = view.tableCards.find(c => c.id === topId);
    if (!top) continue;

    // stack shadow offset
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    drawRoundedRect(st.x + 10, st.y + 10, CARD_W, CARD_H, 10);
    ctx.fill();
    ctx.restore();

    drawCardFace(top, st.x, st.y, CARD_W, CARD_H);

    // count badge
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(st.x + CARD_W - 28, st.y + 8, 20, 18);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "12px system-ui";
    ctx.fillText(String(st.cardIds.length), st.x + CARD_W - 24, st.y + 21);
    ctx.restore();

    // highlight hover/selected
    if (hover.type === "stack" && hover.id === st.stackId) {
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 3;
      ctx.strokeRect(st.x-2, st.y-2, CARD_W+4, CARD_H+4);
      ctx.restore();
    }
    if (selected.type === "stack" && selected.id === st.stackId) {
      ctx.save();
      ctx.strokeStyle = "rgba(0,200,255,0.55)";
      ctx.lineWidth = 3;
      ctx.strokeRect(st.x-2, st.y-2, CARD_W+4, CARD_H+4);
      ctx.restore();
    }
  }

  // Draw loose cards
  for (const c of loose) {
    drawCardFace(c, c.x, c.y, CARD_W, CARD_H);

    if (hover.type === "card" && hover.id === c.id) {
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 3;
      ctx.strokeRect(c.x-2, c.y-2, CARD_W+4, CARD_H+4);
      ctx.restore();
    }
    if (selected.type === "card" && selected.id === c.id) {
      ctx.save();
      ctx.strokeStyle = "rgba(0,200,255,0.55)";
      ctx.lineWidth = 3;
      ctx.strokeRect(c.x-2, c.y-2, CARD_W+4, CARD_H+4);
      ctx.restore();
    }
  }

  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

// ---------- Hit testing ----------
function hitTest(mx, myy) {
  const dpr = window.devicePixelRatio || 1;
  const x = mx * dpr;
  const y = myy * dpr;

  const CARD_W = 90 * dpr;
  const CARD_H = 126 * dpr;

  // stacks first (topmost-ish)
  for (let i = view.stacks.length - 1; i >= 0; i--) {
    const st = view.stacks[i];
    if (x >= st.x && x <= st.x + CARD_W && y >= st.y && y <= st.y + CARD_H) {
      return { type:"stack", id: st.stackId, x, y };
    }
  }

  // loose cards
  const stacked = new Set();
  for (const st of view.stacks) for (const cid of st.cardIds) stacked.add(cid);
  const loose = view.tableCards.filter(c => !stacked.has(c.id));

  for (let i = loose.length - 1; i >= 0; i--) {
    const c = loose[i];
    if (x >= c.x && x <= c.x + CARD_W && y >= c.y && y <= c.y + CARD_H) {
      return { type:"card", id: c.id, x, y };
    }
  }

  return null;
}

// ---------- Mouse controls ----------
canvas.addEventListener("mousemove", (e) => {
  const ht = hitTest(e.offsetX, e.offsetY);
  hover = ht ? { type: ht.type, id: ht.id } : { type:null, id:null };

  if (dragging) {
    const dpr = window.devicePixelRatio || 1;
    const x = e.offsetX * dpr - dragging.offsetX;
    const y = e.offsetY * dpr - dragging.offsetY;

    // Send throttled MOVE intent
    const now = performance.now();
    if (now - lastMoveSentAt > 33) { // ~30fps
      lastMoveSentAt = now;
      send({ type:"ACTION", action:{ kind:"MOVE", target:{type:dragging.type, id:dragging.id}, x, y } });
    }
  }
});

canvas.addEventListener("mousedown", (e) => {
  const ht = hitTest(e.offsetX, e.offsetY);
  if (!ht) { selected = {type:null,id:null}; return; }

  selected = { type: ht.type, id: ht.id };

  // start drag with offset
  const dpr = window.devicePixelRatio || 1;
  const x = e.offsetX * dpr;
  const y = e.offsetY * dpr;

  if (ht.type === "card") {
    const c = view.tableCards.find(cc => cc.id === ht.id);
    if (!c) return;
    dragging = { type:"card", id: ht.id, offsetX: x - c.x, offsetY: y - c.y };
    // bring to top (server can manage z, here keep simple)
    send({ type:"ACTION", action:{ kind:"PICKUP", target:selected } });
  } else if (ht.type === "stack") {
    const st = view.stacks.find(s => s.stackId === ht.id);
    if (!st) return;
    dragging = { type:"stack", id: ht.id, offsetX: x - st.x, offsetY: y - st.y };
    send({ type:"ACTION", action:{ kind:"PICKUP", target:selected } });
  }
});

canvas.addEventListener("mouseup", () => {
  if (!dragging) return;
  // finalize drop
  send({ type:"ACTION", action:{ kind:"DROP", target:{type:dragging.type, id:dragging.id} } });
  dragging = null;
});

canvas.addEventListener("dblclick", (e) => {
  const ht = hitTest(e.offsetX, e.offsetY);
  if (!ht) return;
  // dblclick to flip
  send({ type:"ACTION", action:{ kind:"FLIP", target:{type:ht.type, id:ht.id} } });
});

// Right click: quick actions
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const ht = hitTest(e.offsetX, e.offsetY);
  if (!ht) return;

  // right-click stack => unstack top
  if (ht.type === "stack") {
    send({ type:"ACTION", action:{ kind:"UNSTACK_TOP", target:{type:"stack", id:ht.id} } });
  }
});
