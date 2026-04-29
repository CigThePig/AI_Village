# AI_Village — Villager Intelligence & Settlement Coherence Plan

## Context

The previous fix plan (now retired) finished shipping all 12 bug-fix phases. With correctness in place, the simulation is now ready for a feature pass focused on what the user actually wants to *watch*.

The objective for this plan:

> Villagers should feel more intelligent, more interesting to watch, and should interact more with their environment. Building placement and crop placement should not feel ugly or random. Every settlement should look different but coherent.

Today's simulation falls short of that bar in three ways:

1. **Placement is reactive scoring with no layout intent.** `findPlacementNear()` (`src/app/planner.js:135-259`) ranks tiles within an 18-tile radius using per-type bonuses. There is no archetype, no slot reservation, no spacing rule, no inter-building composition. Two seeds produce different terrain but settlements that look like the same blob with different rocks.
2. **Idle behavior is a flat cascade with thin leaves.** `chooseIdleBeforeJobs`/`chooseIdleAfterJobs` in `src/app/villagerAI.js` end in roam, sleep, hydrate, social, storage_idle. There is no sitting, no decoration interaction, no child play, no animal-watching beyond a passive mood tick. Watching a villager between jobs is mostly watching them walk in a small circle.
3. **Every villager scores the world the same way.** Roles affect skill weights, but `src/ai/scoring.js` runs the same ~25-dimension formula for every villager. Two villagers in identical states make identical choices.

This plan ships **5 phases that upgrade existing logic, 5 phases that extend current content, and 2 phases that introduce new content**, in that order. Each phase is one PR with tests, matching the project rule from `CLAUDE.md`.

## Cross-cutting guardrails (every phase honors)

These are the rules that prevent half-shipped phases from passing review:

- **Deterministic RNG hygiene.** Every random draw threads through `src/app/rng.js` (`mulberry32`, `hash2`). No `Math.random()`. Snapshot tests must run a fixture twice and assert byte-equal world state.
- **Save migration discipline.** Every phase that changes persisted shape bumps `SAVE_VERSION` in `src/app/constants.js` and adds a `SAVE_MIGRATIONS` entry that drops the now-incompatible sub-tree (per the project rule: old saves may break, but `loadGame` must not crash).
- **Policy lives in `src/policy/policy.js`.** New constants go there, never inlined.
- **Visual gate for placement/composition phases.** Phases 1, 2, 5, 6, 8, and 12 must include a deterministic structural snapshot test (e.g., layout-archetype hash differs across two seeds) — not just a "code path executed" test.
- **Debug overlay coverage.** Phases 1, 2, 5, and 11 add data layers to `public/debugkit.js` so reviewers can see slot boundaries, plot rectangles, traffic heatmaps, and relationship lines without reading code.
- **Perf budget.** At 50 villagers, a tick must stay under the existing budget. Phases 4, 5, and 11 are the perf-sensitive ones (per-villager scoring weights, A* path-tile lookups, relationship reads inside scoring). Each ships with a micro-benchmark assertion in tests.
- **Lint and tests after every change in a phase.** `npm run lint && npm test` (matches the existing project rule).

## Phase order at a glance

| # | Bucket | Phase | Hard dependency |
|---|--------|-------|-----------------|
| 1 | Upgrade | Settlement layout templates | — |
| 2 | Upgrade | Coherent farm plots | 1 |
| 3 | Upgrade | Idle behavior tree | — |
| 4 | Upgrade | Personality-weighted scoring | — |
| 5 | Upgrade | Emergent paths and roads | 1 |
| 6 | Extend | New buildings (tavern, workshop, granary) | 1 |
| 7 | Extend | Crop and forage variety | — |
| 8 | Extend | Animal diversity and domestication pens | 1 |
| 9 | Extend | Named professions and sprite variants | 6 (workshop) |
| 10 | Extend | Weather and seasonal events | 6 (tavern), 7 (crops) |
| 11 | New | Relationships, family, and memory | 1 (housing slots), 3 (idle leaves) |
| 12 | New | Travelers, trade, and cultural identity | 11 (joinable NPCs) |

Phase details follow.

---

## Upgrade existing logic

### Phase 1 — Settlement layout templates

**Why.** Today every settlement is a center-blob: campfire at map-center, storage adjacent, everything else placed by `findPlacementNear()` scoring within 18 tiles. Different seeds produce different *terrain* but the same settlement *shape*. The user's "different but coherent" bar is impossible without a deliberate layout intent.

**What.** Introduce a small archetype registry — `radial`, `ribbon`, `terrace`, `courtyard` — selected per seed from terrain features (water orientation, slope, tree density). Each archetype defines named anchor slots (e.g., `hearth`, `storage`, `housing-ring-N/E/S/W`, `craft`, `wells`, `livestock`, `fields`). Buildings claim a slot by kind; placement scoring still tie-breaks within the slot's footprint.

**Critical files.**
- `src/app/planner.js` — replace the body of `findPlacementNear()` with a slot lookup; keep tile-scoring only as a within-slot tie-breaker.
- `src/app/world.js` — extend world struct with `layout: { archetype, anchors, slots }`.
- `src/app/constants.js` — bump `SAVE_VERSION`; add archetype enum.
- `src/policy/policy.js` — archetype selection weights, slot capacities, per-archetype building affinity.
- `src/app/rng.js` — reuse `mulberry32` for archetype roll; no new RNG.
- `public/debugkit.js` — slot overlay (toggle key) showing slot footprints and assignments.

**Acceptance criteria.**
- Same seed → identical archetype + slot table across runs (deterministic snapshot test).
- Two distinct seeds → archetype-hash differs, and slot-position diff > threshold.
- Visual side-by-side at fixed tick on three seeds shows categorically different layouts (radial vs. ribbon vs. courtyard), not jitter on a center-blob.
- Existing 6 building kinds all route through the slot system; no regressions in the progression-tier order.

**Anti-corner-cut clause.** A "template" that is just three placement-bias presets fails this phase. The acceptance test must compare *layout-archetype hashes*, not just code-path execution.

---

### Phase 2 — Coherent farm plots

**Why.** `ensureZoneCoverage()` (`src/app/planner.js:261-389`) grows FARM zones organically by ranking individual tiles. Result: blobby clusters that look like wild patches, not fields. With Phase 1 anchors in place, farms can be placed as rectangular plots aligned to the `fields` slot.

**What.** Replace organic zone expansion with rectangular plot blocks. Each plot is sized from policy (min 3×3, max 6×6), oriented along the dominant axis of the terrain (or the path connecting `fields` to `wells`/`hearth`). Plots share at least one edge with another plot or with a path/road tile so they read as a contiguous farmland district. Crops grow in visible rows along the plot's long axis.

**Critical files.**
- `src/app/planner.js` — replace `ensureZoneCoverage()` for FARM with `layoutFarmPlots()`; keep CUT/MINE on the legacy path for now.
- `src/app/constants.js` — bump `SAVE_VERSION`; add per-plot save shape.
- `src/app/render.js`, `src/app/tileset.js` — render crop sprites in row-aligned positions inside a plot.
- `src/policy/policy.js` — plot dimension bounds, alignment policy.

**Acceptance criteria.**
- Every FARM zone tile belongs to exactly one rectangular plot whose bounding box is axis-aligned and contiguous.
- No plot smaller than the policy minimum.
- At least one plot per settlement abuts a `wells` or `farmplot` slot from Phase 1.
- Sow/harvest job generation unchanged in throughput at 20 villagers (perf assertion).

**Anti-corner-cut clause.** Rectangular plots dropped on terrain with no neighbor relationships still look "Minecraft-y." The edge-adjacency rule above is mandatory.

---

### Phase 3 — Idle behavior tree

**Why.** The two flat cascades in `villagerAI.js` (`chooseIdleBeforeJobs`, `chooseIdleAfterJobs`) decide priority by code position, with no per-villager state and no easy slot for new leaves. We need a behavior tree skeleton both to make idle decisions readable and to give later phases (8, 10, 11) a place to plug new leaves in.

**What.** Refactor the two cascades into a small priority-ordered behavior tree with named leaves: `equipBow`, `restFatigue`, `nightSleep`, `hydrate`, `socialNight`, `storageIdle`, `socialDay`, `roam`. The skeleton is refactor-equivalent — same outcomes for the same inputs — but introduces per-villager `aiState.btCursor` / `aiState.btLastLeaf` and per-leaf cooldowns, so subsequent phases can add new leaves (sit-by-fire, watch-animal, child-play) without touching control flow.

**Critical files.**
- `src/app/villagerAI.js` — replace cascades with `runIdleBT(villager, world, ctx)`.
- `src/ai/blackboard.js` — expose any flags the BT needs (e.g., `nearCampfire`, `nearWell`).
- `src/app/constants.js` — bump `SAVE_VERSION`; add `aiState` shape.
- `src/policy/policy.js` — per-leaf cooldowns and priority weights.

**Acceptance criteria.**
- Refactor-equivalence: in a fixed scenario fixture, the BT produces the same idle outcomes as the legacy cascade across 500 ticks (assert leaf-by-leaf).
- New leaves can be added by appending to a single registry, no control-flow edits.
- Per-leaf cooldowns honored.

---

### Phase 4 — Personality-weighted scoring

**Why.** `scoring.js` applies the same weight vector to every villager. Roles modify skill levels (which feed *into* the formula) but not the formula itself. Two villagers in identical world states cannot diverge.

**What.** At villager birth (`src/app/population.js`), roll a small trait set (`gregarious`, `solitary`, `curious`, `lazy`, `diligent`) and derive a per-villager weight override map. `scoreJob()` reads the per-villager override before falling back to policy defaults. Idle BT (Phase 3) also reads traits — gregarious villagers shorten social cooldown, solitary villagers extend it, curious villagers prefer roam over storage_idle, lazy villagers raise the rest-trigger threshold.

**Critical files.**
- `src/app/population.js` — birth-time trait roll, persisted to villager.
- `src/ai/scoring.js` — per-villager override lookup before policy default.
- `src/app/villagerAI.js` — trait reads in BT.
- `src/policy/policy.js` — trait base weights and roll probabilities.
- `src/app/constants.js` — bump `SAVE_VERSION`; villager `traits` field.

**Acceptance criteria.**
- Two villagers with opposing traits in identical fixture state pick different jobs over 200 ticks (stat divergence above threshold).
- Per-villager scoring stays within perf budget at 50 villagers (micro-benchmark).
- No global behavior regression — population averages match Phase 3 baselines within tolerance.

**Anti-corner-cut clause.** Resist adding visible trait UI in this PR. The behavioral change is the feature; UI is a separate ticket.

---

### Phase 5 — Emergent paths and roads

**Why.** Settlements have no roads. Even with Phase 1's slot layout and Phase 2's plot grids, the ground between buildings is grass. Roads should emerge from where villagers actually walk and should differ across seeds because slot anchors differ.

**What.** Add a new `PATH` tile type. Track a per-tile traffic counter, but only increment when a villager is walking *between two named hubs* (slot anchors from Phase 1: hearth/storage/wells/housing/craft/fields). When a tile's counter passes a threshold, convert it to PATH. A* path cost prefers PATH (positive feedback). A nightly thinning pass demotes PATH tiles with fewer than two PATH neighbors to prevent spaghetti.

**Critical files.**
- `src/app/constants.js` — add `PATH` to tile enum; bump `SAVE_VERSION`.
- `src/app/pathfinding.js` — A* cost lookup honors PATH discount.
- `src/app/world.js` — traffic counter array; thinning pass.
- `src/app/villagerTick.js` — increment counter only on hub-to-hub legs.
- `src/app/render.js`, `src/app/tileset.js` — PATH tile sprite distinct from grass.
- `public/debugkit.js` — traffic heatmap overlay.

**Acceptance criteria.**
- After N ticks of forced traffic between two hubs in a fixture, a contiguous PATH chain exists between them.
- A* cost on the chain is strictly less than cost on parallel non-path tiles.
- Thinning pass removes spurs (path tiles with <2 path neighbors after settling).
- PATH tiles render visibly distinct from grass.

**Anti-corner-cut clause.** "Any tile walked > 50 times" produces spaghetti. The hub-to-hub rule and the thinning pass are both mandatory.

---

## Extend current content

### Phase 6 — New buildings: tavern, workshop, granary

**Why.** The current 6-building roster is survival-shaped: hut, storage, well, farmplot, hunter lodge, campfire. There is no social building beyond the campfire (which gets crowded as population scales) and no specialization buildings. These three slot naturally into the Phase 1 archetypes' `craft` and `gather` slots.

**What.**
- **Tavern.** Replaces the campfire as the primary night-social destination once population ≥ ~8. Larger occupancy, mood bonus per occupant, evening bias toward `socialNight` BT leaf.
- **Workshop.** Crafts simple tools (axe, hoe, hammer) consumed by villagers as a small per-job work-effort multiplier. Adds `craft_tool` job type.
- **Granary.** Specialized food storage with light spoilage on the main `storage` building's food tier; granary food does not spoil. Encourages building a granary for winter prep.

Each is integrated through existing systems: progression tier in `policy.js`, footprint in `world.js`, slot affinity in Phase 1's slot table, render in `tileset.js`/`render.js`.

**Critical files.**
- `src/app/world.js` — building footprints and effects.
- `src/app/planner.js` — progression tier additions; slot affinity for the three new kinds.
- `src/app/jobs.js` — `craft_tool`, deliver-to-tavern, food-haul-to-granary.
- `src/app/materials.js` — tool material; spoilage on non-granary food.
- `src/app/constants.js` — bump `SAVE_VERSION`; new building kinds.
- `src/policy/policy.js` — tier gates, mood bonuses, spoilage rate, tool multiplier.

**Acceptance criteria.**
- Tavern, workshop, granary each placed by Phase 1's slot table on appropriate seeds.
- Once tavern is built, ≥80% of `socialNight` idle visits route to tavern instead of campfire.
- Workshop output applied as a measurable work-effort delta on the next builder's job.
- Food in granary does not spoil; food in main storage does (slow rate).

---

### Phase 7 — Crop and forage variety

**Why.** Today there is one crop. Seasonal events (Phase 10) and granary preservation (Phase 6) are flat without variety.

**What.** Add three crops — **wheat**, **beets**, **herbs** — with distinct growth rates, yields, and season profiles (e.g., beets prefer autumn, herbs are year-round but low-yield). Wild **mushrooms** and **wild herbs** are forageable. Sow jobs select a crop based on season and current need (food gap → calorie crops, surplus → herbs). Each crop renders distinctly along plot rows from Phase 2.

**Critical files.**
- `src/app/world.js` — per-tile crop type; per-tile growth state extended.
- `src/app/planner.js` — sow job selects crop type; harvest yield switches.
- `src/app/materials.js` — yield types per crop.
- `src/app/render.js`, `src/app/tileset.js` — crop sprites in row positions.
- `src/app/constants.js` — bump `SAVE_VERSION`; crop type enum.
- `src/policy/policy.js` — per-crop growth/yield/season tables.

**Acceptance criteria.**
- Each crop type plants only in its valid season window.
- Yields match policy table within tolerance.
- Foragable mushrooms/herbs respawn at the configured cadence.
- Plot rendering shows row-aligned, per-crop visuals from Phase 2's plots.

---

### Phase 8 — Animal diversity and domestication pens

**Why.** Two animals (deer, boar) and no pets/livestock. The user's "more interaction with environment" calls out animals as a primary surface; pens additionally feed Phase 10's seasonal events and Phase 6's granary.

**What.**
- **Wildlife additions.** `rabbit` (small, fast, low-yield, common), `fox` (skittish, semi-rare, predator on chickens once pens exist), `bear` (rare, large, dangerous at night → triggers villager-grouping BT bias).
- **Pens.** New building kind `pen` with `chicken` and `sheep` variants (chosen at build time based on materials available). Periodic yields: chickens → eggs (food), sheep → wool (new material; future-extensible). Pens slot into Phase 1's `livestock` slot.
- **New idle leaf.** `watchAnimal` plugs into Phase 3's BT; villagers occasionally pause near grazing animals for a small mood gain — visible behavior, not just a passive tick.

**Critical files.**
- `src/app/animals.js` — per-species behavior config (rabbit/fox/bear).
- `src/app/world.js` — pen footprint and effects.
- `src/app/villagerAI.js` — `watchAnimal` BT leaf; bear-night grouping bias.
- `src/app/jobs.js` — collect-pen-yield job.
- `src/app/materials.js` — `wool`, `egg`.
- `src/app/constants.js` — bump `SAVE_VERSION`; species + pen kinds.
- `src/policy/policy.js` — yield cadence, bear threat radius.

**Acceptance criteria.**
- Each new species has its own behavior fixture test (rabbit flees small radius, fox flees large, bear stands ground until close).
- At night with bear within radius, villagers shorten roam and bias toward hut/tavern BT leaves.
- Pen produces yield at expected cadence; haul job collects it.
- `watchAnimal` leaf fires in fixtures with grazing animals nearby.

---

### Phase 9 — Named professions and sprite variants

**Why.** "Roles" are 25%-each random labels with soft skill biases. There is no career, no visible specialization, and the user can't tell at a glance who does what.

**What.** Promote roles into named professions: **Farmer, Builder, Hunter, Forager, Mason, Cook**. Profession is derived from the experience ledger (highest-XP job family wins, with a hysteresis margin) plus role at birth as a starting bias. Profession affects sprite — tool/hat overlay (hoe for farmer, hammer for builder, bow for hunter, basket for forager, chisel for mason, ladle for cook). Job scoring (`scoring.js`) gains a profession-affinity term so a Builder picks build jobs over chop jobs at equal score.

Tools come from the workshop (Phase 6); apprenticeship is **out of scope** for this phase to keep scope tight (deferred to a future plan if the user wants it).

**Critical files.**
- `src/app/population.js` — derive profession from XP ledger; persist on villager.
- `src/ai/scoring.js` — profession-affinity term.
- `src/app/render.js`, `src/app/tileset.js` — tool/hat overlay sprites per profession.
- `src/app/ui.js` — profession label in info panel.
- `src/app/constants.js` — bump `SAVE_VERSION`; profession enum.
- `src/policy/policy.js` — profession affinity weights, hysteresis margin.

**Acceptance criteria.**
- Profession persists across save round-trip.
- A Builder in identical state picks build over chop at margin ≥ policy-defined threshold.
- Sprite variant rendered for each profession (visual snapshot test optional).
- No villager flips profession more than once per N ticks (hysteresis).

---

### Phase 10 — Weather and seasonal events

**Why.** Seasons currently change tile tints but nothing else. Tavern (Phase 6), crops (Phase 7), and animals (Phase 8) all set the table for events that make a year feel like a year.

**What.**
- **Weather.** `clear`, `rain`, `fog`, `snow`. Rain mildly slows movement (×0.9) and accelerates crop growth (×1.1). Fog reduces hunter lodge effective radius. Snow accumulates in winter, blocking tile bonuses on snowed-over fertile tiles.
- **Seasonal events.** Spring **planting day** (sow jobs spike, social leaf bias toward fields). Autumn **harvest festival** (multi-villager gathering at tavern, mood spike, granary bonus). Winter **solstice** (everyone gathers at hearth/tavern at night, mood spike).

Events reuse the Phase 3 BT (idle leaf bias) and Phase 6 tavern (gathering destination). Weather is an ambient state read by movement (`villagerTick.js`), pathfinding, and render (`render.js` tints/particles).

**Critical files.**
- `src/app/environment.js` — weather state machine, event scheduler.
- `src/app/villagerTick.js` — movement multiplier from weather.
- `src/app/villagerAI.js` — event-driven BT leaf bias.
- `src/app/render.js` — weather particles and snow accumulation overlay.
- `src/app/constants.js` — bump `SAVE_VERSION`; weather enum, event ids.
- `src/policy/policy.js` — weather probabilities, event windows, mood deltas.

**Acceptance criteria.**
- Rain in fixture reduces average movement speed by configured amount.
- Each event fires within the right season window and biases the right BT leaf.
- Snow accumulates only in winter and clears at thaw.
- Save round-trip preserves weather state and pending event timer.

---

## New content

### Phase 11 — Relationships, family, and memory

**Why.** Pregnancy exists, but there is no notion of who is friends with whom, no family tree, no event memory. Villagers act like interchangeable agents. The user wants them to feel *interesting*, and persistent inter-villager state is the cheapest way to make every villager an individual you can track over time.

**What.**
- **Relationship graph.** Sparse adjacency `relationships[villagerA][villagerB] = { kind, strength }` with `kind ∈ {friend, rival, spouse, parent, child}`. Built up from co-occurrence at social leaves (Phase 3 + 6 tavern) and from pregnancy outcomes.
- **Memory log.** Per-villager bounded ring buffer of small events: `{type, tick, otherId?, mood?}`. Examples: `helped_on_hunt`, `ate_together`, `witnessed_storm`, `lost_friend`. Memories decay in influence over time; recent memories shift mood and scoring (rival proximity nudges mood down; spouse co-location nudges mood up).
- **Family housing.** Phase 1's `housing` slot becomes family-aware: when a hut is built, the slot table prefers placing the new hut adjacent to family members' huts.
- **Lineage persistence.** Family tree round-trips through save (this is the only meaningful save-format addition; per-tick state stays ephemeral).

**Critical files.**
- `src/app/population.js` — relationship updates on pregnancy, memory append on shared events.
- `src/app/villagerTick.js` — memory append for ambient events; mood deltas from relationships.
- `src/ai/scoring.js` — rival/friend proximity term.
- `src/app/planner.js` — family-aware slot selection inside Phase 1's `housing` slot.
- `src/app/save.js` / `src/app/constants.js` — bump `SAVE_VERSION`; persist relationships and family tree.
- `public/debugkit.js` — relationship-line overlay.
- `src/policy/policy.js` — memory decay rate, relationship weight in scoring, family adjacency bonus.

**Acceptance criteria.**
- Relationship graph round-trips through save.
- Memory ring buffer respects the size cap; oldest entries fall off.
- In a fixture, a villager's mood is measurably lower when adjacent to a rival vs. a stranger.
- A new hut for a parent of an existing villager is placed adjacent to the child's hut at least N% of the time (family adjacency rule observable, not just code-pathed).

**Anti-corner-cut clause.** A relationship graph that no behavior reads is worse than no graph. This phase must include at least *one* visibly observable consequence — family adjacency in housing slots is the chosen one.

---

### Phase 12 — Travelers, trade, and cultural identity

**Why.** Settlements are closed systems. There is no outside world, no other peoples, no flavor that distinguishes one seed's *culture* from another's. This is the highest-leverage phase for "every settlement should look different but coherent" because it adds a culture id that several visual systems index off.

**What.**
- **Travelers.** Periodically (policy-driven cadence), a `traveler` entity spawns at a settlement edge tile, A*-paths to storage, exchanges goods, and exits. Traveler kinds: `trader` (offers rare seeds for surplus food/wood), `wanderer` (offers to join the village permanently if welcomed). Wanderers join via Phase 11's relationship onboarding (introduced as a stranger; relationship strength grows on first social events).
- **Trade.** Trade transaction adjusts inventories at storage. Rare seeds unlock additional crop variants from Phase 7 over time.
- **Cultural identity.** Each seed picks a `culture` id at world generation, which simultaneously selects: a **palette** (building accent color), a **name pool** (villager naming), and a **building flourish** (e.g., roof tile variant, fence style). All three index off the same culture id, so different seeds *feel* like different cultures — not just different names.

**Critical files.**
- `src/app/animals.js` or new `src/app/travelers.js` — traveler entity behavior (modeled on animals' state machine).
- `src/app/jobs.js` — trade-with-traveler job; welcome-wanderer job.
- `src/app/world.js` — culture id at worldgen; palette/name/flourish lookup.
- `src/app/render.js`, `src/app/tileset.js` — culture-indexed building flourishes and palette tints.
- `src/app/population.js` — naming uses culture's name pool; wanderer onboarding.
- `src/app/save.js` / `src/app/constants.js` — bump `SAVE_VERSION`; persist culture id, traveler queue.
- `src/policy/policy.js` — traveler cadence, culture roll, trade tables.

**Acceptance criteria.**
- Traveler arrives at a determined edge tile, reaches storage via A*, and exits within the configured time window.
- Trade transaction adjusts both inventories correctly; rare seed unlocks a new crop type from Phase 7.
- Culture id determines palette + name pool + building flourish deterministically per seed (snapshot test).
- Three different culture seeds at fixed tick are visually distinct in palette and flourish, not just name.
- Wanderer join flow goes through Phase 11 relationship onboarding (stranger → friend after N social events).

**Anti-corner-cut clause.** A culture-id that only swaps names fails this phase. Palette and at least one building flourish must also index off the culture id, and the snapshot test must prove all three indices change together across seeds.

---

## Verification

Each phase ships with its own tests under `tests/` following the existing convention `<system>.<feature>.phaseN.test.js`. End-to-end verification across the plan:

1. **Run the full suite after every phase:** `npm run lint && npm test`.
2. **Visual smoke test after Phases 1, 2, 5, 6, 8, 12:** start `npm run dev`, load three distinct seeds, advance time, confirm settlements look categorically different and each looks coherent. The DebugKit overlay (`?debug=1`) should expose slot boundaries (Phase 1), plot rectangles (Phase 2), traffic heatmap (Phase 5), and relationship lines (Phase 11).
3. **Save round-trip after every save-shape change:** load an old save (post-bump) and confirm `loadGame` returns false cleanly without crashing — game starts fresh per the project rule. Save-then-load on a new save must be byte-equal in deterministic fields.
4. **Perf budget after Phases 4, 5, 11:** the per-phase micro-benchmark must hold the 50-villager tick under the existing budget.
5. **End-to-end intelligence check after Phase 11:** in a 2000-tick fixture, two seeded villagers with opposing traits and different relationships diverge in mood, jobs taken, and idle leaf distribution above policy-defined thresholds. This is the closest single test to the user's "interesting to watch" goal.

Phases 1–5 alone should make the user's first complaint ("placement is ugly and random") visibly resolved on `npm run dev`. Phases 6–10 fill the simulation with things to watch. Phases 11–12 turn each villager and each settlement into something specific.

