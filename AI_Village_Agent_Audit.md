# AI Village Codebase Audit & Repair Plan

## Purpose

This document is an agent-ready audit of the `AI_Village` repo. The goal is to identify major runtime, logic, persistence, and wiring issues in the simulation, explain why each one matters, infer the likely original design intent where useful, and provide an implementation order for repairs.

This is not a style cleanup pass. Prioritize issues that cause broken simulation behavior, corrupted state, lost resources, stuck villagers, misleading UI, broken save/load behavior, or systems that were partially implemented but not fully wired.

## High-Level Diagnosis

The project appears to be an autonomous village simulation with:

- procedural world generation
- villagers with needs, moods, jobs, skills, pathing, families, housing, and inventories
- a resource economy involving storage, ground items, reservations, building supplies, pending materials, and hauling
- planner-driven village expansion
- hunting, bows, pelts, animal yields, and hunter lodges
- farms, crops, seasons, growth, sowing, harvesting, chopping, mining, and building
- save/load support
- DebugKit/worldgen bridge loaded through browser globals

The central architectural issue is that several systems were implemented in waves and no longer share one consistent lifecycle:

- resources can exist in storage, on the ground, in villagers' inventories, reserved for jobs, pending for buildings, or stored inside blueprints
- jobs can reserve resources but are not persisted
- save/load preserves some durable state and some volatile state, but discards other volatile state
- villagers are reset to idle on load, but building occupancy and reservations can survive
- item types like `pelt` are produced but not fully supported by storage/persistence
- job dedupe/suppression keys are too broad and collapse distinct work

The simulation is not conceptually bad. It is mostly suffering from incomplete transactional bookkeeping. Every resource needs a known location, every reservation needs an owner, every job needs a stable identity, and save/load must either preserve or intentionally discard volatile work.

## Recommended Repair Philosophy

Use a **stable checkpoint save** before attempting exact snapshot save.

For now, saves should preserve durable world state and restart volatile work cleanly. This is much easier than saving every path, job, assignment, inventory, timer, and activity state exactly.

On load, either fully restore volatile systems or wipe/rebuild them. Do not preserve half of them.

Recommended first target:

```js
jobs.length = 0;

villagers.forEach(v => {
  v.path = [];
  v.targetJob = null;
  v.inv = null; // or restore intentionally if implemented
  v.state = 'idle';
  v.activeBuildingId = null;
});

buildings.forEach(b => {
  ensureBuildingData(b);
  if (b.activity) b.activity.occupants = 0;
});

storageReserved = recomputeFromPendingOrZero();
```

Then let planner/job generation recreate valid work.

---

# Critical Issues

## 1. Save/load destroys ground items

**Files/lines**

- `src/app/save.js:48-89`
- `src/app/save.js:180-250`
- `src/app.js:777-792`

`save.js` stores tiles, zones, trees, rocks, berries, growth, buildings, storage totals, reserved totals, villagers, and animals, but it does not save `itemsOnGround`.

Ground items are part of the resource economy. `src/app.js:777-792` shows dropped items are how resources move from world production into villager inventory and eventually storage.

### Why this is a problem

If a villager chops wood, mines stone, hunts meat, drops resources, or any resource exists between production and storage, saving/loading deletes those resources.

This causes work to disappear from the economy. Villagers may have done labor, but the payoff vanishes.

### Likely original intent

The project has a physical item bus:

1. jobs produce ground resources
2. villagers pick them up
3. villagers haul them to storage
4. storage totals increase

That is a good simulation design, but persistence forgot the in-between resource state.

### Fix direction

Save and restore ground items:

```js
itemsOnGround: itemsOnGround.map(item => ({
  type: item.type,
  x: item.x,
  y: item.y,
  qty: item.qty || 1
}))
```

On load, default old saves to `[]`.

---

## 2. Save/load preserves reservations but not the jobs that own them

**Files/lines**

- `src/app/save.js:59-61`
- `src/app/save.js:62-81`
- `src/app/save.js:153-179`
- `src/app/materials.js:23-25`
- `src/app/materials.js:78-103`

The save file stores `storageTotals`, `storageReserved`, and `buildings`, but it does not store the active job board, villager paths, villager inventory, or `targetJob`.

`materials.js:23-25` calculates available resources by subtracting reservations:

```js
return Math.max(0, storageTotals[type] - (storageReserved[type] || 0));
```

`materials.js:78-103` creates haul jobs and increments reservation/pending ledgers.

### Why this is a problem

If a job reserved resources before save, then after load:

- reserved totals survive
- the owning job disappears
- villager assignment disappears
- villager inventory disappears
- building pending state may survive

This can permanently lock resources as unavailable.

### Likely original intent

The reservation system was intended to prevent double spending. That is correct, but reservations are transactional state. They need an owner or must be rebuilt.

### Fix direction

Use one of these approaches:

1. **Exact snapshot save**: save jobs, assignments, paths, inventories, pending transactions, and reservations.
2. **Stable checkpoint save**: clear volatile reservations/jobs on load and rebuild needed jobs from durable world/building state.

Recommended first fix: stable checkpoint.

---

## 3. Save/load resets global time but preserves tick-relative timers

**Files/lines**

- `src/app/save.js:48-89`
- `src/app.js:337-338`
- `src/app/save.js:84-87`

Save/load does not persist `time.tick` or `time.dayTime`. However, animals preserve fields such as `nextActionTick`.

### Why this is a problem

After load, global time returns to zero while entity timers may remain from the old timeline. Animals or other systems using tick-relative fields may act too early, too late, or appear frozen.

### Fix direction

Persist time:

```js
time: {
  tick: time.tick,
  dayTime: time.dayTime,
  paused: time.paused,
  speedIdx: time.speedIdx
}
```

Restore time before recreating villagers/animals.

---

## 4. Haul job duplicate detection ignores resource type and quantity

**Resolved (Phase 3, commit `7d7cc5a`).** `getJobIdentity(job)` in
`src/app/jobs.js` now keys haul jobs as `haul:b${bid}:r${resource}`, so
wood and stone hauls for the same building no longer collapse.
`hasSimilarJob` and the suppression Map both route through the new
identity. Cancelled tombstones are skipped in `hasSimilarJob` so a
deliver-stage cancellation cannot block its replacement (touches #29).


**Files/lines**

- `src/app/jobs.js:69-70`
- `src/app/materials.js:88-102`
- `src/app/materials.js:112-115`
- `src/app/world.js:7-12`

`hasSimilarJob(job)` compares only:

```js
type, x, y, bid
```

It does not compare `resource`, `qty`, `stage`, or target/source details.

### Why this is a problem

A building that needs both wood and stone may fail to receive both haul jobs. The wood haul and stone haul can look identical to the dedupe system if they share the same building/tile.

### Fix direction

Use per-job identity keys, for example:

```js
haul_build:${bid}:${resource}:${stage}
build:${bid}
hunt:${targetAid}
craft_bow:${bid}
zone:${type}:${x},${y}
```

Use these keys for duplicate detection and suppression.

---

## 5. Villagers can interrupt assigned jobs by picking up random ground items

**Files/lines**

- `src/app/tick.js:120-122`
- `src/app/app.js:783-792`
- `src/app/villagerTick.js:355-368`

Every tick runs pickup before normal villager logic:

```js
processVillagerItemPickup(v);
villagerTick(v);
```

`processVillagerItemPickup()` allows any villager without inventory to pick up any item on their tile. It does not check whether the villager is assigned to a job.

### Why this is a problem

A villager traveling to build, chop, mine, craft, or hunt can step on a random item, pick it up, abandon their route, and start hauling to storage. This can stall or corrupt the original job.

### Fix direction

Only allow opportunistic pickup when the villager is idle:

```js
if (!v.targetJob && !v.path?.length && !v.inv) {
  processVillagerItemPickup(v);
}
```

Better long-term: make pickup explicit haul work instead of spontaneous interception.

---

## 6. Pelts are generated but cannot be stored or persisted

**Resolved (Phase 2, commit `b3ef1df`).** Added `ITEM.PELT`, `RESOURCE_TYPES`,
`ITEM_COLORS`. Storage totals/reserved, `newWorld`, save/load, deposit, and
rendering all flow through the resource list now. Pelts deposit, persist, and
render with a dedicated color.


**Files/lines**

- `src/app/onArrive.js:173-176`
- `src/app/animals.js:229-236`
- `src/app/constants.js:134`
- `src/app/state.js:31-34`
- `src/app/onArrive.js:471-475`
- `src/app/render.js:1205-1211`
- `src/app/save.js:48-89`

Hunting can drop pelts:

```js
if (yieldInfo.pelts > 0) {
  dropItem('pelt', ax, ay, yieldInfo.pelts);
}
```

But `ITEM` only defines food, wood, stone, and bow. Storage totals only track food, wood, stone, and bow.

Deposit logic only handles known item types. A carried pelt can be silently deleted on storage arrival.

### Why this is a problem

`pelt` is a half-wired resource. It exists as hunting output but not as a first-class item.

### Fix direction

Either remove pelt drops for now or fully add:

```js
ITEM.PELT = 'pelt'
storageTotals.pelt
storageReserved.pelt
render support
save/load support
storage deposit support
future recipe/trade usage
```

---

## 7. Animal ambient hunting can create food without killing animals

**Files/lines**

- `src/app/animals.js:273-280`
- `src/app/planner.js:934-966`
- `src/app/onArrive.js:141-195`

The formal hunting pipeline exists, but animals also have ambient villager interaction where hungry villagers can benefit from animals without killing them.

### Why this is a problem

This bypasses the formal hunting system:

- no bow requirement
- no hunter job
- no animal death
- no meat drop/storage interaction
- no real scarcity cost

Animals can become renewable meat sources.

### Likely original intent

This was probably early prototype behavior before the full hunter/bow/lodge system was added.

### Fix direction

Remove the ambient hunting branch or convert it into a non-food interaction. Formal hunting should own meat production.

---

## 8. Zone expansion logic likely fails when no reachable candidate exists nearby

**Files/lines**

- `src/app/planner.js:376-385`
- `src/app/planner.js:251-257`

`findPlacementNear()` expands when no reachable candidate was found in the first radius, but `ensureZoneCoverage()` expands only when `firstPass.reachableSeen` is true.

### Why this is a problem

If the nearby area has no reachable zone candidates, the system may not expand outward. Farms/chop zones/mine zones can fail around awkward terrain or camp placement.

### Fix direction

Expand when work is still needed, not only when reachable candidates were already seen:

```js
if (needMore && !firstPass.completed) {
  // second pass
}
```

---

## 9. Planner building budget double-counts reservations

**Files/lines**

- `src/app/planner.js:732-743`
- `src/app/planner.js:444-445`
- `src/app/materials.js:101-102`

`ensureStarterBuildings()` computes local budget using `availableToReserve()` and `reservedWoodForPlans`. But `placeBlueprint()` immediately calls `requestBuildHauls()`, which also increments `storageReserved`.

### Why this is a problem

The same planned building can be counted twice against available wood/stone budget, causing the planner to place fewer buildings than it should.

### Fix direction

Either:

- remove local `reservedWoodForPlans`, because global reservations already update, or
- make blueprint placement not reserve immediately and reserve in one controlled pass later.

---

## 10. Labels queued by update systems are cleared before render

**Files/lines**

- `src/app/tick.js:117-123`
- `src/app/animals.js:135-148`
- `src/app/render.js:1045`
- `src/app/render.js:1283`

Animal systems queue labels during update, but render starts by clearing the shared label array before drawing.

### Why this is a problem

Animal labels such as `Grazing`, `Taken`, `Hunted`, or flee/status labels may never appear.

### Fix direction

Clear label queue after drawing, not before. Or split labels into update-generated event labels and render-generated frame labels.

---

## 11. Build jobs are created before buildings are fully supplied

**Resolved (Phase 4).** `generateJobs()` in `src/app/planner.js` now gates
`build` job creation on `status.fullyDelivered`. Partially-supplied
blueprints have their build job removed instead of created with reduced
priority. `placeBlueprint` keeps its single `requestBuildHauls(b)` call
at placement (this is a planner action, not job evaluation), so haulers
start moving wood/stone immediately, but builders only see work once
`b.store` covers cost. The `waitingForMaterials` flag and dual
`readyPrio`/`waitingPrio` priorities are gone — a build job is, by
construction, always ready.

**Files/lines**

- `src/app/planner.js:973-998`
- `src/app/villagerAI.js:617-639`
- `src/app/onArrive.js:279-315`

Build jobs are created when a building has any supply, not full supply. Builders may arrive, consume partial materials, fail to complete, and trigger more haul requests.

### Why this is a problem

This mixes two construction models:

1. haulers fully supply, then builders build
2. builders gradually consume partial staged resources

The current behavior can cause inefficient “poke the blueprint” loops.

### Fix direction

Choose one model.

Simplest:

- haulers supply all required materials
- build jobs are created only when `fullyDelivered`
- builders complete construction after all materials are present

Deeper model:

- add `workRequired` and `workDone`
- builders spend labor over time
- materials are consumed in defined stages

---

## 12. Bow pickup is not reserved before villagers travel to storage

**Resolved (Phase 2, commit `b3ef1df`).** `tryEquipBow` now calls
`reserveMaterials({ bow: 1 })` on intent and releases on every early-return
(no storage / no path). `v.reservedPickup` tracks the outstanding claim.


**Files/lines**

- `src/app/villagerAI.js:500-518`
- `src/app/onArrive.js:454-463`

`tryEquipBow()` checks bow availability but does not reserve the bow. Multiple villagers can path to storage expecting the same bow. Only one succeeds on arrival.

### Why this is a problem

This wastes villager trips and can interact badly with reservation accounting.

### Fix direction

Reserve the bow when assigning pickup:

```js
storageReserved.bow++;
v.reservedPickup = { type: ITEM.BOW, qty: 1 };
```

Release reservation if cancelled.

---

## 13. `spendCraftMaterials()` is used for unreserved bow pickup, corrupting reservations

**Resolved (Phase 2, commit `b3ef1df`).** Bow pickup now owns its own
reservation (see #12), so `spendCraftMaterials` is closing a real reservation
rather than someone else's. A new `takeFromStorage(resource, qty)` helper was
added to `materials.js` for any future direct-take callers, alongside doc
comments separating the four helper roles. Also fixed a related double-release:
`spendCraftMaterials` already releases on insufficient-stock failure, so the
arrival path only releases explicitly when storage vanished mid-trip and
`spendCraftMaterials` was never called.


**Files/lines**

- `src/app/materials.js:52-65`
- `src/app/onArrive.js:454-463`
- `src/app/villagerAI.js:500-518`

`spendCraftMaterials()` assumes consumed materials were reserved. Bow pickup does not reserve first, then calls `spendCraftMaterials({ bow: 1 })`.

### Why this is a problem

A villager picking up a bow can release someone else’s bow reservation.

### Fix direction

Create a separate storage helper:

```js
function takeFromStorage(resource, qty) {
  if ((storageTotals[resource] || 0) < qty) return false;
  storageTotals[resource] -= qty;
  return true;
}
```

Use reservation-aware helpers only for transactions that actually reserved resources.

---

## 14. `pickJobFor()` mutates world state while evaluating jobs

**Resolved (Phase 4).** Job evaluation is now a pure read.
`pickJobFor()` no longer calls `requestBuildHauls(buildTarget)` mid-loop
and the "assist haul" branch (which let an evaluating villager grab a
random open haul as a side effect) is removed — supply scheduling lives
entirely in the planner. `scoreExistingJobForVillager()` and
`pickJobFor()` both stop writing `j.waitingForMaterials` during scoring.
The `requestBuildHauls` dependency was dropped from `createVillagerAI`
and from its wiring in `src/app.js`. Build jobs that aren't fully
delivered are skipped defensively (the planner shouldn't emit them, but
load-time races could).

**Files/lines**

- `src/app/villagerAI.js:601-672`
- `src/app/villagerAI.js:617-620`
- `src/app/villagerAI.js:558-580`

`pickJobFor()` can call `requestBuildHauls(buildTarget)` while merely evaluating whether a job is suitable. `maybeInterruptJob()` also calls `pickJobFor()` to compare candidate work.

### Why this is a problem

A scoring/evaluation function creates haul jobs and reservations as a side effect. A villager merely considering a job can mutate the global economy.

### Fix direction

Move `requestBuildHauls()` out of `pickJobFor()` into planner/build maintenance logic. Keep job selection as pure as possible.

---

## 15. Ripe crops can become permanently stranded with no harvest job

**Resolved (Phase 5).** `generateJobs()` in `src/app/planner.js` now
emits a harvest job for every FARMLAND tile with `growth >= 150` on
each pass, gated on `world.tiles[i] === TILES.FARMLAND` rather than
`z === ZONES.FARM` (so a dezoned-but-sown tile is still harvested).
`getJobIdentity` in `src/app/jobs.js` was missing a `harvest` case;
adding it (key `harvest:${x},${y}`) makes the planner emission
idempotent — a removed/cancelled/suppressed harvest job is recreated
on the next planner pass. `seasonTick` keeps its threshold-crossing
emission as the fast-path; the planner is the catch-up.


**Files/lines**

- `src/app.js:656-691`
- `src/app.js:685-688`
- `src/app/planner.js:856-875`
- `src/app.js:592-599`

Harvest jobs are created when crop growth crosses a threshold. Regular zone job generation only recreates sow jobs for empty farm tiles.

### Why this is a problem

If the one-time harvest job fails to be created, gets removed, is unreachable, or is suppressed, a mature crop can sit forever.

### Fix direction

Make job generation idempotently create harvest jobs whenever mature crops exist:

```js
if (world.tiles[i] === TILES.FARMLAND && world.growth[i] >= 150) {
  addJob({ type: 'harvest', x, y, ... });
} else if (world.growth[i] === 0) {
  addJob({ type: 'sow', x, y, ... });
}
```

---

## 16. Farm job logic over-enables sow/harvest work

**Resolved (Phase 5).** `shouldGenerateJobType` in `src/app/planner.js`
now treats sow and harvest separately. Harvest is always allowed (the
FARMLAND scan is a no-op when nothing is ripe). Sow gates on a
planted-tile target driven by `plantedTilesPerVillager` (default `1.5`,
added to `DEFAULT_JOB_CREATION` in `src/policy/policy.js`); a new
`countPlantedTiles()` helper counts FARMLAND tiles with `0 < growth <
150`, so ripe-but-unharvested tiles do not throttle sowing. Forage was
softened — the old `!hasRipeCrops()` clause is replaced with `(!hasRipeCrops()
&& foodOnHand < villagerCount * 3)`, so forage stays a real
food-pressure fallback rather than constant competition with farming.


**Files/lines**

- `src/app/planner.js:814-825`
- `src/app/planner.js:765-775`

Once any farm tile exists, sow/harvest generation is always allowed.

### Why this is a problem

Farming can dominate villager behavior even when food is comfortable, while ripe crops may still be missed due to issue #15.

### Fix direction

Separate farm logic:

- harvest: always generate when ripe crops exist
- sow: generate only when planted count is below target or food pressure exists
- forage: use only when food pressure exists or no crops can be harvested

---

## 17. Load restores `activeBuildingId` while forcing villagers idle

**Files/lines**

- `src/app/save.js:77`
- `src/app/save.js:199-223`
- `src/app.js:530-560`

Save stores `activeBuildingId`; load restores it while also forcing villagers to idle, clearing path, inventory, and hydration timer.

### Why this is a problem

A villager can be idle while still linked to a building occupancy record. This creates phantom occupants.

### Fix direction

For stable checkpoint save, do not restore `activeBuildingId`; set it to `null`. Also reset building activity occupants on load.

---

## 18. `newWorld()` does not reset pause/speed state

**Files/lines**

- `src/app.js:317-339`

`newWorld()` resets tick/dayTime but not `time.paused` or `time.speedIdx`.

### Why this is a problem

A new world can start paused or at an old speed setting, confusing the user.

### Fix direction

Either reset explicitly:

```js
time.paused = false;
time.speedIdx = 1;
```

or intentionally preserve these and sync UI labels.

---

## 19. Pause/speed UI can desync from actual time state

**Files/lines**

- `src/app/ui.js:111-118`
- `src/app.js:317-339`
- `src/app/save.js:93-253`

Pause/speed button text only updates when buttons are clicked.

### Why this is a problem

After load/new world, UI may show stale state.

### Fix direction

Add `syncTimeButtons()` and call after boot, load, new world, pause changes, and speed changes.

---

## 20. `loadGame()` calls `newWorld()` and shows misleading new-world toasts

**Files/lines**

- `src/app/save.js:133`
- `src/app.js:474-475`
- `src/app/save.js:251`

Loading calls `newWorld()`, which shows new-world messages, then load shows `Loaded.`

### Why this is a problem

The user may think the save was replaced or regenerated.

### Fix direction

Add an option:

```js
newWorld(seed, { silent: true })
```

Use silent mode during load.

---

## 21. World reload creates then discards villagers/animals

**Files/lines**

- `src/app/save.js:133`
- `src/app.js:449-462`
- `src/app/save.js:180-250`

`loadGame()` calls `newWorld()`, which spawns fresh villagers and animals, then load clears and replaces them.

### Why this is a problem

This causes needless random draws, temporary state churn, possible toasts, and divergence from deterministic restore behavior.

### Fix direction

Split world generation:

```js
generateWorldBase(seed)
initializeNewGame(seed)
```

Load should generate terrain/base state without spawning new simulation entities.

---

## 22. `main.js` tries to call a global fatal reporter that is not exposed

**Files/lines**

- `src/main.js:52-63`
- `src/app/storage.js:189-191`

`main.js` checks for `GLOBAL_SCOPE.reportFatal`, but `storage.js` only exposes `AIV_STORAGE`.

### Why this is a problem

Early boot failures may not show the intended fatal overlay.

### Fix direction

Expose the reporter:

```js
AIV_SCOPE.reportFatal = reportFatal;
```

Or move fatal overlay into a small module imported by `main.js`.

---

## 23. `canvas.js` reports a fatal error then crashes if canvas is missing

**Files/lines**

- `src/app/canvas.js:4`
- `src/app/canvas.js:63-65`

If `#game` is missing, `context2d()` may report fatal, but `canvas.style.touchAction` still dereferences null.

### Why this is a problem

The intended helpful error is replaced by a generic null crash.

### Fix direction

Throw once if canvas is missing:

```js
if (!canvas) {
  reportFatal(new Error('Missing #game canvas'));
  throw new Error('Missing #game canvas');
}
```

---

## 24. UI binding assumes every DOM node exists

**Files/lines**

- `src/app/ui.js:92-103`
- `src/app/ui.js:153-166`

Refs are collected, then event listeners are attached without null checks.

### Why this is a problem

One renamed/missing HTML element can break boot.

### Fix direction

Use safe binding:

```js
function on(node, event, fn, opts) {
  if (node) node.addEventListener(event, fn, opts);
}
```

---

## 25. `onPriorClick()` assumes the priority sheet exists

**Files/lines**

- `src/app/ui.js:119-122`

`uiRefs.sheetPrior.getAttribute(...)` is called without a null check.

### Why this is a problem

A missing/renamed priority sheet crashes the click handler.

### Fix direction

```js
if (!uiRefs.sheetPrior) return;
```

---

## 26. Job suppression keys ignore resource/stage/target identity

**Resolved (Phase 3, commit `7d7cc5a`).** `suppressJob` and
`isJobSuppressed` now use `getJobIdentity`, so suppression follows the
work being suppressed. Hunt suppression keys on `targetAid`, so a
fleeing animal cannot evade `HUNT_RETRY_COOLDOWN` by changing position.


**Files/lines**

- `src/app/jobs.js:42-67`
- `src/app/materials.js:88-102`
- `src/app/planner.js:953-960`

`jobKey()` uses only type/x/y/bid.

### Why this is a problem

Suppression can accidentally block distinct jobs sharing a tile/building/type but differing in resource, target animal, stage, or payload.

### Fix direction

Use per-job identity keys, same as issue #4.

---

## 27. `hasSimilarJob()` ignores meaningful identity

**Resolved (Phase 3, commit `7d7cc5a`).** `hasSimilarJob` now routes
through `getJobIdentity` and skips cancelled jobs, so distinct work no
longer collapses into one slot. Identity per type:
`haul:b${bid}:r${resource}`, `hunt:a${targetAid}`, `build:b${bid}`,
`craft_bow:b${bid}`, and `${type}:${x},${y}` for sow/chop/mine/forage.
Unknown types return `null` so a future job type without identity
support fails loudly rather than silently aliasing.


**Files/lines**

- `src/app/jobs.js:69-70`
- `src/app/planner.js:902-904`
- `src/app/planner.js:953-960`

Duplicate detection ignores job-specific fields.

### Why this is a problem

Distinct jobs can collapse into one, especially haul/build/hunt/craft jobs.

### Fix direction

Implement `getJobIdentity(job)` and use it everywhere jobs are deduped or suppressed.

---

## 28. Build completion can leave delivered but unused resources in `b.store`

**Resolved (Phase 4).** When `b.built` flips to `1` in `onArrive.js`, any
remaining `b.store.{wood,stone,food}` is returned to `storageTotals` and
the per-building stores are zeroed. With supply-first this should rarely
fire, but it closes the trap and makes the system tolerant to
reservation drift and load-time discrepancies. The intermediate
`requestBuildHauls(b)` call in the partial-consumption branch
(`onArrive.js:314`) and on every successful delivery
(`onArrive.js:403`) was removed; the planner is now the single owner of
haul scheduling.

**Files/lines**

- `src/app/onArrive.js:280-315`
- `src/app/world.js:111-148`

On build completion, the code consumes needed resources but does not explicitly return any excess stored in `b.store`.

### Why this is a problem

With perfect reservations this should not happen. But existing reservation bugs can create excess. Once built, excess material can be trapped inside the building object.

### Fix direction

On completion, return excess to storage or explicitly discard it with a comment. Prefer returning to storage:

```js
storageTotals.wood += b.store.wood || 0;
storageTotals.stone += b.store.stone || 0;
b.store.wood = 0;
b.store.stone = 0;
```

---

## 29. Cancelled deliver-stage haul jobs can linger

**Files/lines**

- `src/app/materials.js:118-136`
- `src/app/onArrive.js:390-419`

`cancelHaulJobsForBuilding()` marks deliver-stage jobs as cancelled but does not remove them immediately.

### Why this is a problem

This may be intended for villagers already carrying resources, but unassigned/stale cancelled jobs can linger, especially after save/load or interruption.

### Fix direction

Differentiate:

- assigned villager carrying matching item: convert to return-supplies behavior
- unassigned job: remove immediately
- stale cancelled job older than N ticks: cleanup

---

## 30. Building activity occupancy is saved as durable building state

**Files/lines**

- `src/app/save.js:59`
- `src/app/world.js:136-141`
- `src/app.js:530-560`

The entire building object is saved, including volatile fields like `activity.occupants`.

### Why this is a problem

Occupants should be derived from villagers currently using the building. Persisting this can create phantom occupancy.

### Fix direction

Serialize stable building fields explicitly. Do not save volatile activity occupancy.

Recommended building save shape:

```js
{
  id,
  kind,
  x,
  y,
  built,
  progress,
  store,
  spent,
  pending
}
```

---

## 31. Villager speed is flattened on load

**Files/lines**

- `src/app/save.js:194-206`
- `src/app/population.js:34-41`

Villagers are created with slight speed variation, but load restores every villager as `speed: 2`.

### Why this is a problem

Individual variation is lost after load.

### Fix direction

Save and restore speed:

```js
sp: v.speed
```

Clamp loaded values to reasonable bounds.

---

## 32. Villager inventory is discarded on load

**Files/lines**

- `src/app/save.js:62-81`
- `src/app/save.js:199-207`

Load sets `inv: null` and save does not persist current inventory.

### Why this is a problem

Any carried item disappears on load. If it was part of a reserved transaction, the accounting may remain corrupted.

### Fix direction

Either save `v.inv`, or convert all carried items to ground/storage during stable checkpoint load. Saving `v.inv` is simplest.

---

## 33. `newWorld()` resets resources but not policy sliders

**Files/lines**

- `src/app.js:317-339`
- `src/policy/policy.js:134-148`
- `src/app/ui.js:148-150`

Policy sliders attach to game state but are not reset by `newWorld()`.

### Why this is a problem

New simulations inherit old food/build/explore priorities, which may surprise the user.

### Fix direction

Decide intentionally:

- preserve policy sliders as user preference, or
- reset them on new world and sync DOM values

Document whichever behavior is chosen.

---

## 34. `activeZoneJobs` only tracks assigned jobs, not queued jobs

**Files/lines**

- `src/app/jobs.js:14-29`
- `src/app/jobs.js:93-107`
- `src/app/render.js:1111`

`activeZoneJobs` changes based on assignment count, not job existence.

### Why this is suspicious

If the overlay is meant to show queued work, it is wrong. If it is meant to show currently assigned work, the name is misleading.

### Fix direction

Rename to `assignedZoneJobTiles`, or add separate `queuedZoneJobTiles`.

---

## 35. `queueAnimalLabel()` depends on render camera during simulation update

**Files/lines**

- `src/app/animals.js:135-148`
- `src/app/tick.js:117-123`
- `src/app/render.js:1045`
- `src/app/render.js:1283`
- `src/app/render.js:998`

Animal labels are converted to screen coordinates at queue time using current camera state.

### Why this is a problem

Simulation update depends on render camera. If the camera moves before draw, label placement is wrong. It also interacts with the earlier label-clearing bug.

### Fix direction

Queue labels in world coordinates:

```js
{ text, color, x, y }
```

Convert to screen coordinates only during render.

---

## 36. Render draws campfire glow for all campfires, even unbuilt ones

**Files/lines**

- `src/app/render.js:1256-1280`

Campfire glow/embers are drawn for every campfire kind without checking whether it is built.

### Why this is a problem

If campfire blueprints are introduced, unbuilt campfires will visually glow and emit embers.

### Fix direction

```js
if (b.kind === 'campfire' && b.built >= 1) {
  // draw glow
}
```

---

## 37. Campfire warmth does not check whether the campfire is built

**Files/lines**

- `src/app/villagerAI.js:79-81`

Campfires are selected by type/kind only, not built status.

### Why this is a problem

Unbuilt campfires could provide warmth/mood effects if campfire blueprints are ever used.

### Fix direction

```js
const fires = buildings.filter(b =>
  b.type === BLDG.CAMPFIRE && b.built >= 1
);
```

---

## 38. Initial stock has multiple sources of truth

**Files/lines**

- `src/app/state.js:31-33`
- `src/app/app.js:329-332`

`state.js` defaults wood to 0, but `newWorld()` starts with wood 12.

### Why this is a problem

Future tuning can happen in one place and be silently overridden by another.

### Fix direction

Move starting resources into one config object.

---

## 39. Planner depends on UI helper `toTile()`

**Files/lines**

- `src/app/planner.js:390-393`
- `src/app/ui.js:211`

Planner zoning uses `toTile()`, which belongs to UI coordinate conversion.

### Why this is a problem

Simulation logic depends on UI helper semantics. If UI coordinate logic changes, planner behavior can break.

### Fix direction

Move coordinate/grid helpers to a neutral module or use `Math.floor()` locally where appropriate.

---

## 40. Full-map scans happen frequently

**Files/lines**

- `src/app/planner.js:856-875`
- `src/app/app.js:656-690`
- `src/policy/policy.js:150-152`

The world appears to be `192 x 192`, or 36,864 tiles. Several systems scan large tile arrays frequently.

### Why this is a problem

This may work now, but it can become mobile frame stutter as simulation complexity grows.

### Fix direction

Add caches/indexes:

- farm tile list
- ripe crop list
- chop zone tile list
- mine zone tile list
- reachable resource candidates
- dirty-region updates

---

# Implementation Order

## Phase 1: Stabilize persistence

Goal: loading a game must not corrupt the economy.

Tasks:

1. Add save schema version.
2. Save and restore global time.
3. Save and restore `itemsOnGround`.
4. Decide checkpoint vs snapshot save.
5. For checkpoint save:
   - clear jobs on load
   - reset villager target jobs/paths/active building IDs
   - clear building activity occupants
   - reset or recompute `storageReserved`
   - clear/rebuild building pending if needed
6. Avoid saving volatile building `activity.occupants`.
7. Either save villager inventory or return it safely during load.
8. Add save/load smoke tests.

## Phase 2: Repair resource registry and storage helpers

**Status: Done (commit `b3ef1df`).** Pelt is now a first-class resource;
`RESOURCE_TYPES` and `ITEM_COLORS` in `constants.js` are the single source of
truth used by `state.js`, `newWorld()`, save/load, deposit, and rendering.
`materials.js` exposes the four helpers below. `tryEquipBow` reserves on
intent, and `onArrive` closes the bow reservation through
`spendCraftMaterials` (only releases explicitly when storage vanishes
mid-trip, so it can't double-release another villager's reservation).
This addresses critical issues **#6**, **#12**, and **#13**. Issue **#38**
(starting-stock duplication between `state.js` and `newWorld()`) is
explicitly deferred and tagged with a comment in `app.js`.

Goal: every resource type has one consistent lifecycle.

Tasks:

1. Decide whether `pelt` is real.
2. If real, add `ITEM.PELT`, storage totals, reservations, rendering, save/load, and deposit support.
3. Replace hardcoded deposit branches with generic item deposit where possible.
4. Separate helpers:
   - reserve resources
   - release reservations
   - spend reserved resources
   - directly take from storage
5. Fix bow pickup to reserve or directly take stock safely.

## Phase 3: Repair job identity, dedupe, and suppression

**Status: Done (commit `7d7cc5a`).** `getJobIdentity(job)` in
`src/app/jobs.js` is the single source of truth for job identity, used
by `hasSimilarJob`, `isJobSuppressed`, and `suppressJob`. Identity
fields are chosen per type: hauls include `bid+resource`, hunts key on
`targetAid`, build/craft jobs key on `bid`, and zone work keys on
`x,y`. `hasSimilarJob` skips `cancelled` jobs so deliver-stage
tombstones no longer block their replacements (partial fix for #29 —
full lifecycle redesign deferred). The dead `jobKey` export was
removed from `src/app.js`. Resolves critical issues **#4**, **#26**,
and **#27**.

Tests live in `tests/jobs.identity.test.js` and run via `npm test`
(Node's built-in test runner, no new dependencies). Coverage includes
the wood+stone case the audit explicitly asked for, hunt suppression
across position changes, cancelled-tombstone replacement, and dedupe
by bid/coords.

Goal: different jobs should not collapse into the same key.

Tasks:

1. Add `getJobIdentity(job)`.
2. Include job-specific payload:
   - resource
   - stage
   - building ID
   - target animal ID
   - craft recipe
   - tile coordinates where relevant
3. Use this identity for:
   - `hasSimilarJob()`
   - `jobKey()`
   - suppression
   - stale cleanup
4. Add tests for wood+stone haul jobs existing for the same building.

## Phase 4: Clarify construction lifecycle

**Status: Done.** The user picked **supply-first** as the construction model.
Build jobs are now gated on `buildingSupplyStatus(b).fullyDelivered` in
`src/app/planner.js:973-998`. `pickJobFor()` and
`scoreExistingJobForVillager()` in `src/app/villagerAI.js` are pure
reads — neither calls `requestBuildHauls()` and neither writes
`j.waitingForMaterials` while scoring. The "assist haul" branch that
let a villager evaluating a build job grab an unrelated haul was
removed. On build completion in `src/app/onArrive.js`, leftover
`b.store.{wood,stone,food}` is returned to `storageTotals`, closing
issue #28. Reactive `requestBuildHauls(b)` calls inside `onArrive.js`
(both the partial-consumption branch and the post-delivery branch) were
removed; the planner's own `generateJobs()` re-requests hauls each tick
when a building still lacks reservation. `requestBuildHauls` is no
longer wired into `createVillagerAI` or `createOnArrive` in
`src/app.js`. Resolves critical issues **#11**, **#14**, and **#28**.

Tests live in `tests/build.supply.test.js` and
`tests/materials.haul.test.js` and run via `npm test` (Node's built-in
test runner, no new dependencies). They cover: `buildingSupplyStatus`
edge cases (mixed pending vs store, zero-cost campfire, mid-build
state), `requestBuildHauls` shortfall accounting against `b.store +
b.pending`, the no-op cases (already-reserved, already-built), and the
`availableToReserve` cap on haul `qty`.

**Deferred:** Issue **#9** (`reservedWoodForPlans` double-count in
`ensureStarterBuildings()`) is tangential to supply-first and not yet
addressed. Issue **#29** (deliver-stage haul tombstones lingering after
`cancelHaulJobsForBuilding`) is partially mitigated by Phase 3 already
skipping cancelled jobs in `hasSimilarJob`, but the full lifecycle
redesign — converting carrying-villager tombstones into return-supplies
behavior and aging out unassigned tombstones — remains open.

Tasks (completed):

1. Choose supply-first or staged-construction model. **Supply-first.**
2. Recommended first implementation:
   - haulers fully supply building
   - build job appears only when fully supplied
   - builder completes building after all resources delivered
3. Return or clear excess `b.store` on completion.
4. Keep `requestBuildHauls()` out of job scoring/evaluation.

## Phase 5: Repair farming lifecycle

**Status: Done.** Resolves critical issues **#15** (ripe crops
permanently stranded) and **#16** (sow/harvest over-enabled).

`getJobIdentity` in `src/app/jobs.js` now includes `harvest` (keyed as
`harvest:${x},${y}`). `src/app/planner.js` adds `countPlantedTiles()`
alongside `hasRipeCrops`/`hasAnyFarmTiles`; `shouldGenerateJobType`
splits the sow and harvest cases — harvest is unconditional (the
FARMLAND scan is the gate), sow gates on a planted-tile target driven
by `cfg.plantedTilesPerVillager` (default `1.5`, added to
`DEFAULT_JOB_CREATION` in `src/policy/policy.js`). `generateJobs()`
emits harvest from the existing tile loop guarded by `world.tiles[i]
=== TILES.FARMLAND && world.growth[i] >= 150` — keyed on FARMLAND, not
zone, so a dezoned-but-sown tile is still harvested. `forageNeed` now
keeps the `!hasRipeCrops()` branch but ANDs it with `foodOnHand <
villagerCount * 3` so forage is a real food-pressure fallback rather
than constant competition. `seasonTick` is unchanged: it stays as the
fast-path emitter (emits exactly at the threshold crossing) while the
planner catches up idempotently.

Tests live in `tests/farming.lifecycle.test.js` and run via `npm test`
(Node's built-in test runner, no new dependencies). Coverage:
harvest dedupe at the same tile, re-emission after removal,
re-emission after `cancelled = true`, harvest+sow at the same tile
coexisting (different identity keys), and harvest suppression
following coordinates with tick-based expiry.

Tasks (completed):

1. Generate harvest jobs idempotently whenever ripe crops exist.
2. Generate sow jobs only when empty farm tiles should be planted.
3. Use a planted target based on food pressure/population.
4. Keep forage as a fallback, not constant competition with farming.

## Phase 6: Remove old hunting shortcuts

Goal: formal hunting should own meat generation.

Tasks:

1. Remove ambient animal-hunting food creation, or make it non-food behavior.
2. Ensure hunting requires intended conditions such as hunter, bow, job, target animal.
3. Ensure animal death/removal/yield is consistent.
4. Fully wire `pelt` or remove it.

## Phase 7: UI/runtime robustness

Goal: missing DOM elements and boot failures should produce clean errors.

Tasks:

1. Add `requireElement(id)` or safe event binding helpers.
2. Fix `canvas.js` missing canvas fatal path.
3. Expose or import `reportFatal` properly for `main.js`.
4. Add `syncTimeButtons()` and call it after new/load/time changes.
5. Add `newWorld(seed, { silent })` and use silent mode during load.
6. Split `generateWorldBase()` from `initializeNewGame()`.

## Phase 8: Performance and observability

Goal: reduce invisible stalls and make sim debugging easier.

Tasks:

1. Cache farm/chop/mine tile lists.
2. Cache ripe crop candidates.
3. Add debug counters:
   - total jobs by type
   - assigned jobs by type
   - resources by location: storage, reserved, ground, villager inventory, building store, pending
   - stuck/cancelled jobs
4. Add a resource invariant check:
   - no negative totals
   - no reservation without owner or durable pending reason
   - no unknown item type in ground/inventory/storage
5. Add a one-button debug dump for current economy state.

---

# Suggested Tests / Smoke Checks

Create minimal tests or debug assertions for these scenarios.

## Save/load resource persistence

1. Drop wood on ground.
2. Save.
3. Load.
4. Confirm wood still exists on ground.

## Reservation cleanup

1. Create a building requiring wood/stone.
2. Generate hauls.
3. Save before completion.
4. Load.
5. Confirm reservations are either restored with owning jobs or cleared/rebuilt safely.

## Multi-resource building hauls

1. Place a building requiring wood and stone.
2. Generate build hauls.
3. Confirm both wood and stone haul jobs can coexist.

## Bow pickup

1. Put one bow in storage.
2. Have two villagers try to equip.
3. Confirm only one reserves/claims the bow and the other does not waste a trip indefinitely.

## Crop recovery

1. Create mature crop with no harvest job.
2. Run job generation.
3. Confirm harvest job is created.

## Pelt handling

If pelts are kept:

1. Drop pelt.
2. Villager picks up pelt.
3. Villager deposits pelt.
4. Storage pelt count increases.
5. Save/load preserves pelt count.

If pelts are removed:

1. Hunting should never drop unknown item types.

## Job identity

1. Create two haul jobs for same building but different resources.
2. Confirm dedupe does not remove either.
3. Suppress one and confirm the other remains valid.

## Building occupancy load

1. Save while villager is using a building.
2. Load.
3. Confirm no phantom `activity.occupants` exists unless exact snapshot behavior is fully implemented.

---

# Agent Notes

When implementing fixes, avoid broad rewrites unless a subsystem needs one. Prefer small, testable patches.

Most important invariant:

> A resource should be counted exactly once across storage, reserved ownership, ground items, villager inventory, building store, or pending transaction state.

Second invariant:

> A reservation must either have an active owner or be reconstructible from durable building/pending state. Otherwise it must not survive load.

Third invariant:

> Job identity must include the fields that make the job unique. Same tile does not mean same work.

Fourth invariant:

> Save/load must intentionally choose between exact snapshot and stable checkpoint. Do not preserve random volatile fragments while discarding others.

