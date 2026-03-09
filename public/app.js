const scoreEl = document.getElementById('score');
const mistakesEl = document.getElementById('mistakes');
const playersEl = document.getElementById('players');
const statusEl = document.getElementById('status');
const boardEl = document.getElementById('board');
const boardWrapperEl = document.getElementById('board-wrapper');
const deselectEl = document.getElementById('deselect');
const settingsCogEl = document.getElementById('settings-cog');
const settingsMenuEl = document.getElementById('settings-menu');
const resetGameEl = document.getElementById('reset-game');

let ws;
let clientId = null;
let state = null;
let tileButtons = new Map();
let fireworksRunning = false;
let boardOffsetX = 0;
let boardOffsetY = 0;
let spaceHeld = false;
let panPointerId = null;
let panStartX = 0;
let panStartY = 0;
let panOriginX = 0;
let panOriginY = 0;
let panDragged = false;
let suppressClicksUntil = 0;

connect();
applyBoardOffset();

function connect() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${window.location.host}/ws`);

  ws.addEventListener('open', () => {
    statusEl.textContent = 'Connected';
  });

  ws.addEventListener('close', () => {
    statusEl.textContent = 'Disconnected. Reconnecting...';
    setTimeout(connect, 1000);
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'init') {
      clientId = msg.clientId;
      state = msg.state;
      ensureBoard(state.boardSize);
      renderAll();
      return;
    }

    if (msg.type === 'state') {
      state = msg.state;
      ensureBoard(state.boardSize);
      renderAll();
      handleEvent(msg.event);
      return;
    }

    if (msg.type === 'presence') {
      playersEl.textContent = String(msg.players);
    }
  });
}

function ensureBoard(size) {
  if (boardEl.dataset.size === String(size) && tileButtons.size === size * size) {
    return;
  }

  boardEl.innerHTML = '';
  tileButtons = new Map();

  for (let row = 0; row < size; row += 1) {
    const tr = document.createElement('tr');
    for (let col = 0; col < size; col += 1) {
      const index = row * size + col;
      const cellId = `c${index}`;

      const td = document.createElement('td');
      td.dataset.cellId = cellId;

      const button = document.createElement('button');
      button.className = 'tile';
      button.type = 'button';
      button.dataset.cellId = cellId;
      button.addEventListener('click', () => send({ type: 'select', cellId }));

      td.appendChild(button);
      tr.appendChild(td);
      tileButtons.set(cellId, button);
    }
    boardEl.appendChild(tr);
  }

  boardEl.dataset.size = String(size);
}

function renderAll() {
  if (!state) {
    return;
  }

  scoreEl.textContent = String(state.score);
  mistakesEl.textContent = String(state.mistakes);

  const selectedId = state.selections?.[clientId] || null;
  deselectEl.disabled = !selectedId;

  for (const cell of state.cells) {
    const button = tileButtons.get(cell.id);
    if (!button) {
      continue;
    }

    const td = button.parentElement;
    if (cell.removed) {
      td.style.display = 'none';
      button.disabled = true;
      button.style.visibility = 'hidden';
      button.classList.remove('selected', 'completed');
      continue;
    }

    td.style.display = '';
    button.style.visibility = 'visible';
    button.disabled = false;
    button.classList.toggle('selected', selectedId === cell.id);

    const clusterSize = cell.cluster.length;
    button.classList.toggle('completed', clusterSize === 45);

    if (clusterSize === 45) {
      button.style.background = stringToLightColor(cell.category);
      button.innerHTML = `<b>${escapeHtml(cell.category)}</b>`;
      button.title = '';
      continue;
    }

    button.style.background = '';

    if (clusterSize === 1) {
      button.textContent = cell.cluster[0];
      button.title = '';
    } else if (clusterSize === 2) {
      button.innerHTML = `<b>${escapeHtml(cell.cluster.join('; '))}</b>`;
      button.title = '';
    } else {
      const label = `${escapeHtml(cell.cluster[0])}, ${escapeHtml(cell.cluster[1])}, ... <span class="red">[${clusterSize}]</span>`;
      button.innerHTML = `<b>${label}</b>`;
      button.title = cell.cluster.join('\n');
    }
  }
}

function handleEvent(event) {
  if (!event) {
    return;
  }

  if (event.type === 'mismatch') {
    const a = tileButtons.get(event.a);
    const b = tileButtons.get(event.b);
    if (a) {
      shake(a);
    }
    if (b) {
      shake(b);
    }
    return;
  }

  if (event.type === 'reset') {
    statusEl.textContent = 'Game reset';
    stopFireworks();
    return;
  }

  if (event.type === 'merge' && event.winner) {
    statusEl.textContent = 'You win!';
    startFireworks();
  }
}

function send(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(payload));
}

deselectEl.addEventListener('click', () => send({ type: 'deselect' }));

settingsCogEl.addEventListener('click', () => {
  settingsMenuEl.classList.toggle('hidden');
});

window.addEventListener('click', (event) => {
  if (settingsMenuEl.classList.contains('hidden')) {
    return;
  }
  if (event.target === settingsCogEl || settingsMenuEl.contains(event.target)) {
    return;
  }
  settingsMenuEl.classList.add('hidden');
});

resetGameEl.addEventListener('click', () => {
  settingsMenuEl.classList.add('hidden');
  if (window.confirm('Reset the game for all players?')) {
    send({ type: 'reset' });
  }
});

window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space') {
    return;
  }
  event.preventDefault();
  if (spaceHeld) {
    return;
  }
  spaceHeld = true;
  document.body.classList.add('space-pan-ready');
});

window.addEventListener('keyup', (event) => {
  if (event.code !== 'Space') {
    return;
  }
  event.preventDefault();
  spaceHeld = false;
  document.body.classList.remove('space-pan-ready');
  endPan();
});

window.addEventListener('blur', () => {
  spaceHeld = false;
  document.body.classList.remove('space-pan-ready');
  endPan();
});

document.addEventListener('pointerdown', (event) => {
  if (!spaceHeld || event.button !== 0 || !boardWrapperEl.contains(event.target)) {
    return;
  }
  startPan(event);
});

window.addEventListener('pointermove', (event) => {
  if (event.pointerId !== panPointerId) {
    return;
  }

  const dx = event.clientX - panStartX;
  const dy = event.clientY - panStartY;
  boardOffsetX = panOriginX + dx;
  boardOffsetY = panOriginY + dy;
  panDragged ||= Math.abs(dx) + Math.abs(dy) > 4;
  applyBoardOffset();
});

window.addEventListener('pointerup', (event) => {
  if (event.pointerId !== panPointerId) {
    return;
  }
  endPan();
});

window.addEventListener('pointercancel', (event) => {
  if (event.pointerId !== panPointerId) {
    return;
  }
  endPan();
});

boardEl.addEventListener(
  'click',
  (event) => {
    if (performance.now() < suppressClicksUntil) {
      event.preventDefault();
      event.stopPropagation();
    }
  },
  true
);

function shake(el) {
  el.classList.add('shake');
  el.addEventListener(
    'animationend',
    () => {
      el.classList.remove('shake');
    },
    { once: true }
  );
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function stringToLightColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }

  const h = Math.abs(hash) % 360;
  const s = 70;
  const l = 80 + (Math.abs(hash) % 10);

  const lDev = l / 100;
  const a = (s * Math.min(lDev, 1 - lDev)) / 100;

  const f = (n) => {
    const k = (n + h / 30) % 12;
    const color = lDev - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0');
  };

  return `#${f(0)}${f(8)}${f(4)}`;
}

function startFireworks() {
  if (fireworksRunning) {
    return;
  }
  fireworksRunning = true;

  const canvas = document.getElementById('fireworks');
  const ctx = canvas.getContext('2d');
  let width;
  let height;
  let particles = [];
  let fireworks = [];

  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  }

  window.addEventListener('resize', resize);
  resize();

  class Firework {
    constructor() {
      this.x = Math.random() * width;
      this.y = height;
      this.tx = Math.random() * width;
      this.ty = Math.random() * (height / 2);
      this.color = `hsl(${Math.random() * 360}, 100%, 50%)`;
      this.speed = 2 + Math.random() * 2;
      this.angle = Math.atan2(this.ty - this.y, this.tx - this.x);
      this.vx = Math.cos(this.angle) * this.speed;
      this.vy = Math.sin(this.angle) * this.speed;
      this.exploded = false;
    }

    update() {
      this.x += this.vx;
      this.y += this.vy;
      if (this.y < this.ty) {
        this.explode();
      }
    }

    explode() {
      this.exploded = true;
      for (let i = 0; i < 50; i += 1) {
        particles.push(new Particle(this.x, this.y, this.color));
      }
    }

    draw() {
      ctx.beginPath();
      ctx.arc(this.x, this.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      ctx.fill();
    }
  }

  class Particle {
    constructor(x, y, color) {
      this.x = x;
      this.y = y;
      this.color = color;
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 3;
      this.vx = Math.cos(angle) * speed;
      this.vy = Math.sin(angle) * speed;
      this.alpha = 1;
      this.decay = Math.random() * 0.015 + 0.005;
    }

    update() {
      this.x += this.vx;
      this.y += this.vy;
      this.vy += 0.05;
      this.alpha -= this.decay;
    }

    draw() {
      ctx.save();
      ctx.globalAlpha = this.alpha;
      ctx.beginPath();
      ctx.arc(this.x, this.y, 2, 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      ctx.fill();
      ctx.restore();
    }
  }

  function loop() {
    if (!fireworksRunning) {
      ctx.clearRect(0, 0, width, height);
      return;
    }

    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'lighter';

    if (Math.random() < 0.05) {
      fireworks.push(new Firework());
    }

    for (let i = fireworks.length - 1; i >= 0; i -= 1) {
      fireworks[i].update();
      fireworks[i].draw();
      if (fireworks[i].exploded) {
        fireworks.splice(i, 1);
      }
    }

    for (let i = particles.length - 1; i >= 0; i -= 1) {
      particles[i].update();
      particles[i].draw();
      if (particles[i].alpha <= 0) {
        particles.splice(i, 1);
      }
    }

    requestAnimationFrame(loop);
  }

  loop();
}

function stopFireworks() {
  fireworksRunning = false;
}

function applyBoardOffset() {
  boardWrapperEl.style.transform = `translate(${boardOffsetX}px, ${boardOffsetY}px)`;
}

function startPan(event) {
  panPointerId = event.pointerId;
  panStartX = event.clientX;
  panStartY = event.clientY;
  panOriginX = boardOffsetX;
  panOriginY = boardOffsetY;
  panDragged = false;
  document.body.classList.add('panning');
  event.preventDefault();
}

function endPan() {
  if (panPointerId === null) {
    return;
  }
  if (panDragged) {
    suppressClicksUntil = performance.now() + 80;
  }
  panPointerId = null;
  panDragged = false;
  document.body.classList.remove('panning');
}
