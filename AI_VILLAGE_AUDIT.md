# Findings (organized by severity)

## CONFIRMED BUGS

### B1 — Dead-code rest threshold (villagerTick.js:340-345)
Three OR'd conditions:
  v.energy < 0.22                                  // restThreshold
  || (fatigueFlag && v.energy < 0.30)              // restThreshold + restFatigueBoost
  || v.energy < (0.32 * 0.8) = 0.256               // fatigueThreshold * 0.8

Third clause (0.256) ALWAYS fires before first (0.22) does. First clause is dead.
Also: with multi-villager simulation, fatigueFlag is true if ANY villager is fatigued
(blackboard.js fatigue: fatigued > 0). So second clause fires at 0.30 most of the time.
Effective rest threshold ≈ 0.30 in practice. The 0.22/0.32 knobs are misleading.

### B2 — Threshold mismatch between hasRipeCrops() and harvest scan
planner.js:805 hasRipeCrops(threshold = 160)  uses default 160
planner.js:902-906 harvest job creation uses world.growth[i] >= 150
app.js:707 seasonTick harvest job creation uses prev<150 && next>=150

So crops are "harvest ready" at 150, but hasRipeCrops() reports "no ripe crops" until 160.
At growth in [150, 160), generateJobs() spawns BOTH a harvest job AND a forage job
(because forageNeed includes !hasRipeCrops()). False forage pressure during ripe window.

### B3 — Building completes in essentially zero ticks once supplies arrive
onArrive.js:278-306. The "build" action consumes ALL stored materials in a single visit.
There's no per-tick construction progress; pathfinding to the site is the entire labor.
This means a built building's "construction" is just "show up once." Watching it,
buildings pop into existence. Combined with very fast haul/storage, building feels
unweighted. Should add per-visit progress (e.g., 4-6 ticks of "build" action).

### B4 — Crops grow at full rate in winter
app.js:678-712 seasonTick. Growth delta is 1.2 + boosters, every season. Winter does
NOT reduce growth. Combined with no consumption increase in winter, no fewer berries
in winter, and no temperature penalty, "winter" is effectively a label not a state.
Major lost lever for "alive feeling."

### B5 — tryStartPregnancy never sets cooldown when blockers fail
population.js:142-157.
  if (v.lifeStage !== 'adult') return;
  if (v.pregnancyTimer > 0) return;
  if ((v.starveStage || 0) >= 1) return;       // <-- no cooldown set
  if (v.condition === 'sick') return;          // <-- no cooldown set
  if (v.energy < 0.4 || v.happy < 0.35) return; // <-- no cooldown set

Means tryStartPregnancy is called every tick a villager isn't quite eligible but
is otherwise an adult. Function returns fast but it's still 6Hz × n_adults of
needless conditional checks. Mostly perf, not gameplay.

### B6 — Mate's eligibility ignored on selection (population.js:158-168)
findBirthMate scans for: `pregnancyTimer > 0`, `nextPregnancyTick > tick`, `starveStage >= 2`,
`condition` filter. But the parent `tryStartPregnancy` checks energy<0.4, happy<0.35.
For the mate, the scan checks `starveStage >= 2` (not >=1 like the parent). Asymmetry:
parent must not be hungry (stage 1+), mate must just not be starving. Mate also has no
energy or happy gating. So an exhausted, sad villager can be drafted as a mate.

### B7 — handleVillagerFed sets recovery floor even when not critical
villagerAI.js:114-116:
  } else {
    v.condition = 'normal';
    v.recoveryTimer = Math.max(v.recoveryTimer, Math.floor(STARVE_RECOVERY_TICKS / 3));
  }

A villager who eats while merely 'normal' (not even hungry) gets a 93-tick recovery
window applied. During recovery: energyDelta *= 0.6, happyDelta += 0.0006.

So a healthy villager who eats a snack suffers a 0.6× energy drain reduction (so they
gain energy effectively!) and mood boost for 93 ticks. This is essentially a "well-fed
buff" hidden inside the recovery system. Likely unintentional.

### B8 — Hydration boosts moodEnergyBoost too (villagerTick.js:147-167)
energyDelta = -0.0011 + moodMotivation*0.00045
if hydrated: energyDelta *= 0.8

A happy villager has positive moodEnergyBoost. When hydrated, that bonus gets
scaled by 0.8 too — they get less of their happy bonus. The hydrated buff and mood
boost interact in a way that punishes happy + hydrated villagers slightly.
Subtle but it works against the simulation's goal of layered systems composing positively.

## STRUCTURAL / DESIGN GAPS

### S1 — No night-driven sleep behavior
Villagers only rest based on energy (line 344). They never rest "because it's bedtime."
Result: villagers work straight through the night, then collapse during the day.
Night currently does almost nothing except enable campfire socializing.
For "alive feeling" this is THE biggest lever. Sleep at night, work in day.

### S2 — Rest exit condition is OR, not AND
villagerTick.js:246 — `if (v.restTimer <= 0 || v.energy >= 0.995)` — exit on
either timer expiration OR full energy. Means rest sessions are short — minRest at low
energy is ~120 ticks (~20 sec), at high energy ~90 ticks. They wake before full energy.
Night-anchored sleep would change this.

### S3 — REST_BASE_TICKS calculation is duplicated and inconsistent
villagerTick.js:243 uses *0.35 multiplier; onArrive.js:503 uses *1.0.
The "minimum rest required" computed differently in the two places creates
asymmetric behavior between arrival and during-rest.

### S4 — No fatigue penalty on movement speed
stepAlong (onArrive.js:78-86) has condition penalty (sick/starving/hungry) and
mood boost, but no energy/fatigue penalty. Tired villagers walk just as fast.

### S5 — Hunger doesn't slow farm work, only walking speed
A starving villager walks 0.7× speed (correct), but their on-arrival farm/build
action doesn't slow. They can sow crops as fast as a healthy villager.
Their happiness affects success on hunting (correct) but not farming.

### S6 — Building construction has no labor duration
See B3. Buildings appear instantly when materials arrive. Construction should take
multiple ticks of work at the site to feel like "labor."

### S7 — No seasonal food consumption variation
Hunger drains at the same rate year-round. Cold weather should drive higher
food needs in winter (currently no winter penalties at all besides job-priority hints).

### S8 — Forage demand hasRipeCrops uses 160 not 150
See B2. Once unified at 150, the threshold gap closes.

### S9 — pickJobFor inflates forage when crops nearly ripe
generateJobs:876-879. Forage is gated on `!hasRipeCrops() && foodOnHand < villagers*3`.
When food is comfortable (>= 3/villager) and crops are ripe, no forage. But during the
window where crops are 150-160, hasRipeCrops()=false. This is the same bug as B2 from
a different angle.

### S10 — Hydration buff cooldowns make hydration almost binary
After drinking, villagers get HYDRATION_BUFF_TICKS=320 (53 sec) of buff and
nextHydrateTick set to DAY_LENGTH*0.16=576 ticks (96 sec) cooldown. Hydration_LOW=0.28,
HYDRATION_VISIT_THRESHOLD=0.46. With a decay of 0.00018/tick:
  After drinking, hydration=1, decay over 576-tick cooldown = 0.10 → hydration=0.90
  Buff lasts 320 ticks of those 576 ticks.
So villagers spend 76% of their day in 'hydrated buffed' state. The hydration system
barely creates pressure unless wells are unavailable.

### S11 — handleIdleRoam is the bottom catch-all but undocumented behaviors stack
Multiple "tryX" calls in cascade (tryHydrateAtWell, tryCampfireSocial, tryStorageIdle).
Each has its own cooldown. Order matters — first-eligible wins. Storage idle
appears in TWO places: line 453-454 (when no jobs in queue) and line 456-458 (with social).
The "idle behavior tree" is implicit and order-dependent.


## ROUND 2 FINDINGS (deeper audit)

### B9 — scoreExistingJobForVillager wrong distance for hunt
villagerAI.js:541-545. `pickJobFor` uses `findAnimalById(j.targetAid)` to get
animal's CURRENT location for distance. `scoreExistingJobForVillager` (used
by maybeInterruptJob to compare current vs candidate) uses Manhattan from
`j.x, j.y` — the original job spawn point. Animals move; the comparison is
using stale spatial data. Hunters get bad interrupt decisions.

### B10 — Dead "rest" job-type scoring
scoring.js:168-170. A "rest" job-type bonus exists in scoreJob, but rest is
never a job. Villagers go to rest via `goRest()` non-job behavior. The
`energyRestBonus: 0.15` in policy is wasted; the entire branch is unreachable.

### B11 — Speed multiplier double-application (BIG)
onArrive.js:85. stepAlong multiplies step size by `SPEEDS[speedIdx]`. But
tick.js (line 67) ALREADY multiplies dt by `SPEEDS[speedIdx]` to drive more
ticks per real-second. So at speedIdx=2 (×2), villagers tick 2× faster AND
move 2× per tick = 4× real speed. At speedIdx=3 (×4), 16× speed. At
speedIdx=0 (×0.5), 0.25× speed. Animals and seasons are correct (no double).
Villagers outrun the world at any non-1.0 speed setting.

### B12 — Well claims harvestBonus it doesn't define
world.js:253. `if (eff.harvestBonus)` exists in well's branch of
agricultureBonusesAt, but `well.effects` has no harvestBonus. Dead branch.
Likely copy-paste from farmplot.

### B13 — Tier resource gates don't see other plans pushed same tick
Bounded by maxPlansPerTick=2 so it doesn't compound, but
`meetsProgressionRequirements` in `applyProgressionPlanner` checks blackboard
`available` once. Two tiers in same tick can claim the same wood. Mostly
contained but could cause one tier to be skipped on resource recheck in
`planBuildings` later.

### B14 — Stage 3 sick state is unreachable from hunger accumulation
villagerTick.js:174-178 vs 214. Stage 3 fires when `hunger > STARVE_THRESH.sick (1.22)`,
but hunger is clamped to 1.2 at end of tick. With drain ~0.001/tick, hunger
can momentarily reach 1.21 (from prev=1.2 + 0.001) — still < 1.22.
Stage 3 IS reachable in that window: prev=1.219, +0.001=1.22... wait, > 1.22 = stage 3.
So actually if hunger is clamped exactly at 1.2 each tick and increment is small,
the only path to >1.22 is a tick where prev=1.219 + drain=0.002 = 1.221 → stage 3.
HUNGER_RATE=0.00095 alone wouldn't get there from the clamp ceiling 1.2.
But REST_HUNGER_MULT=0.42 reduces drain when resting. Dehydrated penalty 1.12 increases.
Maximum drain per tick: 0.00095 * 1.12 = 0.001064. From clamp ceiling 1.2 → 1.20106.
Still < 1.22. So stage 3 from accumulation is genuinely impossible when clamp ceiling
is 1.2 and threshold is 1.22. enterSickState is dead code in normal play.
Needs: lift clamp to 1.3, or lower sick threshold to 1.18, or both.

### B15 — Sick villagers can't seek food
villagerTick.js:217. `if (sick && sickTimer > 0) return;` — they're frozen
for STARVE_COLLAPSE_TICKS (140 ticks ~ 23 sec) without trying to eat.
If hunger keeps climbing while frozen, they cap at 1.2 and stay sick.
Without external feeding, they can't recover (since hunger>1.08 keeps them
on the path). Mostly moot now since B14 makes sick unreachable, but if you
fix B14, this becomes critical.

### B16 — Hunt suppression locks animal across hunters
jobs.js getJobIdentity: `hunt:a${targetAid}`. When hunter A misses, suppress
fires for HUNT_RETRY_COOLDOWN=140 ticks. Hunter B can't hunt that animal
during cooldown. Probably intentional (gives the animal a chance) but worth
documenting.

### B17 — seekEmergencyFood orphans pre-existing forage jobs
villagerAI.js:191-210. Sets `v.state='forage'` directly, no targetJob assigned.
Villager arrives, picks the berry, finishJob(v, true) — but v.targetJob is null,
finishJob is a no-op. The original forage job in the queue is left behind
with assigned=0. `pickJobFor` filters dead-berry jobs out, but they
accumulate in `jobs[]` until manually cleared. Perf drag.

### B18 — N/A (was investigating reservation tracking, found correct behavior)

### B19 — nextPregnancyTick not preserved across save/load
save.js doesn't write/restore `nextPregnancyTick`. Plus several other cooldown
fields: `nextHydrateTick`, `nextSocialTick`, `nextStorageIdleTick`, etc are saved
but `nextPregnancyTick` is missed. After load, all eligible adults are immediately
fertile → potential baby boom on every load.

### B20 — tick and dayTime not saved
save.js dataset doesn't include `tick` or `dayTime`. Save at midnight, load
restarts time-of-day at 0. All cooldown fields stored as absolute tick values
become invalid because `tick` resets too. Cooldowns expire instantly. This
explains why mid-game saves feel "fresh" — every cooldown is dead on load.

### B21 — forageNeed doesn't account for berry availability
planner.js:876. forageNeed triggers based on food/villager ratio + ripe-crop
flag, but doesn't check whether berries exist within reach. Generates jobs
on empty terrain (no actual jobs added since the inner filter weeds them out,
but 441-tile loop runs unnecessarily).

### B22 — Forage stragglers waste paths
A villager pathing to a berry can have the berry picked by another mid-walk.
The walker keeps walking (no path-time replanning). Walks all the way, sees
empty tile, finishes. Waste of time for high-density forage jobs. Bigger
AI overhaul to fix; flagging for awareness.

### B23 — findHuntApproachPath is O(81 × pathfind)
animals.js:237. Tries pathfind from every tile in 9×9 around target. With
maxPath=320, each pathfind explores up to 320 tiles. Worst case ~26K ops
per hunt approach. Called from pickJobFor and onArrive. With multiple hunters
this is slow.

### B25 — agricultureBonusesAt computes 3 fields when villagerTick reads 1
villagerTick line 150 reads only `moodBonus` but the function loops all
buildings computing growthBonus, harvestBonus, moodBonus for every villager
every tick. 3× wasted work. Hot path.

### B26 — Campfire mood is triple-counted at night
villagerTick.js:149-155. A villager at a campfire at night gets:
  +0.001 from `warm` flag (campfire bonus, baseline)
  +0.0011 from agricultureBonusesAt (campfire moodBonus)
  +0.0012 from NIGHT_CAMPFIRE_MOOD_TICK
Total: 0.0033 happy/tick × 1200 night ticks = 3.96 happy/night.
Clamped at 1.0, so 1 night = full happiness for life. Way too strong.

### S12 — pathfinding is BFS, not A*
pathfinding.js. Treats all tiles as equal cost; no heuristic. Long paths
explore far more tiles than necessary. With many villagers requesting paths,
this dominates CPU time on big maps. Not a correctness issue.

### S13 — passable() runs O(B) building scan per neighbor expansion
pathfinding.js:17-22 → tileOccupiedByBuilding scans all buildings linearly.
With 400-tile pathfind × 4 neighbors × O(B), pathfinding is O(1600B).
A spatial index (or per-tile occupancy bit) would be much faster.

### S14 — Two priority conventions coexist
buildQueue sort is ASCENDING (lower number = placed first), but progression
tier priorities in policy.js are documented as ascending importance (1.4, 1.7,
2.1, 2.6 ramping UP). They land in the same buildQueue, so the convention
inversion is internally consistent BUT very confusing to read.

### S15 — REST/SOCIAL/HYDRATE timer race on resume
On arriving at a building, `restTimer = max(restTimer, baseRest)`. If the
villager had a stale restTimer from a prior interrupted rest, the previous
duration wins. Combined with B20 (save loses nextX cooldowns), this can give
different results between fresh and loaded games.

