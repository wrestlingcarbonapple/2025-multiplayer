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

app.use(express.static(path.join(__dirname, 'public')));

wss.on('connection', (ws) => {
  const clientId = crypto.randomUUID();

  ws.send(JSON.stringify({
    type: 'init',
    clientId,
    state: publicState()
  }));

  broadcastPresence();

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
  });

  ws.on('close', () => {
    delete gameState.selections[clientId];
    broadcastPresence();
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
    selections: gameState.selections
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

function broadcastPresence() {
  broadcast({ type: 'presence', players: wss.clients.size });
}

function resetGame() {
  gameState = createNewState();
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
    selections: {}
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
    selections: {}
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
