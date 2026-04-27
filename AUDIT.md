# AI_Village Repo Audit

A snapshot of the codebase's known issues and their current status. Items are
grouped by remaining severity. Resolved entries are listed at the bottom for
historical reference. Severity is the auditor's estimate of impact, not a
user-reported priority.

This document supersedes the April 2026 audit; most entries from that pass
have since been merged.

---

## Open — High

### `src/app.js` is still a single ~4,900-line module
- **Where**: `src/app.js`
- **Status**: Significant progress. Pathfinding, save/load, UI/pointer input,
  rendering helpers, world/building data, and time-of-day/experience helpers
  have been carved out into `src/app/{pathfinding,save,ui,render,world,simulation}.js`.
  What remains is the AI tick, job system, planner glue, building-specific
  behavior, and boot wiring.
- **Why it matters**: The remaining file still owns module-local mirrors of
  `gameState` arrays (`buildings`, `villagers`, `jobs`, `animals`,
  `itemsOnGround`) and a property-getter/setter for `world`. Most of the
  trickier remaining items below trace back to that coupling.
- **Suggested next pass**: Extract the planner (`planZones` /
  `planBuildings` / `generateJobs`) and the AI tick (`villagerTick`) into
  their own modules, taking explicit `gameState`/`policy` parameters rather
  than closing over module-locals.

### Simulation tick interleaved with render
- **Where**: `src/app.js:4816` (`update()`) calls `villagerTick()`,
  `updateAnimals()`, `seasonTick()`, etc. inside the same RAF callback that
  ends with `render()`. `saveGame()` (now in `src/app/save.js:41`) reads
  `gameState` directly when invoked.
- **Why it matters**: Today the manual save button is the only save path so
  the practical risk is bounded — JS is single-threaded and save fires
  between RAF frames. But anything we add that triggers saves from a hook,
  timer, or event listener could observe partial state (e.g. resource
  debited from `storageReserved` before the receiving job updates).
- **Suggested**: Split simulation tick from render with a fixed-timestep
  loop and a frozen snapshot for save, or queue saves to fire between
  ticks. Either path becomes easier once the planner/tick extraction
  above lands.

---

## Open — Medium

### `inspectJobs` in `src/ai/blackboard.js` overlaps with `policy.caps.buildWaiting`
- **Where**: `src/ai/blackboard.js:85-99` checks
  `job.waitingForMaterials !== true` to set `buildPush`; the same concept is
  encoded in `policy.caps.buildWaiting` (`src/policy/policy.js:151`).
- **Suggested**: Pick one source of truth — either feed `buildPush` from
  `caps.buildWaiting`, or remove the cap and rely on the blackboard signal.

### Duplicated experience constants
- **Where**: `JOB_EXPERIENCE_MAP` and `EXPERIENCE_THRESHOLDS` are defined in
  both `src/ai/scoring.js:6-18` and `src/app/simulation.js:9-22`. The
  `simulation.js` copy includes `socialize: 'social'`; the `scoring.js`
  copy does not.
- **Why it matters**: Adding a new job type means editing both. The
  divergence (`socialize`) is currently benign because it's tracked as a
  villager state, not a scored job, but a future change could drift them
  silently.
- **Suggested**: Hoist both constants to a shared module (probably
  `src/app/simulation.js`) and import from `scoring.js`.

### Canvas/lightmap context release on world swap
- **Where**: `src/app.js` `newWorld()` reassigns `world.lightmapCanvas`/
  `world.lightmapCtx`. `src/app/canvas.js:63` keeps a module-level `ctx`
  singleton for the main canvas (correct — the main canvas is module-lifetime).
- **Why it matters**: The world's offscreen lightmap canvas/context can
  only be GCed once every closure that captured them releases. With the
  bind/unbind UI listener lifecycle now landed, the practical leak is
  small, but anything that captures `world.lightmapCtx` directly (rather
  than re-reading `gameState.world.lightmapCtx`) will keep the prior swap
  alive.
- **Suggested**: Audit closures over `world.lightmap*`; prefer reading
  through `gameState.world` at call time.

### `index.html` `<script>` tags depend on Vite `base` accidentally
- **Where**: `index.html:8-12` references `bootstrap.js` and `worldgen/*.js`
  with relative URLs that resolve correctly in both `dev` (`base=/`) and
  prod (`base=/AI_Village/`) because none of those scripts have internal
  asset references.
- **Status**: Documented via a header comment at the top of each `public/`
  script. If any of those scripts ever needs `fetch(...)` or `<img src=...>`
  against a relative URL, the constraint will need to be revisited
  (probably by moving the bootstrap into a module).

---

## Open — Low

### No automated tests
- The repo has lint and build but no test runner. A smoke test (e.g.
  `vitest` plus a single "boot the world headless" assertion) would
  catch a lot of the closure-over-stale-state regressions the items
  above worry about.

### Lint not gated in CI
- `npm run lint` is wired in `package.json`, but the `deploy-pages`
  workflow only runs `npm ci && npm run build`. Lint regressions can
  land on `main` undetected. Add a `lint` step to the workflow (or a
  separate `ci.yml`).

---

## Resolved (since the April 2026 audit)

For historical reference. Each item below was an open finding in the
prior audit; the linked file/line is where the fix lives.

- **CDN fallback in `public/bootstrap.js`** — restructured into a
  promise + 5 s reject + `terrain.js` resolves
  `__AIV_WORLDGEN_RESOLVE__`; both helpers null themselves after the
  first call.
- **`clamp()` correctness in `src/ai/scoring.js:20`** — non-finite
  inputs return `min`.
- **`FARM_JOB_TYPES` mismatch** — `src/ai/blackboard.js:10` and
  `src/ai/scoring.js:3` both include `'forage'`.
- **`policy.caps.buildWaiting` signature** —
  `src/policy/policy.js:151` accepts the four positional args its call
  site passes.
- **`loadGame()` array normalization** — every layer is normalized
  upfront with length validation in `src/app/save.js:107-132`.
- **`policy.attach()` silent fallback** — now warns when
  `state.population.priorities` is malformed and additionally rejects
  arrays (`src/policy/policy.js:140-147`).
- **Storage load type validation** — `storageTotals` /
  `storageReserved` use `Number.isFinite` per field
  (`src/app/save.js:170-179`), consistent with the rest of the file.
- **Listener lifecycle on `newWorld()`** — UI buttons / document /
  canvas / window listeners are unbound at the start of `newWorld()`
  and rebound at the end (`src/app.js:1011-1012, 1170-1171` calling
  the bind/unbind pair in `src/app/ui.js:152-298`). `resize` and the
  global `error`/`unhandledrejection` listeners are intentionally
  module-lifetime and are documented as such at their declaration site.
- **Stale module-local arrays after `newWorld()`** —
  `jobs.length=0; buildings.length=0; itemsOnGround.length=0;
  animals.length=0;` mutate in place (`src/app.js:1016`); `world` is
  fronted by a getter/setter on `gameState`.
- **Save schema migration framework** — `SAVE_MIGRATIONS` map in
  `src/app/constants.js:74` plus the sequential migration loop at
  `src/app/save.js:99-105`. The map is empty today; adding an entry
  for `v -> v+1` is sufficient to handle a future schema bump.
- **Lazy villager Maps hydrated on load** — `_wanderFailures` and
  `_forageFailures` are seeded as `new Map()` in the load path
  (`src/app/save.js:208`).
- **Item tile index rebuild gating** — `if(itemTileIndexDirty)
  rebuildItemTileIndex();` runs at the top of the per-villager loop in
  `update()` (`src/app.js:4861`), independent of villager inventory.
- **Worldgen ↔ ES module boot race** — `bootstrap.js` installs
  `AIV_WORLDGEN_READY` before any `<script defer>` evaluates;
  `terrain.js` resolves it; `src/main.js:34` `await`s the promise
  instead of polling.
- **Two boot timeouts** — coordinated. The `AIV_WORLDGEN_READY`
  promise rejects at 5 s; the "JS NOT RUNNING" message in `bootstrap.js`
  fires at 6 s and is suppressed if `__AIV_BOOT__` or
  `__AIV_BOOT_FAILED__` is set, so the user no longer sees a stale
  message after a clean failure.
- **Pointer state race in `endPointer()`** — `endPointer` checks
  `activePointers.has(e.pointerId)` and only clears `primaryPointer`
  when the leaving pointer matches (`src/app/ui.js:262-267`).
- **`dayTime` "shadowed"** — the variable was misread as redundant in
  the prior audit; it's actually the backing storage for the
  `time.dayTime` getter/setter pair (`src/app.js:307-348`).
- **Redundant `computeFamineSeverity()`** — computed once and reused
  (`src/ai/scoring.js:206`).
- **Redundant `|| job.type === 'harvest'`** — dropped;
  `FARM_JOB_TYPES` already contains `'harvest'`
  (`src/ai/scoring.js:234`).
- **Loose-equality cleanup in `public/debugkit.js`** — landed earlier.
- **No lint pipeline** — `eslint.config.js` plus `npm run lint`
  (`package.json:9`).
- **`.gpagesignore`** — deleted; the deploy workflow
  (`.github/workflows/deploy-pages.yml`) uploads `dist/` directly.
- **README inaccuracy about the deploy workflow** — `README.md:10-18`
  now correctly describes `npm run build` + `dist/` upload.
- **Loose typing of seed in `loadGame`** —
  `newWorld(Number.isFinite(d.seed) ? d.seed : undefined)`
  (`src/app/save.js:133`).
- **Bootstrap helper cleanup** — `__AIV_WORLDGEN_RESOLVE__`/`REJECT__`
  null themselves after the first call so the closure can GC and
  double-calls are no-ops (`public/bootstrap.js:14-39`).
- **Diagnostic `console.log` on every load** — the
  `"AIV Phase1 perf build"` log is now gated on
  `import.meta.env?.DEV` (`src/app.js:72-74`) so prod consoles stay
  clean while local dev still gets the bundle-ran confirmation.
- **Unused ES exports retained as a debug surface** — the duplicate
  `export { setShadingMode, ... }` at the bottom of `src/app.js` has
  been dropped. The helpers remain reachable through the
  `window.AIV_APP` global installed at `src/app.js:3988-4005`, which
  is what DebugKit already uses; the comment at `src/app.js:4012-4017`
  pins that contract.
