const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const BOARD_SIZE = 45;
const WIN_SCORE = (BOARD_SIZE * BOARD_SIZE) - BOARD_SIZE;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const categories = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'categories.json'), 'utf8')
);
const statePath = path.join(__dirname, 'data', 'game-state.json');

let gameState = loadOrCreateState();
let nextPlayerNumber = 1;

app.use(express.static(path.join(__dirname, 'public')));

wss.on('connection', (ws) => {
  const clientId = crypto.randomUUID();
  const playerNumber = nextPlayerNumber;
  nextPlayerNumber += 1;

  gameState.players[clientId] = {
    id: clientId,
    number: playerNumber,
    name: defaultPlayerName(playerNumber)
  };
  gameState.selections[clientId] = null;
  gameState.viewports[clientId] = null;

  ws.send(JSON.stringify({
    type: 'init',
    clientId,
    state: publicState()
  }));

  broadcast({ type: 'state', state: publicState() });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }

    if (msg.type === 'select') {
      handleSelect(clientId, String(msg.cellId || ''));
      return;
    }

    if (msg.type === 'deselect') {
      gameState.selections[clientId] = null;
      broadcast({ type: 'state', state: publicState() });
      return;
    }

    if (msg.type === 'reset') {
      resetGame();
      broadcast({ type: 'state', state: publicState(), event: { type: 'reset', by: clientId } });
      return;
    }

    if (msg.type === 'set-name') {
      const player = gameState.players[clientId];
      if (!player) {
        return;
      }
      player.name = normalizePlayerName(msg.name, player.number);
      broadcast({ type: 'state', state: publicState() });
      return;
    }

    if (msg.type === 'viewport') {
      gameState.viewports[clientId] = normalizeViewport(msg.viewport);
      broadcast({ type: 'state', state: publicState() });
    }
  });

  ws.on('close', () => {
    delete gameState.selections[clientId];
    delete gameState.players[clientId];
    delete gameState.viewports[clientId];
    broadcast({ type: 'state', state: publicState() });
  });
});

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});

function handleSelect(clientId, cellId) {
  const target = findCell(cellId);
  if (!target || target.removed) {
    gameState.selections[clientId] = null;
    broadcast({ type: 'state', state: publicState() });
    return;
  }

  const selectedId = gameState.selections[clientId];
  if (!selectedId || selectedId === cellId) {
    gameState.selections[clientId] = selectedId === cellId ? null : cellId;
    broadcast({ type: 'state', state: publicState() });
    return;
  }

  const first = findCell(selectedId);
  const second = target;

  if (!first || first.removed || second.removed || first.id === second.id) {
    gameState.selections[clientId] = null;
    broadcast({ type: 'state', state: publicState() });
    return;
  }

  if (first.category === second.category) {
    second.cluster = second.cluster.concat(first.cluster);
    first.cluster = [];
    first.removed = true;

    gameState.score += 1;
    gameState.selections[clientId] = null;

    clearRemovedSelections();
    persistState();

    const event = {
      type: 'merge',
      by: clientId,
      winner: gameState.score >= WIN_SCORE,
      category: first.category
    };

    broadcast({ type: 'state', state: publicState(), event });
    return;
  }

  gameState.mistakes += 1;
  gameState.selections[clientId] = null;
  persistState();

  broadcast({
    type: 'state',
    state: publicState(),
    event: { type: 'mismatch', by: clientId, a: first.id, b: second.id }
  });
}

function publicState() {
  return {
    boardSize: gameState.boardSize,
    score: gameState.score,
    mistakes: gameState.mistakes,
    cells: gameState.cells,
    selections: gameState.selections,
    players: gameState.players,
    viewports: gameState.viewports
  };
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(data);
    }
  }
}

function resetGame() {
  const existingPlayers = gameState.players;
  const existingViewports = gameState.viewports;
  gameState = createNewState();
  gameState.players = existingPlayers;
  gameState.viewports = existingViewports;
  for (const clientId of Object.keys(existingPlayers)) {
    gameState.selections[clientId] = null;
  }
  persistState();
}

function clearRemovedSelections() {
  for (const [clientId, selectedId] of Object.entries(gameState.selections)) {
    if (!selectedId) {
      continue;
    }
    const selected = findCell(selectedId);
    if (!selected || selected.removed) {
      gameState.selections[clientId] = null;
    }
  }
}

function findCell(cellId) {
  return gameState.cellsById[cellId] || null;
}

function createNewState() {
  const words = [];
  for (const [category, entries] of Object.entries(categories)) {
    if (!Array.isArray(entries) || entries.length < BOARD_SIZE) {
      throw new Error(`Category \"${category}\" has fewer than ${BOARD_SIZE} entries`);
    }
    for (let i = 0; i < BOARD_SIZE; i += 1) {
      words.push({ word: entries[i], category });
    }
  }

  shuffleInPlace(words);

  const cells = words.map((entry, index) => ({
    id: `c${index}`,
    category: entry.category,
    cluster: [entry.word],
    removed: false
  }));

  const cellsById = Object.create(null);
  for (const cell of cells) {
    cellsById[cell.id] = cell;
  }

  return {
    boardSize: BOARD_SIZE,
    score: 0,
    mistakes: 0,
    cells,
    cellsById,
    selections: {},
    players: {},
    viewports: {}
  };
}

function shuffleInPlace(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

function loadOrCreateState() {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return inflateState(parsed);
  } catch (_) {
    const fresh = createNewState();
    persistState(fresh);
    return fresh;
  }
}

function inflateState(parsed) {
  if (!parsed || !Array.isArray(parsed.cells)) {
    throw new Error('Invalid persisted state');
  }

  const cellsById = Object.create(null);
  for (const cell of parsed.cells) {
    cellsById[cell.id] = cell;
  }

  return {
    boardSize: parsed.boardSize || BOARD_SIZE,
    score: Number(parsed.score || 0),
    mistakes: Number(parsed.mistakes || 0),
    cells: parsed.cells,
    cellsById,
    selections: {},
    players: {},
    viewports: {}
  };
}

function persistState(overrideState) {
  const snapshot = overrideState || gameState;
  const serializable = {
    boardSize: snapshot.boardSize,
    score: snapshot.score,
    mistakes: snapshot.mistakes,
    cells: snapshot.cells
  };

  const temp = `${statePath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(serializable));
  fs.renameSync(temp, statePath);
}

process.on('SIGINT', () => {
  persistState();
  process.exit(0);
});

process.on('SIGTERM', () => {
  persistState();
  process.exit(0);
});

function defaultPlayerName(playerNumber) {
  return `Player #${playerNumber}`;
}

function normalizePlayerName(name, playerNumber) {
  const cleaned = String(name || '').trim().slice(0, 32);
  return cleaned || defaultPlayerName(playerNumber);
}

function normalizeViewport(input) {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const x = Number(input.x);
  const y = Number(input.y);
  const width = Number(input.width);
  const height = Number(input.height);

  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }

  return {
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width: Math.max(0, Math.round(width)),
    height: Math.max(0, Math.round(height))
  };
}
