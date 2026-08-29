const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---- 게임 설정 (필요에 맞게 조정) ----
const GOAL = { x: 0.5, y: 0.1, r: 0.07 };
const OBSTACLES = [
  // 화면 비율(0~1) 기준 슬로우존 / 벽. type: 'wall' | 'slow'
  { type: 'wall', x: 0.15, y: 0.45, w: 0.28, h: 0.05 },
  { type: 'wall', x: 0.57, y: 0.45, w: 0.28, h: 0.05 },
  { type: 'slow', x: 0.3, y: 0.65, w: 0.4, h: 0.1, factor: 0.35 },
];
const BASE_SPEED = 0.011;
const TICK_MS = 50;      // 서버 위치 갱신 주기 (20fps)
const BROADCAST_MS = 66; // 대형화면 전송 주기 (~15fps)

const players = new Map(); // socketId -> player

function rectHit(x, y, o) {
  return x > o.x && x < o.x + o.w && y > o.y && y < o.y + o.h;
}

function tick() {
  let dirty = false;
  for (const p of players.values()) {
    if (p.finished) continue;
    let dx = 0, dy = 0;
    if (p.input.up) dy -= 1;
    if (p.input.down) dy += 1;
    if (p.input.left) dx -= 1;
    if (p.input.right) dx += 1;
    if (dx === 0 && dy === 0) continue;
    const len = Math.hypot(dx, dy) || 1;

    let speed = BASE_SPEED;
    for (const o of OBSTACLES) {
      if (o.type === 'slow' && rectHit(p.x, p.y, o)) speed *= o.factor;
    }

    const nx = Math.min(0.97, Math.max(0.03, p.x + (dx / len) * speed));
    const ny = Math.min(0.97, Math.max(0.03, p.y + (dy / len) * speed));

    const blocked = OBSTACLES.some(o => o.type === 'wall' && rectHit(nx, ny, o));
    if (!blocked) {
      p.x = nx; p.y = ny;
      dirty = true;
    }

    const distToGoal = Math.hypot(p.x - GOAL.x, p.y - GOAL.y);
    if (distToGoal < GOAL.r) {
      p.finished = true;
      p.rank = [...players.values()].filter(q => q.finished).length;
      io.emit('arrived', { nickname: p.nickname, rank: p.rank });
    }
  }
}

function broadcast() {
  const list = [...players.values()].map(p => ({
    id: p.id, nickname: p.nickname, x: p.x, y: p.y, finished: p.finished, rank: p.rank
  }));
  io.emit('state', { players: list, goal: GOAL, obstacles: OBSTACLES });
}

setInterval(tick, TICK_MS);
setInterval(broadcast, BROADCAST_MS);

io.on('connection', (socket) => {
  socket.on('join', (nickname) => {
    const clean = (nickname || '').toString().trim().slice(0, 12) || ('참가자' + socket.id.slice(0, 4));
    players.set(socket.id, {
      id: socket.id,
      nickname: clean,
      x: 0.1 + Math.random() * 0.8,
      y: 0.9 + Math.random() * 0.06,
      input: { up: false, down: false, left: false, right: false },
      finished: false,
      rank: null,
    });
    socket.emit('joined', { id: socket.id });
  });

  socket.on('input', (input) => {
    const p = players.get(socket.id);
    if (!p) return;
    p.input = {
      up: !!input.up, down: !!input.down, left: !!input.left, right: !!input.right
    };
  });

  socket.on('host:reset', () => {
    for (const p of players.values()) {
      p.finished = false;
      p.rank = null;
      p.x = 0.1 + Math.random() * 0.8;
      p.y = 0.9 + Math.random() * 0.06;
    }
    io.emit('reset');
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('서버 실행 중: ' + PORT));
