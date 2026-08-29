const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---- 게임 설정 ----
const GOAL = { x: 0.5, y: 0.07, r: 0.055 };
const PLAYER_R = 0.016;

const OBSTACLES = [
  { type: 'wall', x: 0.32, y: 0.13, w: 0.63, h: 0.032 },
  { type: 'wall', x: 0.05, y: 0.24, w: 0.36, h: 0.032 },
  { type: 'wall', x: 0.59, y: 0.24, w: 0.36, h: 0.032 },
  { type: 'wall', x: 0.05, y: 0.35, w: 0.63, h: 0.032 },
  { type: 'wall', x: 0.30, y: 0.46, w: 0.65, h: 0.032 },
  { type: 'wall', x: 0.05, y: 0.57, w: 0.38, h: 0.032 },
  { type: 'wall', x: 0.57, y: 0.57, w: 0.38, h: 0.032 },
  { type: 'wall', x: 0.20, y: 0.68, w: 0.60, h: 0.032 },
  { type: 'slow', x: 0.05, y: 0.85, w: 0.90, h: 0.06, factor: 0.28 },
  { type: 'bounce', cx: 0.22, cy: 0.18, r: 0.04, moveAxis: 'x', moveRange: 0.16, moveSpeed: 0.85 },
  { type: 'bounce', cx: 0.78, cy: 0.29, r: 0.04, moveAxis: 'y', moveRange: 0.07, moveSpeed: 1.2 },
  { type: 'bounce', cx: 0.5, cy: 0.40, r: 0.045, moveAxis: 'x', moveRange: 0.24, moveSpeed: 0.7 },
  { type: 'bounce', cx: 0.22, cy: 0.51, r: 0.04, moveAxis: 'y', moveRange: 0.06, moveSpeed: 1.0 },
  { type: 'bounce', cx: 0.5, cy: 0.62, r: 0.042, moveAxis: 'x', moveRange: 0.12, moveSpeed: 0.55 },
  { type: 'bounce', cx: 0.5, cy: 0.755, r: 0.04, moveAxis: 'x', moveRange: 0.18, moveSpeed: 0.9 },
];

const BASE_SPEED = 0.011;
const BOUNCE_PUSH = 0.03;
const TICK_MS = 50;
const BROADCAST_MS = 66;
const DISCONNECT_GRACE_MS = 30000;
const GRID_N = 60; // 자율경로 탐색용 격자 해상도

const players = new Map();
let gameStarted = false;

function rectHit(x, y, o) {
  return x > o.x && x < o.x + o.w && y > o.y && y < o.y + o.h;
}

function resolveObstacles(now) {
  return OBSTACLES.map(o => {
    if (o.type !== 'bounce') return o;
    if (!o.moveAxis || o.moveAxis === 'none') return { type: 'bounce', x: o.cx, y: o.cy, r: o.r };
    const t = (now / 1000) * (o.moveSpeed || 0.5);
    const offset = Math.sin(t) * (o.moveRange || 0);
    if (o.moveAxis === 'x') return { type: 'bounce', x: o.cx + offset, y: o.cy, r: o.r };
    return { type: 'bounce', x: o.cx, y: o.cy + offset, r: o.r };
  });
}

// 이동 경로 전체를 여러 지점으로 쪼개 벽 통과(터널링) 여부를 확인
function sweepBlocked(x0, y0, x1, y1, obstacles) {
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    if (obstacles.some(o => o.type === 'wall' && rectHit(x, y, o))) return true;
  }
  return false;
}

// ---- 봇 자율경로: 목표에서부터 BFS로 흐름장(flow field)을 한 번 계산해두고 재사용 ----
function buildFlowField() {
  const N = GRID_N;
  const blocked = Array.from({ length: N }, () => new Array(N).fill(false));
  for (let gx = 0; gx < N; gx++) {
    for (let gy = 0; gy < N; gy++) {
      const cx = (gx + 0.5) / N, cy = (gy + 0.5) / N;
      if (OBSTACLES.some(o => o.type === 'wall' && rectHit(cx, cy, o))) blocked[gx][gy] = true;
    }
  }
  const dist = Array.from({ length: N }, () => new Array(N).fill(Infinity));
  const queue = [];
  const goalGx = Math.floor(GOAL.x * N), goalGy = Math.floor(GOAL.y * N);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const gx = goalGx + dx, gy = goalGy + dy;
    if (gx >= 0 && gx < N && gy >= 0 && gy < N && !blocked[gx][gy] && dist[gx][gy] === Infinity) {
      dist[gx][gy] = 0; queue.push([gx, gy]);
    }
  }
  const dirs4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let head = 0;
  while (head < queue.length) {
    const [gx, gy] = queue[head++];
    for (const [dx, dy] of dirs4) {
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || nx >= N || ny < 0 || ny >= N || blocked[nx][ny]) continue;
      if (dist[nx][ny] > dist[gx][gy] + 1) {
        dist[nx][ny] = dist[gx][gy] + 1;
        queue.push([nx, ny]);
      }
    }
  }
  const dir = Array.from({ length: N }, () => new Array(N).fill(null));
  for (let gx = 0; gx < N; gx++) {
    for (let gy = 0; gy < N; gy++) {
      if (blocked[gx][gy] || dist[gx][gy] === Infinity) continue;
      let best = null, bestDist = dist[gx][gy];
      for (const [dx, dy] of dirs4) {
        const nx = gx + dx, ny = gy + dy;
        if (nx < 0 || nx >= N || ny < 0 || ny >= N) continue;
        if (dist[nx][ny] < bestDist) { bestDist = dist[nx][ny]; best = [dx, dy]; }
      }
      dir[gx][gy] = best;
    }
  }
  return { blocked, dir, N };
}
const FLOW = buildFlowField();

function botDirection(p) {
  const gx = Math.min(FLOW.N - 1, Math.max(0, Math.floor(p.x * FLOW.N)));
  const gy = Math.min(FLOW.N - 1, Math.max(0, Math.floor(p.y * FLOW.N)));
  let dx, dy;
  if (FLOW.blocked[gx][gy] || !FLOW.dir[gx][gy]) {
    dx = GOAL.x - p.x; dy = GOAL.y - p.y;
  } else {
    [dx, dy] = FLOW.dir[gx][gy];
  }
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  dx += (Math.random() - 0.5) * 0.35;
  dy += (Math.random() - 0.5) * 0.35;
  return { dx, dy };
}

function tick() {
  if (!gameStarted) return;
  const obstacles = resolveObstacles(Date.now());

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
    for (const o of obstacles) {
      if (o.type === 'slow' && rectHit(p.x, p.y, o)) speed *= o.factor;
    }

    const stepX = Math.min(0.97, Math.max(0.03, p.x + (dx / len) * speed));
    const stepY = Math.min(0.97, Math.max(0.03, p.y + (dy / len) * speed));

    if (sweepBlocked(p.x, p.y, stepX, stepY, obstacles)) continue;

    let nx = stepX, ny = stepY;
    for (const o of obstacles) {
      if (o.type !== 'bounce') continue;
      const bdx = nx - o.x, bdy = ny - o.y;
      const dist = Math.hypot(bdx, bdy) || 0.0001;
      const minDist = o.r + PLAYER_R;
      if (dist < minDist) {
        const ux = bdx / dist, uy = bdy / dist;
        const pushedX = Math.min(0.97, Math.max(0.03, o.x + ux * (minDist + BOUNCE_PUSH)));
        const pushedY = Math.min(0.97, Math.max(0.03, o.y + uy * (minDist + BOUNCE_PUSH)));
        // 밀려나는 전체 경로도 함께 검사해서 벽을 뚫고 지나가지 못하게 함
        if (!sweepBlocked(nx, ny, pushedX, pushedY, obstacles)) {
          nx = pushedX; ny = pushedY;
        }
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
  io.emit('state', {
    players: list,
    goal: GOAL,
    obstacles: resolveObstacles(Date.now()),
    started: gameStarted
  });
}

setInterval(tick, TICK_MS);
setInterval(broadcast, BROADCAST_MS);

function spawnPlayer(cid, nickname, isBot) {
  return {
    id: cid,
    nickname,
    x: 0.46 + Math.random() * 0.08,
    y: 0.93 + Math.random() * 0.03,
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
      p.x = 0.46 + Math.random() * 0.08;
      p.y = 0.93 + Math.random() * 0.03;
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
