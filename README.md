# 2025 Multiplayer

Multiplayer adaptation of the original 2025 game by Thomas Colthurst:
- Original: https://thomaswc.com/2025.html
- License note in source: CC BY-SA 4.0

## Features
- Backend-authoritative game state
- Real-time multiplayer updates via WebSocket
- Persistent game state in `data/game-state.json` across restarts
- Settings cog (top-right) with global reset action

## Run

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## Notes
- Score target is 1980 (same as original: combine 2025 words down to 45 groups).
- All players share one board and one score.
