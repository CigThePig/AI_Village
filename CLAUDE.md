# CLAUDE.md

Orientation for Claude Code sessions working in this repo. Keep it short; update when something here goes stale.

## Project overview

- Static Vite app for a pixel-art village simulation, deployed to GitHub Pages at `/AI_Village/` (see `vite.config.js`, `.github/workflows/deploy-pages.yml`).
- Runtime is the browser; tests run on Node's built-in test runner (`node --test`).
- DebugKit overlay is served from `public/debugkit.js` and enabled via `?debug=1` or `localStorage.debug = 'true'`. See `README.md` for details.

## Common commands

From `package.json`:

- `npm run dev` — Vite dev server.
- `npm run build` — production bundle into `dist/`.
- `npm run preview` — preview the production bundle.
- `npm run lint` — ESLint across the repo (config: `eslint.config.js`).
- `npm test` — `node --test tests/**/*.test.js`.

After every change inside a phase, run `npm run lint && npm test` (mirrors the cross-cutting requirement in `AI_VILLAGE_PLAN.md`).

## Repo map

- `src/app.js` — top-level wiring; constructs systems and runs the tick loop.
- `src/app/` — engine modules:
  - `constants.js` — grid dims, `SAVE_KEY`, `SAVE_VERSION`, `SAVE_MIGRATIONS`, tile/zone enums.
  - `save.js` — `createSaveSystem({ saveGame, loadGame })`.
  - `tick.js` — fixed-step tick scheduler; folds `SPEEDS[speedIdx]` into `dt` (relevant to Phase 2's villager-speed double-application, audit B11).
  - `villagerTick.js`, `villagerAI.js`, `onArrive.js`, `population.js`, `planner.js`, `jobs.js`, `materials.js`, `storage.js`, `world.js`, `animals.js`, `pathfinding.js`, `nocturnal.js`, `simulation.js`, `environment.js`, `lighting.js`, `render.js`, `canvas.js`, `tileset.js`, `ui.js`, `debugkit.js`, `rng.js`.
- `src/ai/` — `blackboard.js`, `scoring.js`.
- `src/policy/policy.js` — tunables (rest thresholds, scoring weights, etc.).
- `src/state.js` — `createInitialState()` factory.
- `src/main.js`, `src/config.js` — entry / config.
- `tests/` — Node-runner tests (`*.test.js`). Add new tests here as each phase requires.
- `public/`, `index.html`, `styles.css`, `vite.config.js` — static assets and build config.
- `AI_VILLAGE_PLAN.md` — phased feature plan; the **active work plan**.

## Working rules

### Active plan

We are executing `AI_VILLAGE_PLAN.md`. Default to that document for scope, ordering, and acceptance criteria. Phases are intentionally separate PRs — do not combine phases.

The current objective: villagers should feel more intelligent and interesting to watch, with richer environmental interaction; building and crop placement should not feel ugly or random; every settlement should look different but coherent. The plan ships 5 phases that upgrade existing logic, 5 that extend current content, and 2 that introduce new content.

### Save-format compatibility (project rule)

- **Old save files do not need to be preserved. New save formats are allowed to break old saves.**
- When the schema changes, bump `SAVE_VERSION` in `src/app/constants.js`. A no-op or coercion entry in `SAVE_MIGRATIONS` is enough; a faithful migration is *not* required. If a save can't be loaded, returning `false` from `loadGame` (so the game starts fresh) is acceptable.
- **This rule overrides any conflicting guidance in future plans or audit notes.** If a later phase or task asks for backwards-compatible save migrations, treat that requirement as superseded by this rule unless the user explicitly reinstates it.
- Most phases in `AI_VILLAGE_PLAN.md` change persisted shape and bump `SAVE_VERSION`; the migration entry can simply drop the affected sub-tree.

### Code style

- ES modules, vanilla JS, no TypeScript. Browser globals plus project globals are declared in `eslint.config.js`. Keep `npm run lint` clean.
- Follow existing patterns in the touched module rather than introducing new abstractions.
- Keep comments minimal; explain *why*, not *what* (matches the codebase's existing style — see audit-tagged comments like `// audit #21`).

### Scope discipline

- Each phase ships as one focused PR with the tests it specifies. Don't fold in opportunistic refactors from other phases.
- Acceptance criteria in `AI_VILLAGE_PLAN.md` are the bar — including the per-phase anti-corner-cut clauses on visible/coherent behavior.

## Quick references

- DebugKit and Pages deployment: see `README.md`.
- Save format constants: `src/app/constants.js` (`SAVE_KEY`, `SAVE_VERSION`, `SAVE_MIGRATIONS`).
- Time/tick model: `src/app/tick.js` and `src/app/simulation.js` (`createTimeOfDay`).
