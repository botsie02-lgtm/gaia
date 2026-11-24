# GAIA — Simulation-first universe

A runnable seed for GAIA: a tiny top-down pixel world with deterministic agents, finite resources, a communal stockpile and an autonomous hearth-construction process.

## Requirements

- Node.js **22.12+** and npm
- VS Code (optional, recommended)

## Run

```bash
npm install
npm run dev
```

Open the local URL shown by Vite (typically http://localhost:5173). Agents move automatically; use **Pause**, **Step +1**, speed control, and seed regeneration. Click any tile to inspect it.

## Verify

```bash
npm test
npm run typecheck
npm run build
```

**Note:** If you downloaded a ZIP, initialize the Git repository yourself. After `npm install`, commit the generated `package-lock.json` so GitHub CI can use `npm ci`.

## Structure and collaboration

- `AGENTS.md` — collaboration and branching contract for AI/human contributors
- `docs/PROJECT_BRIEF.md` — long-term goals and non-goals
- `docs/ARCHITECTURE.md` — technical layout and deliberate simplifications
- `docs/ROADMAP.md` — milestone checklist

All simulation behaviour is in `src/sim/` and independent from the browser. Rules are seeded and fixed-step; the canvas renders a snapshot and never decides what happens.

## Scope warning

The hearth's burning and heat are simplified accounting. This is **not** a physically realistic forge or a learning artificial intelligence. Both are intentionally later milestones.
