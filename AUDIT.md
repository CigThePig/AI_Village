# AI_Village Repo Audit

A snapshot of the codebase's known issues and their current status. Items are
grouped by remaining severity. Resolved entries are listed at the bottom for
historical reference. Severity is the auditor's estimate of impact, not a
user-reported priority.

This document supersedes the April 2026 audit; most entries from that pass
have since been merged.

---

## Open — High

### `src/app.js` is down to ~1,912 lines
- **Where**: `src/app.js`
- **Status**: Eight more bundles extracted in the latest pass — jobs,
  animals, nocturnal entities, DebugKit bridge, material reservation /
  haul scheduling, population / birth, the villager-AI helper bundle,
  and `stepAlong`/`onArrive`. New modules:
  `src/app/{jobs,animals,nocturnal,debugkit,materials,population,villagerAI,onArrive}.js`.
  The file went from 3,706 → 1,912 lines (-48%, ~1,794 lines removed).
  The villager-tuning constants (`STARVE_THRESH`, `REST_BASE_TICKS`,
  `HYDRATION_BUFF_TICKS`, `SOCIAL_*`, `STORAGE_IDLE_*`, `CHILDHOOD_TICKS`,
  …) now live in a single source of truth (`villagerAI.js` /
  `population.js`) and are imported by `villagerTick.js` and
  `onArrive.js`, closing the cross-cutting duplication.
- **What's left in-file** (in roughly top-to-bottom order):
  - The render body — `render()` (~300 lines),
    `drawBuildingAt`/`drawAnimal`/`drawVillager`/`drawQueuedVillagerLabels`
    (~250 lines), the overlay helpers
    (`drawStaticAlbedo`/`drawShadow`/`drawZoneOverlay`/`drawWaterOverlay`/
    the row-mask + cache scaffolding), and `markStaticDirty` /
    `markZoneOverlayDirty`. Together these are ~700 lines and are the
    only outstanding extraction target.
  - Boot wiring: factory instantiation block, `newWorld()`, `update()`,
    `boot()`, `window.AIV_APP` glue.
  - Module-local mirrors of `gameState` arrays (`buildings`,
    `villagers`, `jobs`, `animals`, `itemsOnGround`), the `world`
    getter/setter, and the `tick`/`dayTime` getter shims.
  - A small handful of building-query thunks (`addBuilding`,
    `tileOccupiedByBuilding`, `buildingAt`, `validateFootprintPlacement`,
    `findEntryTileNear`, `getBuildingById`, `noteBuildingActivity`,
    `setActiveBuilding`, `clearActiveBuilding`, `endBuildingStay`,
    `agricultureBonusesAt`) that close over the in-file `buildings`
    array.
  - `el`, `ZONE_JOB_TYPES`, `zoneCanEverWork`, `zoneHasWorkNow`,
    `seasonTick`, `dropItem`, `processVillagerItemPickup`,
    `centerCamera`, the shading-mode glue
    (`normalizeShadingMode`/`computeShadeForMode`/`applyShadingMode`/
    `applyShadingParams`), and `ensureBlackboardSnapshot`.
- **Why it matters**: The remaining file still owns module-local mirrors
  of `gameState` arrays. Once the render body extracts, those mirrors
  can collapse into a single `createGameStateAccess()` helper and
  `src/app.js` will be ~1,200 lines of pure boot wiring.

### Simulation tick interleaved with render
- **Where**: `src/app.js` `update()` calls `tickRunner.runFrame()`
  (from `src/app/tick.js`, which fans out to `villagerTick` in
  `src/app/villagerTick.js`, `updateAnimals`, `seasonTick`, etc.)
  inside the same RAF callback that ends with `render()`. `saveGame()`
  (in `src/app/save.js:41`) reads `gameState` directly when invoked.
- **Why it matters**: Today the manual save button is the only save path so
  the practical risk is bounded — JS is single-threaded and save fires
  between RAF frames. But anything we add that triggers saves from a hook,
  timer, or event listener could observe partial state (e.g. resource
  debited from `storageReserved` before the receiving job updates).
- **Suggested**: Split simulation tick from render with a fixed-timestep
  loop and a frozen snapshot for save, or queue saves to fire between
  ticks.

---

## Open — Medium

### Render body still in `src/app.js`
- **Where**: `src/app.js` (~lines 800–1620 of the current 1,912-line
  file).
- **Status**: This is the only follow-on extraction target left in the
  original "src/app.js follow-on extractions" track-list. The other
  eight bundles landed in the latest pass; see Resolved.
- **Functions to move**: `render` (~300 lines), `drawBuildingAt`,
  `drawAnimal`, `drawVillager`, `drawQueuedVillagerLabels`,
  `drawStaticAlbedo`, `drawShadow`, `drawZoneOverlay`,
  `drawWaterOverlay`, `ensureZoneOverlayCanvas`, `activeZoneSignature`,
  `rebuildZoneOverlay`, `ensureWaterOverlayCanvas`, `maybeBuildLightmap`
  (the in-file 3-line wrapper), `markStaticDirty`,
  `markZoneOverlayDirty`, plus the row-mask helpers
  (`ensureRowMasksSize`, `refreshWaterRowMaskFromTiles`,
  `refreshZoneRowMask`, `updateZoneRow`) and the cache locals
  (`waterRowMask`, `zoneRowMask`, `zoneOverlayCache`,
  `waterOverlayCache`, `staticAlbedoCanvas`, `staticAlbedoCtx`,
  `staticDirty`).
- **Suggested target**: extend `src/app/render.js`'s
  `createRenderSystem(deps)` with these helpers. The factory's deps
  bag will grow substantially (gameState arrays, `findAnimalById`,
  `getBuildingById`, `agricultureBonusesAt`, `nearbyWarmth`, etc.) —
  expect ~25 new dep entries.
- **Why it's still here**: This bundle has the most module-local
  coupling of the nine. Each draw helper closes over `world`, `cam`,
  `ctx`, and one or more `units.*` arrays, plus the overlay caches
  are themselves stateful. A clean extraction needs careful design
  of the cache ownership and a thunk strategy for the building-query
  helpers (which still live in `src/app.js`). It was deferred from
  the latest pass to keep the extraction safe rather than rushed.
- **Net once it lands**: `src/app.js` drops to ~1,200 lines (boot
  wiring + module-local mirrors + a few in-file thunks), at which
  point the gameState mirrors themselves can collapse.

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
- **Planner extracted** — `planZones` / `planBuildings` / `generateJobs`
  moved to `src/app/planner.js`; `createPlanner(opts)` (line 22) takes
  `state`, `policy`, `pathfind`, etc. as explicit dependencies rather
  than closing over `src/app.js` module-locals (commit `9da2aa4`).
- **Simulation tick orchestration extracted** — `createTickRunner(deps)`
  in `src/app/tick.js` (line 6) owns the per-frame tick fan-out and is
  invoked from `update()` in `src/app.js` via
  `tickRunner.runFrame()` (commit `507b686`).
- **`villagerTick` extracted** — `createVillagerTick(deps)` in
  `src/app/villagerTick.js` (line 47) takes `state`, `policy`,
  `pathfind`, the building/job helpers, and the per-villager AI
  callbacks (`pickJobFor`, `goRest`, `consumeFood`, etc.) as explicit
  dependencies rather than closing over `src/app.js` module-locals.
  `createTickRunner` still receives the function as a dep at the
  `src/app.js` wiring site, so the per-frame fan-out is unchanged.
  The decay/mood/buff knobs that only `villagerTick` reads
  (`HUNGER_RATE`, `ENERGY_DRAIN_BASE`, the `REST_*` recovery numbers,
  `HYDRATION_DECAY`/`LOW`/`HUNGER_MULT`/`FATIGUE_BONUS`,
  `SOCIAL_MOOD_TICK`/`SOCIAL_ENERGY_TICK`, `NIGHT_CAMPFIRE_*`) moved
  with it; the constants that other still-in-`src/app.js` helpers
  also read are tracked as a follow-on cleanup under the new
  "src/app.js follow-on extractions" entry. Net `src/app.js` line
  delta: -311 (~4,017 → 3,706).
- **Duplicated experience constants** — `JOB_EXPERIENCE_MAP` and
  `EXPERIENCE_THRESHOLDS` now live only in `src/app/simulation.js:9-22`.
  `src/ai/scoring.js:1` imports them from there, eliminating the
  `socialize` divergence between the two copies.
- **`inspectJobs` / `policy.caps.buildWaiting` overlap** — dropped the
  cap entirely. Both encoded the same formula (`0.5 + buildSlider * 0.35`)
  that the planner already pre-applies as `waitingPrio` in
  `src/app/planner.js:991`, so the cap was dead code: it could never
  fire because `effectivePriority === cap`. Blackboard's `buildPush`
  bonus continues to drive the "ready vs. waiting" preference.
  `policy.caps` and the `getCaps()` helper in `scoring.js` were also
  removed since `buildWaiting` was their only entry.
- **Lint not gated in CI** — `.github/workflows/deploy-pages.yml` now
  runs `npm run lint` between `npm ci` and `npm run build`, so lint
  regressions block the deploy job before it ever uploads `dist/`.
- **Job lifecycle extracted** — `createJobsSystem(deps)` in
  `src/app/jobs.js` owns `jobKey`, `isJobSuppressed`, `suppressJob`,
  `hasSimilarJob`, `violatesSpacing`, `addJob`, `finishJob`,
  `noteJobAssignmentChanged`, `noteJobRemoved`, `getJobCreationConfig`,
  `clearActiveZoneJobs`, plus the `jobSuppression` Map and
  `activeZoneJobs` indices. New `detachVillagersFromJob` helper lifts
  the villager-cleanup pass out of `cancelHaulJobsForBuilding` so
  `materials.js` can reuse it.
- **Animal system extracted** — `createAnimalsSystem(deps)` in
  `src/app/animals.js` owns the full lifecycle:
  `spawnAnimalsForWorld`, `behaviorForAnimal`, `ensureAnimalDefaults`,
  `animalTileBlocked`, `queueAnimalLabel`, `nearestVillagerWithin`,
  `pickRoamTarget`, `attemptGraze`, `chooseFleeTarget`,
  `findAnimalById`, `removeAnimal`, `resolveHuntYield`,
  `findHuntApproachPath`, `interactWithVillage`, `stepAnimal`,
  `animalTick`, `updateAnimals`, plus the `DEFAULT_ANIMAL_BEHAVIOR`
  fallback.
- **Nocturnal entities extracted** — `createNocturnalSystem()` in
  `src/app/nocturnal.js` owns the `nocturnalEntities` array,
  `nocturnalSpawnCooldown`, `nocturnalAmbientStrength`,
  `spawnNocturnalEntity`, `updateNocturnalEntities`, and
  `drawNocturnalEntities`. The state was previously a top-level
  module-local in `src/app.js`.
- **DebugKit bridge extracted** — `createDebugKitBridge(deps)` in
  `src/app/debugkit.js` owns `debugKitGetPipeline`,
  `describeCanvasContext`, `debugKitGetLightingProbe`,
  `debugKitEnterSafeMode`, `debugKitGetState`,
  `configureDebugKitBridge`, `installDebugKitWatcher`,
  `ensureDebugKitConfigured`, plus a new `attachToWindow()` method
  that bundles the prior `if (typeof window !== 'undefined') { … }`
  boot block.
- **Material reservation / haul scheduling extracted** —
  `createMaterials(deps)` in `src/app/materials.js` owns
  `availableToReserve`, `canReserveMaterials`, `reserveMaterials`,
  `releaseReservedMaterials`, `spendCraftMaterials`,
  `countBuildingsByKind`, `scheduleHaul`, `requestBuildHauls`,
  `cancelHaulJobsForBuilding`. Cross-references `findNearestBuilding`
  via a thunk so it can be wired before `villagerAI.js` (which owns
  that helper).
- **Population / birth helpers extracted** — `createPopulation(deps)`
  in `src/app/population.js` owns `rollAdultRole`, `assignAdultTraits`,
  `newVillager`, `newChildVillager`, `housingCapacity`,
  `populationLimit`, `canSupportBirth`, `findBirthMate`,
  `tryStartPregnancy`, `spawnChildNearParents`, `flushPendingBirths`,
  `completePregnancy`, `promoteChildToAdult`, plus the `pendingBirths`
  array and the population/pregnancy constants (`PREGNANCY_TICKS`,
  `CHILDHOOD_TICKS`, `PREGNANCY_ATTEMPT_*`, `POPULATION_*`,
  `FOOD_HEADROOM_PER_VILLAGER`). `CHILDHOOD_TICKS` is re-exported and
  consumed by `villagerTick.js`.
- **Villager-AI helper bundle extracted** — `createVillagerAI(deps)`
  in `src/app/villagerAI.js` owns `pickJobFor`, `maybeInterruptJob`,
  `scoreExistingJobForVillager`, `findPanicHarvestJob`, `foragingJob`,
  `goRest`, `tryEquipBow`, `tryHydrateAtWell`, `tryCampfireSocial`,
  `tryStorageIdle`, `consumeFood`, `seekEmergencyFood`,
  `nearestFoodTarget`, `getRallyPoint`, `countNearbyVillagers`,
  `collectFoodHubs`, `pickWeightedRandom`,
  `selectReachableWanderTarget`, `handleIdleRoam`,
  `findNearestBuilding`, `nearbyWarmth`, plus the starve trio
  (`issueStarveToast`, `enterSickState`, `handleVillagerFed`).
- **`onArrive` extracted** — `createOnArrive(deps)` in
  `src/app/onArrive.js` owns the per-job arrival dispatcher and
  `stepAlong`. The factory takes ~30 deps via the bag pattern; an
  `onZoneTileSown` callback isolates the render-side row-mask
  refresh so the module doesn't import the overlay state directly.
- **Villager-tuning constants deduplicated** — `STARVE_THRESH`,
  `STARVE_COLLAPSE_TICKS`, `STARVE_RECOVERY_TICKS`,
  `STARVE_TOAST_COOLDOWN`, `FOOD_HUNGER_RECOVERY`, `REST_BASE_TICKS`,
  `REST_EXTRA_PER_ENERGY`, `HYDRATION_VISIT_THRESHOLD`,
  `HYDRATION_BUFF_TICKS`, `SOCIAL_BASE_TICKS`,
  `SOCIAL_COOLDOWN_TICKS`, `STORAGE_IDLE_BASE`,
  `STORAGE_IDLE_COOLDOWN` now live only in `src/app/villagerAI.js`
  and are imported from there by `villagerTick.js` and
  `onArrive.js`. `CHILDHOOD_TICKS` similarly lives only in
  `src/app/population.js`. The cross-cutting cleanup tracked under
  the prior follow-on entry is closed.
