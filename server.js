const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---- 게임 설정 ----
const GOAL = { x: 0.5, y: 0.08, r: 0.06 };
const PLAYER_R = 0.016;

// 미로형 벽 + 슬로우존 + 튕겨내는 범퍼
const OBSTACLES = [
  { type: 'wall', x: 0.35, y: 0.20, w: 0.60, h: 0.035 },
  { type: 'wall', x: 0.05, y: 0.37, w: 0.60, h: 0.035 },
  { type: 'wall', x: 0.35, y: 0.54, w: 0.60, h: 0.035 },
  { type: 'wall', x: 0.05, y: 0.71, w: 0.60, h: 0.035 },
  { type: 'slow', x: 0.05, y: 0.86, w: 0.90, h: 0.08, factor: 0.4 },
  { type: 'bounce', x: 0.5, y: 0.285, r: 0.045 },
  { type: 'bounce', x: 0.5, y: 0.455, r: 0.045 },
  { type: 'bounce', x: 0.5, y: 0.625, r: 0.045 },
];

const BASE_SPEED = 0.011;
const BOUNCE_PUSH = 0.03;
const TICK_MS = 50;
const BROADCAST_MS = 66;
const DISCONNECT_GRACE_MS = 30000;

const players = new Map(); // clientId -> player
let gameStarted = false;

function rectHit(x, y, o) {
  return x > o.x && x < o.x + o.w && y > o.y && y < o.y + o.h;
}

function botDirection(p) {
  let dx = GOAL.x - p.x, dy = GOAL.y - p.y;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  dx += (Math.random() - 0.5) * 0.7;
  dy += (Math.random() - 0.5) * 0.5;
  return { dx, dy };
}

function tick() {
  if (!gameStarted) return;

  for (const p of players.values()) {
    if (p.finished) continue;

    let dx = 0, dy = 0;
    if (p.isBot) {
      const d = botDirection(p);
      dx = d.dx; dy = d.dy;
    } else {
      if (p.input.up) dy -= 1;
      if (p.input.down) dy += 1;
      if (p.input.left) dx -= 1;
      if (p.input.right) dx += 1;
    }
    const len = Math.hypot(dx, dy) || 1;
    if (dx === 0 && dy === 0) continue;

    let speed = p.isBot ? BASE_SPEED * (0.7 + Math.random() * 0.5) : BASE_SPEED;
    for (const o of OBSTACLES) {
      if (o.type === 'slow' && rectHit(p.x, p.y, o)) speed *= o.factor;
    }

    let nx = Math.min(0.97, Math.max(0.03, p.x + (dx / len) * speed));
    let ny = Math.min(0.97, Math.max(0.03, p.y + (dy / len) * speed));

    const blocked = OBSTACLES.some(o => o.type === 'wall' && rectHit(nx, ny, o));
    if (blocked) { continue; }

    for (const o of OBSTACLES) {
      if (o.type !== 'bounce') continue;
      const bdx = nx - o.x, bdy = ny - o.y;
      const dist = Math.hypot(bdx, bdy) || 0.0001;
      const minDist = o.r + PLAYER_R;
      if (dist < minDist) {
        const ux = bdx / dist, uy = bdy / dist;
        nx = o.x + ux * (minDist + BOUNCE_PUSH);
        ny = o.y + uy * (minDist + BOUNCE_PUSH);
        nx = Math.min(0.97, Math.max(0.03, nx));
        ny = Math.min(0.97, Math.max(0.03, ny));
      }
    }

    p.x = nx; p.y = ny;

    const distToGoal = Math.hypot(p.x - GOAL.x, p.y - GOAL.y);
    if (distToGoal < GOAL.r) {
      p.finished = true;
      p.rank = [...players.values()].filter(q => q.finished).length;
      io.emit('arrived', { id: p.id, nickname: p.nickname, rank: p.rank });
    }
  }
}

function broadcast() {
  const list = [...players.values()].map(p => ({
    id: p.id, nickname: p.nickname, x: p.x, y: p.y, finished: p.finished, rank: p.rank, isBot: !!p.isBot
  }));
  io.emit('state', { players: list, goal: GOAL, obstacles: OBSTACLES, started: gameStarted });
}

setInterval(tick, TICK_MS);
setInterval(broadcast, BROADCAST_MS);

function spawnPlayer(cid, nickname, isBot) {
  return {
    id: cid,
    nickname,
    x: 0.1 + Math.random() * 0.8,
    y: 0.9 + Math.random() * 0.06,
    input: { up: false, down: false, left: false, right: false },
    finished: false,
    rank: null,
    disconnectTimer: null,
    isBot: !!isBot,
  };
}

io.on('connection', (socket) => {
  socket.on('join', ({ nickname, clientId } = {}) => {
    const cid = clientId || socket.id;
    const clean = (nickname || '').toString().trim().slice(0, 12) || ('참가자' + cid.slice(-4));

    let p = players.get(cid);
    if (p) {
      if (p.disconnectTimer) { clearTimeout(p.disconnectTimer); p.disconnectTimer = null; }
      p.nickname = clean;
    } else {
      p = spawnPlayer(cid, clean, false);
      players.set(cid, p);
    }
    socket.data.clientId = cid;
    socket.emit('joined', { id: cid, finished: p.finished, rank: p.rank, started: gameStarted });
  });

  socket.on('input', (input) => {
    const cid = socket.data.clientId;
    if (!cid) return;
    const p = players.get(cid);
    if (!p) return;
    p.input = {
      up: !!input.up, down: !!input.down, left: !!input.left, right: !!input.right
    };
  });

  socket.on('host:start', () => {
    gameStarted = true;
    io.emit('game:start');
  });

  socket.on('host:reset', () => {
    gameStarted = false;
    for (const [cid, p] of [...players.entries()]) {
      if (p.isBot) { players.delete(cid); continue; }
      p.finished = false;
      p.rank = null;
      p.x = 0.1 + Math.random() * 0.8;
      p.y = 0.9 + Math.random() * 0.06;
    }
    io.emit('reset');
  });

  socket.on('host:simulate', (count) => {
    const n = Math.min(300, Math.max(1, count || 150));
    for (let i = 0; i < n; i++) {
      const cid = 'bot_' + i + '_' + Math.random().toString(36).slice(2, 6);
      players.set(cid, spawnPlayer(cid, '봇' + (i + 1), true));
    }
  });

  socket.on('host:clearBots', () => {
    for (const [cid, p] of [...players.entries()]) {
      if (p.isBot) players.delete(cid);
    }
  });

  socket.on('disconnect', () => {
    const cid = socket.data.clientId;
    if (!cid) return;
    const p = players.get(cid);
    if (!p || p.isBot) return;
    p.disconnectTimer = setTimeout(() => players.delete(cid), DISCONNECT_GRACE_MS);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('서버 실행 중: ' + PORT));
