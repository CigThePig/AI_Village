# AI_Village Repo Audit — Deferred Work

This document captures issues identified during a repository-wide audit (April 2026)
that were **not** fixed in the same change. Each entry has a file:line pointer and
a brief description of the problem and a suggested fix direction.

The companion change in this commit landed targeted, surgical fixes for the highest-
impact, lowest-risk items: the jsdelivr CDN fallback in `public/bootstrap.js`,
a `clamp()` correctness bug in `src/ai/scoring.js`, a `FARM_JOB_TYPES` mismatch
between `src/ai/blackboard.js` and `src/ai/scoring.js`, a signature mismatch in
`policy.caps.buildWaiting`, hardening of `loadGame()` array normalization in
`src/app.js`, and a strict-equality cleanup in `public/debugkit.js`.

Severity is the auditor's estimate of impact, not user-reported priority.

---

## Critical — boot, runtime, lifecycle

### `src/app.js` is a 5,840-line monolith
- **Where**: `src/app.js` (entire file)
- **Problem**: One module contains terrain rendering, simulation, pathfinding,
  AI tick, job system, save/load, UI event handlers, lighting, and boot. ~220
  function definitions inline; module-local convenience bindings (`buildings`,
  `villagers`, `jobs`, `animals`, `world`, …) at lines 185–252 lock a particular
  layout in place.
- **Why it matters**: Almost every other item in this document (lifecycle,
  state sync, listener leaks) is a symptom of this. Until the file is split,
  every change risks unintended cross-cutting effects.
- **Suggested**: Carve out `src/app/render.js`, `src/app/simulation.js`,
  `src/app/save.js`, `src/app/ui.js`, `src/app/pathfinding.js` first — each
  with explicit imports/exports against `gameState`. No behavior change in the
  first pass; just relocations and module boundaries.

### No teardown for `newWorld()` — listener leak
- **Where**:
  - `src/app.js:1634-1761` (UI buttons, document-level click, canvas pointer/wheel,
    window keydown, slider inputs)
  - `src/app/canvas.js:79` (`window.addEventListener('resize', resize)`)
  - `src/app/storage.js:178,182` (`window` `error` and `unhandledrejection`)
- **Problem**: Listeners are registered at module-load time and never removed.
  `newWorld()` (`src/app.js:1061`) replaces world state but does not unsubscribe
  anything; repeated `🗺️ New` clicks accumulate references through closures over
  the previous world.
- **Suggested**: Centralize listener registration in a `bind()` / `unbind()` pair;
  call `unbind()` at the start of `newWorld()`. For listeners that are truly
  module-lifetime (e.g. `resize`), keep them but document the intent.

### State mutation interleaved with render
- **Where**: `update()` in `src/app.js` (around line 5733) calls
  `villagerTick()`, which mutates `storageTotals`, `storageReserved`,
  `villagers`, etc., during the same RAF callback that calls `render()`.
  `saveGame()` (`src/app.js:4475`) reads these fields without any
  synchronization.
- **Problem**: A save triggered mid-tick (button or auto-save) snapshots
  inconsistent state — e.g. resource debited from `storageReserved` but the
  receiving job not yet updated. Subtle, intermittent corruption on reload.
- **Suggested**: Split simulation tick from render. Either run simulation in a
  fixed-timestep loop with a frozen snapshot for save, or queue saves to fire
  between ticks.

### Stale module-local bindings after `newWorld()`
- **Where**: `src/app.js:185-252`. Lines 186-189 capture references to
  `units.buildings`, `units.villagers`, etc. Line 252 captures `world`.
- **Problem**: `newWorld()` reassigns `gameState.world` (around line 1110 the
  audit traced) and rebuilds the `units.*` arrays, but the module-local `let`s
  go on referencing the prior objects. Anything outside `newWorld()` that uses
  these locals is operating on stale data after the swap.
- **Suggested**: Either freeze these as `gameState.world.tiles` accessors at
  call sites, or have `newWorld()` mutate the existing arrays in place
  (`array.length = 0; array.push(...newItems)`) instead of replacing them.
  Auditing every callsite is a prerequisite to either path.

---

## High — data integrity

### Save schema migration framework absent
- **Where**: `src/app.js:4476` (`SAVE_VERSION` exists; only one branch:
  coarse-vs-full tile data)
- **Problem**: When saved fields are added, removed, or renamed, the load path
  silently degrades — added fields default to `0`/`''`, removed fields are
  dropped, renames lose data entirely.
- **Suggested**: Introduce a `migrations: Map<number, (data)=>data>` table; run
  migrations sequentially when `data.saveVersion < SAVE_VERSION`. Even an empty
  table establishes the pattern.

### Lazy villager Maps not hydrated on load
- **Where**: `src/app.js` references `v._wanderFailures` and `v._forageFailures`
  (created on demand around lines 3616 and 3702). `loadGame()` (line 4516)
  rebuilds villagers without these fields.
- **Problem**: First access path checks `if (!v._wanderFailures) v._wanderFailures = new Map()`,
  so it works — but if a future code path does `v._wanderFailures.get(...)`
  without the guard, loaded villagers throw.
- **Suggested**: Initialize both as `new Map()` in the load path and at villager
  spawn, then drop the lazy-init guards.

### Item tile index rebuild gated incorrectly
- **Where**: `src/app.js:208` (`itemTileIndexDirty`); rebuild gate inside
  `villagerTick()` near line 5781.
- **Problem**: The audit observed the rebuild only triggers when a villager has
  no inventory. Items dropped or picked up by a villager *with* inventory leave
  the index stale until somebody else hits the empty-inventory branch.
- **Suggested**: Move the rebuild check to the beginning of the tick loop and
  trigger it whenever `itemTileIndexDirty` is true, independent of villager
  inventory state. Verify no callers rely on the current ordering.

---

## High — boot / integration

### Race between `<script defer>` worldgen and ES-module boot
- **Where**: `index.html:9-12` loads `bootstrap.js` and `worldgen/*.js` as
  classic deferred scripts; line 63 loads `./src/main.js` as a module.
  `src/main.js:25-46` polls every 10 ms for up to 3 s for
  `window.AIV_TERRAIN`/`AIV_CONFIG` to appear.
- **Problem**: Polling masks the fact that there is no causal ordering guarantee
  between deferred scripts and module evaluation. On slow devices the timeout
  fires and boot dies silently.
- **Suggested**: Have `worldgen/terrain.js` resolve a `window.AIV_TERRAIN_READY`
  promise (created up-front in `bootstrap.js`); have `main.js` `await` that
  promise rather than polling.

### Two independent boot timeouts
- **Where**: `public/bootstrap.js:87-95` (4 s "JS NOT RUNNING" timer) and
  `src/main.js:25-46` (3 s dependency timeout).
- **Problem**: The 3 s timeout in `main.js` can reject before the 4 s message in
  `bootstrap.js` fires; the user sees nothing for 3 s, then "JS NOT RUNNING"
  one second later — confusing if the actual failure was a missed module load.
- **Suggested**: Single source of truth: have `main.js` flip a flag; the
  bootstrap timer should only show its message if neither boot success nor
  boot failure has been recorded.

### `index.html` `<script>` tags depend on Vite `base` accidentally
- **Where**: `index.html:9-12` references `bootstrap.js` and `worldgen/*.js`
  with relative URLs that happen to resolve correctly in both `dev` (`base=/`)
  and prod (`base=/AI_Village/`).
- **Problem**: This works today because the scripts have no internal asset
  references. As soon as one tries to `fetch()` or `<img src="">` something
  relative, the path breaks in one of the two contexts.
- **Suggested**: Document the constraint at the top of each `public/`
  script, or move the bootstrap into a module so Vite handles base rewrites.

---

## Medium

### Pointer state race in `endPointer()`
- **Where**: `src/app.js:1735-1738` (approx). `endPointer` clears
  `primaryPointer` without verifying `activePointers.size` first; a
  `pointerleave` followed by `pointerup` for the same pointer can desync state.
- **Suggested**: Only clear `primaryPointer` when the leaving pointer matches.

### Canvas / lightmap context leak on world swap
- **Where**: `src/app/canvas.js:63` (`ctx` is a module-level singleton);
  `src/app.js:632` reassigns `world.lightmapCtx` on `newWorld()`.
- **Problem**: The previous offscreen canvas + context can be GCed only after
  every closure that captured them releases its reference. Listener leaks
  (above) keep them pinned.
- **Suggested**: Tied to the `newWorld()` teardown work above; explicitly
  detach old contexts and release sources.

### `dayTime` shadowed
- **Where**: `src/app.js:264-267` extracts `dayTime` from `time.dayTime`; line
  ~451 overwrites it without ever reading the prior value.
- **Suggested**: Drop the line 264-267 extraction.

### `policy.attach()` fails silently
- **Where**: `src/policy/policy.js:137-144`.
- **Problem**: When `state.population.priorities` is malformed (non-object), it
  silently falls back to `DEFAULT_SLIDERS` — debugging a missing slider becomes
  a guessing game.
- **Suggested**: `console.warn` on the fallback.

### Redundant `computeFamineSeverity()`
- **Where**: `src/ai/scoring.js:208,236` (computes the same value twice within
  the same `score()` call).
- **Suggested**: Compute once and reuse.

### `inspectJobs` overlaps with policy
- **Where**: `src/ai/blackboard.js:85-99` checks `job.waitingForMaterials`,
  duplicating logic that `policy.caps.buildWaiting` exists to encode.
- **Suggested**: Unify the two; either feed `buildPush` from the cap or remove
  the cap.

### Unused exports in `src/app.js`
- **Where**: Trailing exports `shadeFillColorLit`, `applySpriteShadeLit`,
  `ambientAt`, `buildHillshadeQ`, `buildLightmap`, `sampleLightAt` (around
  line 5840).
- **Problem**: No internal caller; only `AIV_APP` global exposes them.
- **Suggested**: Either drop the exports or document they are part of an
  intended public debug surface.

---

## Low

### No lint / format / typecheck pipeline
- `package.json` has only `dev`, `build`, `preview`. No `eslint`, `prettier`,
  `tsc --noEmit`. Many of the issues above (loose equality, dead variables,
  unused exports) would have been caught.
- **Suggested**: Add `eslint` with the recommended JS config and a `lint`
  script.

### `.gpagesignore` is unused
- The deploy workflow uploads `dist/`, not the repo root, so `.gpagesignore`
  has no consumer. The file lists `node_modules/`, `.gitignore`, `.github/`,
  `README.md`.
- **Suggested**: Delete the file, or rewrite the workflow to use it
  (probably not worth it given Vite already produces `dist/`).

### `README.md` describes the deploy inaccurately
- The README says the workflow "uploads the repository contents (excluding
  files listed in `.gpagesignore`)" — but the workflow runs `npm run build` and
  uploads `dist/`. Update the README to match reality.

### Loose typing of seed in `loadGame`
- `newWorld(d.seed)` is called without validating `d.seed` is a finite number;
  a corrupt save with `seed: "abc"` would propagate. Worth a `Number.isFinite`
  guard.

---

## Notes

The audit did not run automated tests because none exist. Adding even a
smoke-test (`vitest` + a single "boot the world headless" assertion) would
remove a lot of risk from the deferred items above.
