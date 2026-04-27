# AI_Village Repo Audit

A snapshot of the codebase's known issues and their current status. Items are
grouped by remaining severity. Resolved entries are listed at the bottom for
historical reference. Severity is the auditor's estimate of impact, not a
user-reported priority.

This document supersedes the April 2026 audit; most entries from that pass
have since been merged.

---

## Open — High

### `src/app.js` is still a single ~3,700-line module
- **Where**: `src/app.js`
- **Status**: Significant progress. Pathfinding, save/load, UI/pointer input,
  rendering helpers, world/building data, time-of-day/experience helpers,
  the planner, per-frame tick orchestration, and now `villagerTick` have
  all been carved out into
  `src/app/{pathfinding,save,ui,render,world,simulation,planner,tick,villagerTick}.js`.
  The file is down to ~3,706 lines (from ~4,017 before the
  `villagerTick` extraction). What remains in-file is the job lifecycle,
  the material-reservation/haul layer, `onArrive` (the per-job arrival
  branch), the villager-AI helper bundle (`pickJobFor`,
  `maybeInterruptJob`, `foragingJob`, `goRest`, `seekEmergencyFood`,
  `consumeFood`, `tryEquipBow`, `tryHydrateAtWell`, `tryCampfireSocial`,
  `tryStorageIdle`, `handleIdleRoam`, `nearestFoodTarget`,
  `collectFoodHubs`, `pickWeightedRandom`, `selectReachableWanderTarget`),
  the animal system (~350 lines), the render body
  (`render`/`drawBuildingAt`/`drawAnimal`/`drawVillager` plus overlay
  helpers, ~600 lines), the population/birth helpers, the DebugKit
  bridge, and boot wiring.
- **Why it matters**: The remaining file still owns module-local mirrors of
  `gameState` arrays (`buildings`, `villagers`, `jobs`, `animals`,
  `itemsOnGround`) and a property-getter/setter for `world`. Most of the
  trickier remaining items below trace back to that coupling.
- **Suggested next pass**: Track follow-on extraction targets under the
  new "src/app.js follow-on extractions" entry below. The villager-AI
  helper bundle is the highest-leverage next target because every
  helper there is also a dep that `createVillagerTick` currently has
  to be handed via the deps bag — extracting them next will collapse
  the bag and let `villagerTick` import its callees directly.

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

### `src/app.js` follow-on extractions
- **Where**: `src/app.js`
- **Status**: Track-list of the next-best extraction targets, in priority
  order, now that `villagerTick` has moved to its own module. Each item
  is sized so that a single PR can land it without rewriting unrelated
  systems.
  1. **Villager-AI helper bundle** — `pickJobFor`, `maybeInterruptJob`,
     `scoreExistingJobForVillager`, `findPanicHarvestJob`, `foragingJob`,
     `goRest`, `tryEquipBow`, `tryHydrateAtWell`, `tryCampfireSocial`,
     `tryStorageIdle`, `consumeFood`, `seekEmergencyFood`,
     `nearestFoodTarget`, `collectFoodHubs`, `pickWeightedRandom`,
     `selectReachableWanderTarget`, `handleIdleRoam`, `findNearestBuilding`,
     plus the starve-cycle trio (`issueStarveToast`, `enterSickState`,
     `handleVillagerFed`) at `src/app.js:~1596-2538`. Extract into
     `src/app/villagerAI.js` using the `createVillagerAI(deps)` factory
     pattern. **High leverage**: `createVillagerTick`'s ~30-entry deps
     bag mostly points at this bundle, so once it lands the bag
     collapses to a handful of cross-module entries (`pathfind`,
     `ambientAt`, building/job helpers).
  2. **`onArrive`** (`src/app.js:~2540-2950`, ~400 lines branching on
     every job type — `chop`, `mine`, `sow`, `harvest`, `forage`,
     `build`, `haul`, `craft_bow`, `hunt`, `rest`, `hydrate`,
     `socialize`, `storage_*`). Reads `world`, `buildings`, `jobs`,
     `itemsOnGround`, `storageTotals`, `storageReserved` directly.
     Extract into `src/app/onArrive.js` (or fold into `villagerAI.js`).
  3. **Job lifecycle** — `addJob`, `finishJob`, `noteJobAssignmentChanged`,
     `noteJobRemoved`, `suppressJob`, `isJobSuppressed`, `hasSimilarJob`,
     `jobKey`, `getJobCreationConfig`, plus the `jobSuppression` /
     `activeZoneJobs` indices at `src/app.js:~1482-1556`. Extract into
     `src/app/jobs.js`.
  4. **Material reservation / haul scheduling** — `availableToReserve`,
     `canReserveMaterials`, `reserveMaterials`, `releaseReservedMaterials`,
     `spendCraftMaterials`, `scheduleHaul`, `requestBuildHauls`,
     `cancelHaulJobsForBuilding` at `src/app.js:~1347-1465`. Extract
     into `src/app/materials.js`.
  5. **Render body** — `render` and its draw helpers
     (`drawBuildingAt`, `drawAnimal`, `drawVillager`,
     `drawQueuedVillagerLabels`, `drawShadow`, `drawZoneOverlay`,
     `drawWaterOverlay`, `drawNocturnalEntities`, `drawStaticAlbedo`)
     at `src/app.js:~3037-3650`. Fattens `src/app/render.js` (which
     today only owns lower-level helpers).
  6. **Animal system** — `spawnAnimalsForWorld`, `behaviorForAnimal`,
     `ensureAnimalDefaults`, `animalTileBlocked`, `pickRoamTarget`,
     `attemptGraze`, `chooseFleeTarget`, `findAnimalById`,
     `removeAnimal`, `resolveHuntYield`, `findHuntApproachPath`,
     `interactWithVillage`, `stepAnimal`, `animalTick`, `updateAnimals`
     at `src/app.js:~658-1010`. Extract into `src/app/animals.js`.
  7. **Population/birth helpers** — `housingCapacity`,
     `populationLimit`, `canSupportBirth`, `findBirthMate`,
     `tryStartPregnancy`, `spawnChildNearParents`, `flushPendingBirths`,
     `completePregnancy`, `promoteChildToAdult`, plus
     `assignAdultTraits`/`rollAdultRole`/`newVillager`/`newChildVillager`
     at `src/app.js:~1174-2148`. Extract into `src/app/population.js`.
  8. **DebugKit bridge** — `debugKitGetPipeline`, `describeCanvasContext`,
     `debugKitGetLightingProbe`, `debugKitEnterSafeMode`,
     `debugKitGetState`, `configureDebugKitBridge`,
     `installDebugKitWatcher`, `ensureDebugKitConfigured` at
     `src/app.js:~373-598`. Extract into `src/app/debugkit.js`.
  9. **Nocturnal entities** — `nocturnalAmbientStrength`,
     `spawnNocturnalEntity`, `updateNocturnalEntities`,
     `drawNocturnalEntities`, plus the `nocturnalEntities` array and
     `nocturnalSpawnCooldown` at `src/app.js:~235-247, 3807-3900`.
     Bundle with the render extraction.
- **Why it matters**: Each leaves `src/app.js` smaller and
  `gameState`-coupling more localized; combined, they take the file
  below ~1,000 lines (mostly boot wiring + the module-local mirrors
  themselves), at which point the mirrors can finally collapse.
- **Cross-cutting cleanup**: A handful of villager-tuning constants
  (`STARVE_THRESH`, `CHILDHOOD_TICKS`, `HYDRATION_BUFF_TICKS`,
  `HYDRATION_DEHYDRATED_PENALTY`, `HYDRATION_MOOD_TICK`,
  `REST_BASE_TICKS`, `REST_EXTRA_PER_ENERGY`, `SOCIAL_BASE_TICKS`,
  `SOCIAL_COOLDOWN_TICKS`, `STORAGE_IDLE_BASE`, `STORAGE_IDLE_COOLDOWN`)
  are duplicated between `src/app.js:1567-1591` and
  `src/app/villagerTick.js:11-43` because the helpers that read them
  in `src/app.js` haven't moved yet. The cleanup falls out for free
  once the villager-AI helper bundle (#1) lands — both files start
  importing from a single source. Until then, treat the duplication
  as a bug magnet and keep the two blocks in sync if any value
  changes.

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
