# AI_Village — Phased Fix Plan

Each phase is scoped to ship as a single PR with tests. Phases are ordered so that
later phases aren't observing or measuring against bugs the earlier phases fixed.
Within a phase, issues are themed.

Issue IDs reference `AI_VILLAGE_AUDIT.md`.

---

## Phase 1 — Time persistence (foundation)

**Why first:** Every later fix gets validated by save/load testing. Right now,
save/load throws away `tick` and `dayTime`, which corrupts every `nextX` cooldown
field. Testing any other fix across a save boundary gives misleading results
because cooldowns either fire instantly or never fire. This must be solid
before anything else.

**Issues in this phase:**
- **B20** — `tick` and `dayTime` are not saved or restored. Cooldowns stored as
  absolute tick values become invalid on load.
- **B19** — `nextPregnancyTick` is not in the save record (not even attempted).
  After load, every adult is immediately fertile.
- **S15** — `restTimer`, `targetJob`, and other transient fields aren't restored
  consistently. Pair with B20 to ensure timers behave the same fresh and loaded.

**Acceptance:**
- Save mid-day, load, dayTime continues from where it left off (within rounding).
- `tick` is preserved so `nextX` cooldowns retain their meaning.
- `nextPregnancyTick` round-trips through save/load.
- Bump `SAVE_VERSION` and add a no-op migration so old saves load with
  `tick = 0, dayTime = 0` (current behavior) but new saves persist correctly.
- One test: save with `tick=5000, dayTime=2400`, load, assert preserved.

**Files:** `src/app/save.js`, `src/app/constants.js` (SAVE_VERSION bump),
`tests/save.timeRoundtrip.test.js` (new).

---

## Phase 2 — Speed multiplier double-application

**Why second:** B11 means villagers move 4× speed at simulation speed 2× and
16× speed at 4×. If you're using speed-up to observe the effects of any later
fix, you're observing broken physics. This is a one-line surgical fix that
unlocks reliable testing.

**Issues in this phase:**
- **B11** — `stepAlong` multiplies step size by `SPEEDS[speedIdx]`, but
  `tick.js` already folds that multiplier into the tick rate by scaling `dt`.
  Animals and seasons are correct; only villagers double-apply.

**Acceptance:**
- Remove `SPEEDS[getSpeedIdx()]` from the `speedMultiplier` calculation in
  `stepAlong` (`src/app/onArrive.js:85`).
- Drop `SPEEDS` and `getSpeedIdx` from the `createOnArrive` deps if they
  become unused.
- Add a test that asserts a villager's per-tick movement at the same simulated
  game-time interval is identical at speedIdx=0, 1, 2, 3 (only the number of
  ticks per real second changes, not the per-tick step size).

**Files:** `src/app/onArrive.js`, `src/app.js` (drop `getSpeedIdx` dep wiring
if no longer needed), `tests/movement.speed.test.js` (new).

---

## Phase 3 — Hunger / energy ceiling and floor correctness

**Why third:** These bugs mathematically prevent the simulation from doing
what its data says it should do. Fixing them changes baselines, so any tuning
done before this phase will be wrong. All small, surgical, no architectural
risk.

**Theme:** "Math-level correctness — make the numbers actually reach the
states they claim to reach."

**Issues in this phase:**
- **B14** — Stage 3 (sick) is unreachable from hunger accumulation. Hunger
  clamps at 1.2, sick threshold is 1.22. The whole `enterSickState` →
  `STARVE_COLLAPSE_TICKS` → `handleVillagerFed` recovery arc is dead in
  normal play. Fix: lower `STARVE_THRESH.sick` to 1.18 (achievable from the
  `starving` 1.08 ceiling at normal drain).
- **B1** — Dead-code rest threshold. The three OR'd conditions in
  `villagerTick.js:340-344` resolve to `energy < 0.30` because clauses 2 and
  3 always fire before clause 1. Fix: collapse to a single readable predicate
  and remove the unreachable `restEnergyThreshold = 0.22` knob (or make it
  actually authoritative).
- **B7** — Hidden well-fed buff on every meal. `handleVillagerFed`
  unconditionally sets `recoveryTimer = STARVE_RECOVERY_TICKS / 3` even for
  healthy villagers, giving them 93 ticks of `energyDelta *= 0.6` and
  `happyDelta += 0.0006`. Fix: only set recoveryTimer in the `wasCritical`
  branch.
- **B15** — Sick villagers can't seek food (frozen for `STARVE_COLLAPSE_TICKS`).
  Combined with B14 making sick unreachable, B15 is currently moot — but once
  B14 is fixed, B15 becomes critical because sick villagers will starve
  silently. Fix: allow sick villagers to break out and seek food once
  `urgentFood` is true.

**Acceptance:**
- A villager who never eats progresses hungry → starving → sick within a day
  in real time at default settings.
- Eating while not critical does NOT set a recovery timer.
- The rest decision uses one threshold, and that threshold is the one in policy.
- A sick villager with food access can recover.
- Tests for: sick state reachability, recovery branching, rest threshold
  monotonicity.

**Files:** `src/app/villagerAI.js`, `src/app/villagerTick.js`, `src/policy/policy.js`
(remove or document dead knobs), test files.

---

## Phase 4 — Mood / scoring correctness

**Theme:** "Inputs being counted the right number of times."

**Why fourth:** With Phase 3 done, baseline drains are correct. Now fix the
inputs that compose against those baselines so mood and job choice are
honest.

**Issues in this phase:**
- **B26** — Campfire mood is triple-counted at night. `nearbyWarmth`,
  `agricultureBonusesAt`, and `NIGHT_CAMPFIRE_MOOD_TICK` all fire for the
  same fire. Pick one source per effect: `nearbyWarmth` for the warm flag,
  `agricultureBonusesAt` for the passive mood field, `NIGHT_CAMPFIRE_MOOD_TICK`
  for the night bonus — and remove the campfire's `effects.moodBonus` from
  the agriculture pass since `nearbyWarmth + NIGHT_CAMPFIRE_MOOD_TICK` already
  covers it. Keep huts/wells as the only `agricultureBonusesAt` mood sources.
- **B8** — Hydration multiplier scales the mood-energy bonus too. In
  `villagerTick.js:147-167`, `energyDelta = -drain + moodBoost`, then `*= 0.8`
  if hydrated. Happy + hydrated villagers lose 20% of their happy bonus. Fix:
  apply hydration multiplier to the drain only, then add moodBoost.
- **B10** — Dead "rest" scoring branch in `scoring.js:168-170`. Rest is never
  a job type. Remove the branch and the `energyRestBonus` policy field, OR
  wire rest as a real virtual job (much bigger change — the easy fix is to
  delete it).
- **B12** — Well claims `harvestBonus` it doesn't have. Remove the
  `if (eff.harvestBonus)` branch in the well case of `agricultureBonusesAt`.

**Acceptance:**
- A villager near a campfire at night gains a noticeable but not-instant
  mood boost — full happiness should take meaningfully more than one night.
- Mood-energy bonus scales independently of hydration.
- `policy.style.jobScoring.energyRestBonus` removed (or documented as a
  reservation for a future virtual rest-job).
- One test for each: mood accumulation rate near a campfire, energy delta
  for happy + hydrated, well bonuses returned by `agricultureBonusesAt`.

**Files:** `src/app/villagerTick.js`, `src/ai/scoring.js`, `src/app/world.js`,
`src/policy/policy.js`.

---

## Phase 5 — Job-system correctness

**Theme:** "Jobs that lie about who's doing what."

**Why fifth:** Decisions, distances, and reservations now compose against
correct baselines. This phase fixes the job system telling itself the wrong
thing about its own state.

**Issues in this phase:**
- **B9** — `scoreExistingJobForVillager` uses stale `j.x, j.y` for hunt
  distance instead of the animal's current position. Mirror the `pickJobFor`
  logic: look up the animal via `findAnimalById(j.targetAid)` for hunts.
- **B17** — `seekEmergencyFood` sets `v.state='forage'` without claiming the
  matching forage job. On arrive, `finishJob(null)` is a no-op and the
  original job is orphaned. Fix: when `nearestFoodTarget` returns a berry
  tile that has a matching forage job, attach it to `v.targetJob` so
  `finishJob` cleans up.
- **B2** — `hasRipeCrops()` defaults to threshold 160, but harvest jobs are
  emitted at growth 150. During growth ∈ [150, 160), `forageNeed` returns
  true even though ripe crops exist. Unify the threshold to 150.
- **S8 / S9** — same root cause as B2; closed by the unification.

**Acceptance:**
- A hunter doesn't drop a hunt mid-pursuit because the animal moved a few
  tiles.
- Empty berry tiles don't accumulate dead forage jobs in the queue.
- When crops are at growth 152, the planner does not schedule forage jobs
  on top of harvest.
- Tests for: hunt re-prioritization with moving animals, forage-job lifecycle
  through emergency food path, ripe-crop threshold unification.

**Files:** `src/app/villagerAI.js`, `src/app/planner.js`,
`src/app/onArrive.js` (forage-arrive cleanup if needed), tests.

---

## Phase 6 — Pregnancy / population gating

**Theme:** "Reproduction asymmetry and missed cooldowns."

**Why sixth:** Self-contained correctness in the population system. Doesn't
affect any earlier or later phase mechanically, but worth tightening as a
group.

**Issues in this phase:**
- **B5** — `tryStartPregnancy` doesn't set `nextPregnancyTick` when blocked
  by `starveStage>=1`, `condition==='sick'`, `energy<0.4`, or `happy<0.35`.
  Function re-runs every tick on every adult who's slightly tired. Fix: set
  a short cooldown (e.g., 60 ticks) on each early-bail path so the function
  is checked at most once per second, not 6×/sec.
- **B6** — Mate eligibility is asymmetric. Parent must have `starveStage===0`,
  `energy>=0.4`, `happy>=0.35`. Mate scan only filters `starveStage<2` and
  `condition`. Fix: extract a shared `isPregnancyEligible(v)` predicate used
  by both `tryStartPregnancy` and `findBirthMate`.
- Save `pendingBirths` array (or document its loss as intentional) — pair
  with Phase 1's save work.

**Acceptance:**
- An exhausted, sad villager cannot be drafted as a mate.
- `tryStartPregnancy` is not a hot path on tired-but-eligible villagers.
- Test: build a state where parent is eligible but mate is energy=0.2,
  assert no pregnancy starts.

**Files:** `src/app/population.js`, tests.

---

## Phase 7 — Building labor

**Theme:** "Construction should feel like work."

**Why seventh:** First of the structural feel changes. Self-contained — only
touches the build state machine. Has to come before tuning passes because
labor duration is a new lever the tuning will use.

**Issues in this phase:**
- **B3 / S6** — Buildings finish in essentially zero ticks. Once `b.store`
  covers `b.cost`, a single villager visit drains it all in one tick. No
  felt construction.

**Design (proposed):**
- Add `buildLaborTicks` per building kind in `BUILDINGS` (e.g., hut: 60,
  storage: 80, farmplot: 30, well: 100, hunterLodge: 80).
- Add `b.laborProgress` field, initialized to 0.
- On `state === 'build'` arrive, transition to a new `state === 'building'`
  that ticks `b.laborProgress` while adjacent and decrements one labor unit
  per tick. Exit when `laborProgress >= laborTicks`.
- Materials are still consumed at the start of construction (preserves the
  "supply first, then build" flow). Just the duration changes.
- Multiple villagers on the same building add their labor.
- A villager interrupted (e.g., starving) leaves; another can resume.

**Acceptance:**
- A hut takes ~10 seconds of game time at 1× speed with one builder.
- Two builders on the same hut finish in ~5 seconds.
- An interrupted build resumes from `laborProgress`, not from scratch.
- Test for partial labor + resume.

**Files:** `src/app/world.js` (BUILDINGS data + helpers), `src/app/onArrive.js`
(state machine), `src/app/villagerTick.js` (the new `building` state),
`src/app/save.js` (persist `laborProgress`), tests.

---

## Phase 8 — Night-anchored sleep

**Theme:** "Day/night should mean something."

**Why eighth:** This is the biggest single change for "alive feeling," but
it depends on Phase 3 (correct rest threshold) and Phase 4 (correct mood
budget so night/morning composes correctly).

**Issues in this phase:**
- **S1** — No night-driven sleep behavior. Villagers only rest when energy
  is low; nothing pulls them to bed because it's bedtime.
- **S2** — Rest exits on `restTimer<=0 || energy>=0.995`. With night-anchored
  sleep this should also accept "until dawn."
- **S3** — `REST_BASE_TICKS` calculation is duplicated inconsistently between
  `villagerTick.js:243` (×0.35) and `onArrive.js:503` (×1.0). Unify into a
  single helper.

**Design (proposed):**
- New predicate `wantsToSleep(v, nightNow, energy)`:
  - Always rest if `energy < 0.30` (Phase 3 threshold)
  - At night and not on a critical job: rest if `energy < 0.65`
  - Deep night (within 20% of nighttime midpoint): rest unconditionally
    unless on a critical job (urgentFood, building, hunting)
- New rest exit condition: `restTimer<=0 || energy>=0.995 || (wasNightStart && !nightNow)`
  — wake at dawn even if the timer hasn't expired.
- Track `restStartedAtNight` so we can wake at dawn rather than just
  per-timer.
- Critical jobs (famine harvest, urgent food) still interrupt sleep.

**Acceptance:**
- Most villagers are sleeping during the deep-night window unless something
  urgent is happening.
- A villager who fell asleep at 0.65 energy wakes at dawn near 1.0, not
  mid-night.
- Day work resumes with full energy reserves, creating a real day/night
  rhythm.
- Test: simulate a full day, assert the village's sleep state matches
  ambient.

**Files:** `src/app/villagerTick.js`, `src/app/villagerAI.js`,
`src/app/onArrive.js`, tests.

---

## Phase 9 — Winter as a real state

**Theme:** "Seasons should change the world, not just the labels."

**Why ninth:** Independent of Phase 8 mechanically but benefits from being
done after the day/night rhythm is felt — winter then composes against a
visible day/night world.

**Issues in this phase:**
- **B4 / S7** — `seasonTick` grows crops at the same rate every season.
  Hunger drains at the same rate every season. Berries don't deplete
  seasonally. Winter is a label.

**Design (proposed):**
- `seasonalGrowthMultiplier(season, seasonProgress)`:
  - Spring 1.0, Summer 1.2, Autumn 0.8, Winter 0.3
  - smoothed at season transitions
- `seasonalHungerMultiplier(season)`:
  - Spring 1.0, Summer 0.95, Autumn 1.0, Winter 1.15 (need more food in cold)
- Berry regeneration (separate concern but co-located): tune so winter
  berry density drops gradually over autumn, doesn't recover until spring.
- Apply growth multiplier in `seasonTick` against `delta = 1.2 * mult`.
- Apply hunger multiplier in `villagerTick` against `HUNGER_RATE`.

**Acceptance:**
- Crops planted at start of winter take ~3× as long to ripen.
- Villagers in winter visibly eat through reserves faster.
- Stockpiling becomes a real winter strategy, not just a planner hint.
- Tests: growth rate by season, hunger drain by season.

**Files:** `src/app/simulation.js` (multiplier helpers),
`src/app.js` (`seasonTick`), `src/app/villagerTick.js`, optional berry
regen tuning in worldgen if it exists, tests.

---

## Phase 10 — Hydration and work-effort weight

**Theme:** "Make the existing systems felt by the player."

**Why tenth:** With seasons, sleep, and labor all real, hydration and
fatigue can finally compose meaningfully. Doing this earlier would have
been wasted because villagers wouldn't be in the right states at the
right times.

**Issues in this phase:**
- **S10** — Hydration is nearly binary. Buff lasts 320 ticks, cooldown is
  576, decay is 0.00018/tick. Villagers are >0.90 hydrated for ~76% of
  the day. Tighten the buff/cooldown so dry stretches matter.
- **S4** — No fatigue penalty on movement speed. `stepAlong` has condition
  penalty but ignores energy. Add a small low-energy speed penalty.
- **S5** — No fatigue or hunger penalty on work itself. A starving villager
  sows at full speed. Add per-action labor multipliers based on condition
  and energy (e.g., chop takes 1.3× labor when energy<0.3, sow yields
  fewer crops when starving). Use the new `laborProgress` tracking from
  Phase 7.

**Acceptance:**
- A well-hydrated village is visibly more productive than a parched one.
- A tired or hungry village moves and works slower; this is a felt cost
  of overworking.
- Tests for: hydration decay window, low-energy speed penalty,
  fatigue work multiplier.

**Files:** `src/app/villagerAI.js` (hydration tuning),
`src/app/onArrive.js` (stepAlong + labor multiplier),
`src/app/villagerTick.js`, tests.

---

## Phase 11 — Idle behavior and convention cleanup

**Theme:** "Make the implicit explicit."

**Why eleventh:** Pure cleanup; no behavior change unless one of these is
masking a subtle bug we discover. Useful before any new contributor or
agent works on this code.

**Issues in this phase:**
- **S11** — The implicit "idle behavior tree" (cascade of `tryHydrateAtWell`,
  `tryCampfireSocial`, `tryStorageIdle`, `goRest`) is order-dependent and
  undocumented. Refactor into one named decision function with a clear
  comment for each branch.
- **S14** — Two priority conventions coexist (`buildQueue` sorts ascending;
  progression tier priorities documented as ascending importance). Pick one
  and convert the other. Recommend: highest-number-wins for both, since
  that's the more common convention in game code.
- **B13** — Tier resource gates don't see other plans pushed in the same
  tick. Bounded by `maxPlansPerTick=2` so it's contained, but worth a
  comment.

**Acceptance:**
- A new reader can understand idle behavior selection in one screenful.
- All priority numbers in the codebase follow one convention.
- Audit comment on `applyProgressionPlanner` documents the resource-bookkeeping
  bound.

**Files:** `src/app/villagerTick.js`, `src/app/planner.js`,
`src/policy/policy.js`.

---

## Phase 12 — Performance

**Theme:** "Make it scale."

**Why last:** None of these break correctness; they just make the simulation
slow on big maps and high populations. Doing them last means we're optimizing
the right code.

**Issues in this phase:**
- **B23** — `findHuntApproachPath` runs `pathfind()` from every tile in a
  9×9 around the target. ~26K BFS ops worst case per call. Reduce to a
  single pathfind to the closest tile in range, or cache by target+villager.
- **B25** — `agricultureBonusesAt` returns `growthBonus`, `harvestBonus`,
  `moodBonus` but villagerTick reads only `moodBonus` every tick. Split
  into `agricultureMoodAt` + `agricultureGrowthAt`, or pass a fields mask.
- **S12** — Pathfinding is BFS, not A*. Add a Manhattan-distance heuristic
  for a typical 5–10× speedup on long paths.
- **S13** — `passable()` runs an O(B) building scan per neighbor expansion.
  Maintain a per-tile occupancy bitmap updated when buildings are placed
  or completed.

**Acceptance:**
- Frame time on the 192×192 map with ~50 villagers and ~30 buildings drops
  noticeably.
- A perf benchmark test (or DebugKit metric) confirms before/after numbers.

**Files:** `src/app/animals.js`, `src/app/world.js`, `src/app/villagerTick.js`,
`src/app/pathfinding.js`, `src/app.js` (occupancy bitmap maintenance).

---

## Cross-cutting

- Each phase ends with `npm run lint && npm test` clean.
- Phases 1, 2, 3 are pre-requisite chains; everything from Phase 4 onward is
  more flexible if you want to reorder for taste.
- If you want one phase to ship "wow factor" — Phase 8 (night sleep) is the
  one users will feel most strongly. Phase 9 (winter) is second.
- Don't combine phases. Each one shifts at least one baseline; reading the
  diff in isolation is what makes regressions visible.
