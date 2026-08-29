const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ==== 공통 유틸 ====
const PLAYER_R = 0.018;
const BOUNCE_PUSH = 0.03;

function pointSegDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function isWallBlocked(x, y, obstacles, margin = 0) {
  for (const o of obstacles) {
    if (o.type === 'wall' &&
        x > o.x - margin && x < o.x + o.w + margin &&
        y > o.y - margin && y < o.y + o.h + margin) return true;
    if (o.type === 'diagWall' && pointSegDist(x, y, o.x1, o.y1, o.x2, o.y2) < o.thickness / 2 + margin) return true;
  }
  return false;
}

function rectIn(x, y, o) {
  return x > o.x && x < o.x + o.w && y > o.y && y < o.y + o.h;
}

function resolveObstacles(raw, now) {
  return raw.map(o => {
    if (o.type === 'bounce') {
      if (!o.moveAxis || o.moveAxis === 'none') return { type: 'bounce', x: o.cx, y: o.cy, r: o.r };
      const t = (now / 1000) * (o.moveSpeed || 0.5);
      const offset = Math.sin(t) * (o.moveRange || 0);
      if (o.moveAxis === 'x') return { type: 'bounce', x: o.cx + offset, y: o.cy, r: o.r };
      return { type: 'bounce', x: o.cx, y: o.cy + offset, r: o.r };
    }
    if (o.type === 'rotator') {
      const angle = (now / 1000) * (o.speed || 1);
      const hl = o.length / 2;
      return {
        type: 'diagWall',
        x1: o.cx - Math.cos(angle) * hl, y1: o.cy - Math.sin(angle) * hl,
        x2: o.cx + Math.cos(angle) * hl, y2: o.cy + Math.sin(angle) * hl,
        thickness: o.thickness,
      };
    }
    return o;
  });
}

function sweepBlocked(x0, y0, x1, y1, obstacles, margin = 0) {
  const steps = 14;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (isWallBlocked(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, obstacles, margin)) return true;
  }
  return false;
}

const GRID_N = 60;
function buildFlowField(raw, goal) {
  const N = GRID_N;
  const blocked = Array.from({ length: N }, () => new Array(N).fill(false));
  for (let gx = 0; gx < N; gx++) {
    for (let gy = 0; gy < N; gy++) {
      const cx = (gx + 0.5) / N, cy = (gy + 0.5) / N;
      if (isWallBlocked(cx, cy, raw, PLAYER_R)) blocked[gx][gy] = true;
    }
  }
  const dist = Array.from({ length: N }, () => new Array(N).fill(Infinity));
  const queue = [];
  const goalGx = Math.floor(goal.x * N), goalGy = Math.floor(goal.y * N);
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

function botDirection(p, flow, goal) {
  const gx = Math.min(flow.N - 1, Math.max(0, Math.floor(p.x * flow.N)));
  const gy = Math.min(flow.N - 1, Math.max(0, Math.floor(p.y * flow.N)));
  let dx, dy;
  if (flow.blocked[gx][gy] || !flow.dir[gx][gy]) {
    dx = goal.x - p.x; dy = goal.y - p.y;
  } else {
    [dx, dy] = flow.dir[gx][gy];
  }
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  dx += (Math.random() - 0.5) * 0.35;
  dy += (Math.random() - 0.5) * 0.35;
  return { dx, dy };
}

// ==== 3단계 스테이지 정의 (보통 / 어려움 / 극악) ====
// 통로(gap) 정중앙에만 동적 장애물을 둬서 실제로 반드시 마주치도록 구성

const NORMAL_RAW = [
  { type: 'wall', x: 0.40, y: 0.22, w: 0.65, h: 0.032 },   // gap left 0.03~0.40
  { type: 'wall', x: -0.05, y: 0.45, w: 0.65, h: 0.032 },  // gap right 0.60~0.97
  { type: 'wall', x: 0.40, y: 0.68, w: 0.65, h: 0.032 },   // gap left 0.03~0.40
  { type: 'slow', x: 0.05, y: 0.86, w: 0.90, h: 0.06, factor: 0.4 },
  { type: 'bounce', cx: 0.785, cy: 0.565, r: 0.045, moveAxis: 'x', moveRange: 0.06, moveSpeed: 0.5 },
];
const NORMAL_GOAL = { x: 0.5, y: 0.09, r: 0.065 };

const HARD_RAW = [
  { type: 'wall', x: 0.34, y: 0.12, w: 0.71, h: 0.032 },
  { type: 'wall', x: -0.05, y: 0.24, w: 0.46, h: 0.032 },
  { type: 'wall', x: 0.59, y: 0.24, w: 0.46, h: 0.032 },
  { type: 'wall', x: -0.05, y: 0.36, w: 0.71, h: 0.032 },
  // Row D: 갈림길 — 왼쪽은 좁고 빠른 회전바(위험/단거리), 오른쪽은 넓고 느긋한 범퍼(안전/여유)
  { type: 'wall', x: 0.16, y: 0.48, w: 0.29, h: 0.032 },
  { type: 'wall', x: 0.66, y: 0.48, w: 0.39, h: 0.032 },
  { type: 'wall', x: -0.05, y: 0.60, w: 0.47, h: 0.032 },
  { type: 'wall', x: 0.58, y: 0.60, w: 0.47, h: 0.032 },
  { type: 'wall', x: -0.05, y: 0.72, w: 0.87, h: 0.032 },
  { type: 'slow', x: 0.05, y: 0.86, w: 0.90, h: 0.06, factor: 0.28 },
  { type: 'diagWall', x1: 0.06, y1: 0.16, x2: 0.30, y2: 0.225, thickness: 0.035 },
  { type: 'bounce', cx: 0.5, cy: 0.305, r: 0.042, moveAxis: 'x', moveRange: 0.07, moveSpeed: 1.15 },
  { type: 'bounce', cx: 0.815, cy: 0.42, r: 0.042, moveAxis: 'y', moveRange: 0.05, moveSpeed: 1.25 },
  { type: 'rotator', cx: 0.095, cy: 0.545, length: 0.13, thickness: 0.03, speed: 1.6 },   // 갈림길 왼쪽 (위험)
  { type: 'bounce', cx: 0.555, cy: 0.545, r: 0.045, moveAxis: 'x', moveRange: 0.05, moveSpeed: 0.6 }, // 갈림길 오른쪽 (안전)
  { type: 'bounce', cx: 0.5, cy: 0.676, r: 0.04, moveAxis: 'x', moveRange: 0.06, moveSpeed: 0.9 },
  { type: 'rotator', cx: 0.895, cy: 0.79, length: 0.16, thickness: 0.03, speed: 1.55 },
];
const HARD_GOAL = { x: 0.5, y: 0.07, r: 0.055 };

const EXTREME_RAW = [
  { type: 'wall', x: 0.26, y: 0.10, w: 0.79, h: 0.03 },    // gap left 0.03~0.26
  { type: 'wall', x: -0.05, w: 0.49, y: 0.20, h: 0.03 },
  { type: 'wall', x: 0.56, y: 0.20, w: 0.49, h: 0.03 },    // gap middle 0.44~0.56
  { type: 'wall', x: -0.05, y: 0.30, w: 0.79, h: 0.03 },   // gap right 0.74~0.97
  // Row D: 갈림길 — 왼쪽은 극도로 좁은 회전바 관문(초고위험), 오른쪽은 그나마 넓은 빠른 범퍼(고위험)
  { type: 'wall', x: 0.11, y: 0.40, w: 0.28, h: 0.03 },
  { type: 'wall', x: 0.60, y: 0.40, w: 0.45, h: 0.03 },
  { type: 'wall', x: -0.05, y: 0.50, w: 0.51, h: 0.03 },
  { type: 'wall', x: 0.54, y: 0.50, w: 0.51, h: 0.03 },    // gap middle 0.46~0.54
  { type: 'wall', x: -0.05, y: 0.60, w: 0.93, h: 0.03 },   // gap right 0.88~0.97
  { type: 'wall', x: 0.20, y: 0.70, w: 0.85, h: 0.03 },    // gap left 0.03~0.20
  { type: 'slow', x: 0.05, y: 0.84, w: 0.90, h: 0.06, factor: 0.2 },
  { type: 'diagWall', x1: 0.04, y1: 0.13, x2: 0.24, y2: 0.185, thickness: 0.04 },
  { type: 'bounce', cx: 0.5, cy: 0.25, r: 0.04, moveAxis: 'x', moveRange: 0.04, moveSpeed: 1.4 },
  { type: 'bounce', cx: 0.855, cy: 0.35, r: 0.04, moveAxis: 'y', moveRange: 0.04, moveSpeed: 1.5 },
  { type: 'rotator', cx: 0.07, cy: 0.45, length: 0.07, thickness: 0.028, speed: 1.8 },     // 갈림길 왼쪽 (초고위험)
  { type: 'bounce', cx: 0.495, cy: 0.45, r: 0.04, moveAxis: 'x', moveRange: 0.05, moveSpeed: 1.2 }, // 갈림길 오른쪽 (고위험)
  { type: 'bounce', cx: 0.5, cy: 0.55, r: 0.038, moveAxis: 'x', moveRange: 0.03, moveSpeed: 1.1 },
  { type: 'rotator', cx: 0.925, cy: 0.65, length: 0.10, thickness: 0.03, speed: 1.8 },
  { type: 'bounce', cx: 0.115, cy: 0.75, r: 0.038, moveAxis: 'y', moveRange: 0.03, moveSpeed: 1.3 },
];
const EXTREME_GOAL = { x: 0.5, y: 0.06, r: 0.04 };

const STAGES = [
  { key: 'normal', label: '1라운드 · 보통', raw: NORMAL_RAW, goal: NORMAL_GOAL },
  { key: 'hard', label: '2라운드 · 어려움', raw: HARD_RAW, goal: HARD_GOAL },
  { key: 'extreme', label: '3라운드 · 극악', raw: EXTREME_RAW, goal: EXTREME_GOAL },
];
const FLOWS = STAGES.map(s => buildFlowField(s.raw, s.goal));

const BASE_SPEED = 0.011;
const TICK_MS = 50;
const BROADCAST_MS = 66;
const DISCONNECT_GRACE_MS = 30000;

const players = new Map();
let currentStageIndex = 0;
let gameStarted = false;

function spawnPos() {
  return { x: 0.46 + Math.random() * 0.08, y: 0.93 + Math.random() * 0.03 };
}

function spawnPlayer(cid, nickname, isBot) {
  const pos = spawnPos();
  return {
    id: cid,
    nickname,
    x: pos.x, y: pos.y,
    input: { up: false, down: false, left: false, right: false },
    finished: false,
    rank: null,
    eliminated: false,
    disconnectTimer: null,
    isBot: !!isBot,
  };
}

function tick() {
  if (!gameStarted) return;
  const stage = STAGES[currentStageIndex];
  const flow = FLOWS[currentStageIndex];
  const obstacles = resolveObstacles(stage.raw, Date.now());

  for (const p of players.values()) {
    if (p.finished || p.eliminated) continue;

    let dx = 0, dy = 0;
    if (p.isBot) {
      const d = botDirection(p, flow, stage.goal);
      dx = d.dx; dy = d.dy;
    } else {
      if (p.input.up) dy -= 1;
      if (p.input.down) dy += 1;
      if (p.input.left) dx -= 1;
      if (p.input.right) dx += 1;
    }

    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy) || 1;
      let speed = p.isBot ? BASE_SPEED * (0.7 + Math.random() * 0.5) : BASE_SPEED;
      for (const o of obstacles) {
        if (o.type === 'slow' && rectIn(p.x, p.y, o)) speed *= o.factor;
      }

      const targetX = Math.min(0.97, Math.max(0.03, p.x + (dx / len) * speed));
      const targetY = Math.min(0.97, Math.max(0.03, p.y + (dy / len) * speed));

      // x축, y축을 따로 시도 -> 한쪽이 막혀도 다른 쪽으로는 계속 미끄러지듯 이동
      if (!sweepBlocked(p.x, p.y, targetX, p.y, obstacles, PLAYER_R)) p.x = targetX;
      if (!sweepBlocked(p.x, p.y, p.x, targetY, obstacles, PLAYER_R)) p.y = targetY;
    }

    // 움직였든 안 움직였든 매 틱마다 실행: 범퍼/회전바가 "가만히 있는 참가자 쪽으로" 다가와도
    // 뚫고 지나가지 않도록 항상 겹침을 풀어줌 (튕겨내기 + 회전바 밀어내기)
    depenetrate(p, obstacles);

    const distToGoal = Math.hypot(p.x - stage.goal.x, p.y - stage.goal.y);
    if (distToGoal < stage.goal.r) {
      p.finished = true;
      p.rank = [...players.values()].filter(q => !q.eliminated && q.finished).length;
      io.emit('arrived', { id: p.id, nickname: p.nickname, rank: p.rank, isBot: !!p.isBot });
    }
  }
}

function depenetrate(p, obstacles) {
  for (const o of obstacles) {
    if (o.type === 'bounce') {
      const bdx = p.x - o.x, bdy = p.y - o.y;
      const dist = Math.hypot(bdx, bdy) || 0.0001;
      const minDist = o.r + PLAYER_R;
      if (dist < minDist) {
        const ux = bdx / dist, uy = bdy / dist;
        const pushedX = Math.min(0.97, Math.max(0.03, o.x + ux * (minDist + BOUNCE_PUSH)));
        const pushedY = Math.min(0.97, Math.max(0.03, o.y + uy * (minDist + BOUNCE_PUSH)));
        if (!sweepBlocked(p.x, p.y, pushedX, pushedY, obstacles, PLAYER_R)) {
          p.x = pushedX; p.y = pushedY;
        }
      }
    } else if (o.type === 'diagWall') {
      const dist = pointSegDist(p.x, p.y, o.x1, o.y1, o.x2, o.y2);
      const minDist = o.thickness / 2 + PLAYER_R;
      if (dist < minDist) {
        // 선분 위 가장 가까운 점에서 바깥쪽으로 밀어냄 (회전바가 다가와서 파묻히는 것 방지)
        const dxseg = o.x2 - o.x1, dyseg = o.y2 - o.y1;
        const lenSq = dxseg * dxseg + dyseg * dyseg;
        let t = lenSq > 0 ? ((p.x - o.x1) * dxseg + (p.y - o.y1) * dyseg) / lenSq : 0;
        t = Math.max(0, Math.min(1, t));
        const cx = o.x1 + t * dxseg, cy = o.y1 + t * dyseg;
        let ux = p.x - cx, uy = p.y - cy;
        const d2 = Math.hypot(ux, uy) || 0.0001;
        ux /= d2; uy /= d2;
        const pushedX = Math.min(0.97, Math.max(0.03, cx + ux * (minDist + 0.01)));
        const pushedY = Math.min(0.97, Math.max(0.03, cy + uy * (minDist + 0.01)));
        if (!isWallBlocked(pushedX, pushedY, obstacles.filter(x => x !== o), PLAYER_R)) {
          p.x = pushedX; p.y = pushedY;
        }
      }
    }
  }
}

function broadcast() {
  const stage = STAGES[currentStageIndex];
  const list = [...players.values()].map(p => ({
    id: p.id, nickname: p.nickname, x: p.x, y: p.y,
    finished: p.finished, rank: p.rank, isBot: !!p.isBot, eliminated: !!p.eliminated
  }));
  io.emit('state', {
    players: list,
    goal: stage.goal,
    obstacles: resolveObstacles(stage.raw, Date.now()),
    started: gameStarted,
    stageIndex: currentStageIndex,
    stageLabel: stage.label,
    isLastStage: currentStageIndex === STAGES.length - 1,
  });
}

setInterval(tick, TICK_MS);
setInterval(broadcast, BROADCAST_MS);

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
      // 이미 1라운드가 지났거나 진행 중인데 새로 들어온 경우: 공정성을 위해 관전자로 처리
      if (currentStageIndex > 0) p.eliminated = true;
      players.set(cid, p);
    }
    socket.data.clientId = cid;
    const stage = STAGES[currentStageIndex];
    socket.emit('joined', {
      id: cid, finished: p.finished, rank: p.rank, started: gameStarted,
      eliminated: p.eliminated, stageLabel: stage.label
    });
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
    for (const p of players.values()) {
      if (p.eliminated) continue;
      p.finished = false;
      p.rank = null;
      const pos = spawnPos();
      p.x = pos.x; p.y = pos.y;
    }
    gameStarted = true;
    io.emit('game:start');
  });

  socket.on('host:advance', () => {
    const active = [...players.entries()].filter(([, p]) => !p.eliminated);
    const goal = STAGES[currentStageIndex].goal;
    active.sort((a, b) => {
      const pa = a[1], pb = b[1];
      if (pa.finished && pb.finished) return pa.rank - pb.rank;
      if (pa.finished) return -1;
      if (pb.finished) return 1;
      const da = Math.hypot(pa.x - goal.x, pa.y - goal.y);
      const db = Math.hypot(pb.x - goal.x, pb.y - goal.y);
      return da - db;
    });

    if (currentStageIndex >= STAGES.length - 1) {
      const champion = active[0];
      if (champion) io.emit('champion', { id: champion[0], nickname: champion[1].nickname });
      return;
    }

    const keepCount = Math.max(1, Math.ceil(active.length / 2));
    const eliminatedIds = [];
    active.forEach(([cid, p], idx) => {
      if (idx >= keepCount) { p.eliminated = true; eliminatedIds.push(cid); }
    });
    io.emit('eliminated', { ids: eliminatedIds });

    currentStageIndex += 1;
    gameStarted = false;
    for (const p of players.values()) {
      if (p.eliminated) continue;
      p.finished = false;
      p.rank = null;
      const pos = spawnPos();
      p.x = pos.x; p.y = pos.y;
    }
    io.emit('stage:change', { index: currentStageIndex, label: STAGES[currentStageIndex].label, isLastStage: currentStageIndex === STAGES.length - 1 });
  });

  socket.on('host:reset', () => {
    currentStageIndex = 0;
    gameStarted = false;
    for (const [cid, p] of [...players.entries()]) {
      if (p.isBot) { players.delete(cid); continue; }
      p.finished = false;
      p.rank = null;
      p.eliminated = false;
      const pos = spawnPos();
      p.x = pos.x; p.y = pos.y;
    }
    io.emit('reset', { stageLabel: STAGES[0].label });
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
