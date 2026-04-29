import { clamp } from './rng.js';
import {
  addJobExperience,
  applySkillGain,
  isDawnAmbient,
  isDeepNight,
  isNightAmbient,
  moodMotivation,
  moodThought
} from './simulation.js';
import { DAY_LENGTH, HUNT_RANGE, HUNT_RETRY_COOLDOWN } from './constants.js';
import { BUILDINGS } from './world.js';
import { CHILDHOOD_TICKS } from './population.js';
import {
  HYDRATION_BUFF_TICKS,
  SOCIAL_BASE_TICKS,
  SOCIAL_COOLDOWN_TICKS,
  STARVE_THRESH,
  STORAGE_IDLE_BASE,
  STORAGE_IDLE_COOLDOWN,
  restDurationTicks,
  wantsToSleep
} from './villagerAI.js';

// Tick-only knobs (decay rates / per-frame deltas) live next to the function
// that reads them. The shared villager-tuning constants (STARVE_*, REST_*,
// HYDRATION_*, SOCIAL_*, STORAGE_IDLE_*, CHILDHOOD_TICKS) are now imported
// from villagerAI.js / population.js so there's a single source of truth.
const HUNGER_RATE = 0.00095;
const ENERGY_DRAIN_BASE = 0.0011;

const REST_ENERGY_RECOVERY = 0.0024;
const REST_MOOD_TICK = 0.0009;
const REST_FINISH_MOOD = 0.05;
const REST_HUNGER_MULT = 0.42;

const HYDRATION_DECAY = 0.00018;
const HYDRATION_LOW = 0.28;
const HYDRATION_HUNGER_MULT = 0.9;
const HYDRATION_FATIGUE_BONUS = 0.8;
const HYDRATION_DEHYDRATED_PENALTY = 1.12;
const HYDRATION_MOOD_TICK = 0.00035;

const SOCIAL_MOOD_TICK = 0.0013;
const SOCIAL_ENERGY_TICK = 0.00055;

const NIGHT_CAMPFIRE_MOOD_TICK = 0.0012;
const NIGHT_CAMPFIRE_XP_TICK = 0.15;

export function createVillagerTick(opts) {
  const {
    state,
    policy,
    pathfind,
    ambientAt,
    nearbyWarmth,
    agricultureBonusesAt,
    getBuildingById,
    noteBuildingActivity,
    endBuildingStay,
    cancelHaulJobsForBuilding,
    finishJob,
    markStaticDirty,
    markEmittersDirty,
    issueStarveToast,
    enterSickState,
    suppressJob,
    noteJobAssignmentChanged,
    getJobCreationConfig,
    findEntryTileNear,
    findNearestBuilding,
    buildingCenter,
    findHuntApproachPath,
    findAnimalById,
    buildingAt,
    tryEquipBow,
    tryHydrateAtWell,
    tryCampfireSocial,
    tryStorageIdle,
    foragingJob,
    goRest,
    seekEmergencyFood,
    consumeFood,
    findPanicHarvestJob,
    pickJobFor,
    maybeInterruptJob,
    tryStartPregnancy,
    completePregnancy,
    promoteChildToAdult,
    handleIdleRoam,
    stepAlong
  } = opts;

  function villagerTick(v) {
    if (v.condition === undefined) v.condition = 'normal';
    if (v.starveStage === undefined) v.starveStage = 0;
    if (v.nextStarveWarning === undefined) v.nextStarveWarning = 0;
    if (v.sickTimer === undefined) v.sickTimer = 0;
    if (v.recoveryTimer === undefined) v.recoveryTimer = 0;
    if (v.restTimer === undefined) v.restTimer = 0;
    if (!Number.isFinite(v.hydration)) v.hydration = 0.7;
    if (!Number.isFinite(v.hydrationBuffTicks)) v.hydrationBuffTicks = 0;
    if (!Number.isFinite(v.nextHydrateTick)) v.nextHydrateTick = 0;
    if (!Number.isFinite(v.hydrationTimer)) v.hydrationTimer = 0;
    if (!Number.isFinite(v.socialTimer)) v.socialTimer = 0;
    if (!Number.isFinite(v.nextSocialTick)) v.nextSocialTick = 0;
    if (!Number.isFinite(v.storageIdleTimer)) v.storageIdleTimer = 0;
    if (!Number.isFinite(v.nextStorageIdleTick)) v.nextStorageIdleTick = 0;
    if (v.activeBuildingId === undefined) v.activeBuildingId = null;
    if (!Number.isFinite(v.ageTicks)) v.ageTicks = 0;
    if (!v.lifeStage) v.lifeStage = 'adult';
    if (!Number.isFinite(v.pregnancyTimer)) v.pregnancyTimer = 0;
    if (!Number.isFinite(v.childhoodTimer)) v.childhoodTimer = v.lifeStage === 'child' ? CHILDHOOD_TICKS : 0;
    if (!Array.isArray(v.parents)) v.parents = [];
    if (v.pregnancyMateId === undefined) v.pregnancyMateId = null;
    if (!Number.isFinite(v.nextPregnancyTick)) v.nextPregnancyTick = 0;
    v.ageTicks++;
    if (v.lifeStage === 'child') {
      if (v.childhoodTimer > 0) v.childhoodTimer--;
      if (v.childhoodTimer <= 0) promoteChildToAdult(v);
    }
    if (v.lifeStage === 'adult') {
      if (v.pregnancyTimer > 0) {
        v.pregnancyTimer--;
        if (v.pregnancyTimer <= 0) completePregnancy(v);
      } else {
        tryStartPregnancy(v);
      }
    }

    const tick = state.time.tick;
    const dayTime = state.time.dayTime;
    const ambientNow = ambientAt(dayTime);
    const nightNow = isNightAmbient(ambientNow);
    const dawnNow = isDawnAmbient(ambientNow);
    const style = policy?.style?.jobScoring || {};
    const blackboard = state.bb;
    const buildings = state.units.buildings;
    const jobs = state.units.jobs;
    const storageTotals = state.stocks.totals;

    const resting = v.state === 'resting';
    const hydrationDecay = HYDRATION_DECAY * (resting ? 0.55 : 1);
    v.hydration = clamp(v.hydration - hydrationDecay, 0, 1);
    if (v.hydrationBuffTicks > 0) v.hydrationBuffTicks--;
    const hydratedBuff = (v.hydrationBuffTicks || 0) > 0;
    const dehydrated = v.hydration < HYDRATION_LOW;
    const hungerRate = (resting ? HUNGER_RATE * REST_HUNGER_MULT : HUNGER_RATE) * (hydratedBuff ? HYDRATION_HUNGER_MULT : (dehydrated ? HYDRATION_DEHYDRATED_PENALTY : 1));
    v.hunger += hungerRate;

    const tileX = v.x | 0;
    const tileY = v.y | 0;
    const warm = nearbyWarmth(tileX, tileY);
    let energyDelta = -ENERGY_DRAIN_BASE;
    const moodEnergyBoost = moodMotivation(v) * 0.00045;
    let happyDelta = warm ? 0.001 : -0.0002;
    const { moodBonus } = agricultureBonusesAt(tileX, tileY);
    if (moodBonus) { happyDelta += moodBonus; }
    if (warm && nightNow) {
      happyDelta += NIGHT_CAMPFIRE_MOOD_TICK;
      addJobExperience(v, 'socialize', NIGHT_CAMPFIRE_XP_TICK);
    }
    const wellFed = v.hunger < STARVE_THRESH.hungry * 0.55;
    const wellRested = v.energy > 0.55;
    if (wellFed && wellRested) {
      happyDelta += 0.0008 + Math.max(0, v.energy - 0.55) * 0.0006;
    }
    if (hydratedBuff) {
      energyDelta *= HYDRATION_FATIGUE_BONUS;
      happyDelta += HYDRATION_MOOD_TICK * 0.5;
    } else if (dehydrated) {
      energyDelta *= HYDRATION_DEHYDRATED_PENALTY;
      happyDelta -= HYDRATION_MOOD_TICK;
    }
    energyDelta += moodEnergyBoost;
    if (resting) {
      energyDelta += REST_ENERGY_RECOVERY;
      happyDelta += REST_MOOD_TICK;
    }

    const prevStage = v.starveStage || 0;
    let stage = 0;
    if (v.hunger > STARVE_THRESH.hungry) stage = 1;
    if (v.hunger > STARVE_THRESH.starving) stage = 2;
    if (v.hunger > STARVE_THRESH.sick) stage = 3;
    if (v.recoveryTimer > 0) {
      v.recoveryTimer--;
      energyDelta *= 0.6;
      happyDelta += 0.0006;
      if (v.recoveryTimer === 0 && stage === 0) v.condition = 'normal';
    } else if (v.condition === 'recovering' && stage === 0) {
      v.condition = 'normal';
    }
    if (stage >= 1) energyDelta -= 0.00025;
    if (stage >= 2) { energyDelta -= 0.00045; happyDelta -= 0.00045; }
    if (stage >= 3) { energyDelta -= 0.0006; happyDelta -= 0.0009; }
    if (stage > prevStage) {
      if (stage === 1) { if (v.condition !== 'sick') v.condition = 'hungry'; }
      else if (stage === 2) { if (v.condition !== 'sick') v.condition = 'starving'; issueStarveToast(v, 'A villager is starving! Set up food or gather berries.'); }
      else if (stage >= 3) { enterSickState(v); }
    } else if (stage < prevStage) {
      if (prevStage >= 2 && stage <= 1 && v.condition !== 'recovering') issueStarveToast(v, 'Villager ate and is stabilizing.', true);
      if (stage === 0 && v.recoveryTimer <= 0) v.condition = 'normal';
      else if (stage === 1 && v.condition !== 'sick' && v.recoveryTimer <= 0) v.condition = 'hungry';
    } else if (stage === 0 && v.recoveryTimer <= 0 && v.condition !== 'normal' && v.condition !== 'recovering') {
      v.condition = 'normal';
    }
    if (v.condition === 'sick' && v.sickTimer <= 0 && stage < 3) {
      v.condition = stage >= 2 ? 'starving' : stage === 1 ? 'hungry' : 'normal';
    }
    v.starveStage = stage;
    if (v.condition === 'sick' && v.sickTimer > 0) {
      v.sickTimer--;
      energyDelta -= 0.0006;
      happyDelta -= 0.0008;
      // No per-tick path/finishJob wipe (audit B15): sick villagers must be
      // able to reach the urgentFood block below to consume food, claim a
      // forage job, or seek emergency food. The one-shot collapse already
      // happened in enterSickState.
      if (v.state !== 'sick' && v.state !== 'forage' && v.state !== 'seek_food') {
        v.state = 'sick';
      }
      if (!v.path || v.path.length === 0) {
        v.thought = moodThought(v, 'Collapsed');
      }
    }
    v.hunger = clamp(v.hunger, 0, 1.2);
    v.energy = clamp(v.energy + energyDelta, 0, 1);
    v.happy = clamp(v.happy + happyDelta, 0, 1);

    const urgentFood = stage >= 2 || v.condition === 'sick';
    const needsFood = stage >= 1;
    let panicHarvestJob = null;

    if (v.state === 'socializing' && dawnNow) {
      endBuildingStay(v);
      v.state = 'idle';
      v.socialTimer = 0;
      v.thought = moodThought(v, 'Greeting the dawn');
    }
    // If daylight has clearly arrived, break out of lingering campfire gatherings.
    if (!nightNow && (v.state === 'socialize' || v.state === 'socializing')) {
      endBuildingStay(v);
      v.state = 'idle';
      v.socialTimer = 0;
      v.nextSocialTick = Math.max(v.nextSocialTick || 0, tick + Math.floor(SOCIAL_COOLDOWN_TICKS * 0.4));
      v.thought = moodThought(v, 'Back to work');
    }

    if (v.state === 'resting') {
      if (urgentFood) {
        endBuildingStay(v);
        v.state = 'idle';
        v.restStartedAtNight = false;
      } else {
        // Audit S3: unified with the on-arrive seed via restDurationTicks.
        const minRest = restDurationTicks(v.energy);
        if (v.restTimer < minRest) v.restTimer = minRest;
        v.restTimer = Math.max(0, v.restTimer - 1);
        // Audit S2: a villager who fell asleep at night also wakes at dawn,
        // even if the rest timer hasn't expired.
        const wokeAtDawn = !!v.restStartedAtNight && !nightNow;
        if (v.restTimer <= 0 || v.energy >= 0.995 || wokeAtDawn) {
          endBuildingStay(v);
          v.state = 'idle';
          v.restTimer = 0;
          v.restStartedAtNight = false;
          v.happy = clamp(v.happy + REST_FINISH_MOOD, 0, 1);
          v.thought = moodThought(v, wokeAtDawn ? 'Up with the dawn' : 'Rested');
        } else {
          const active = getBuildingById(v.activeBuildingId);
          if (active) noteBuildingActivity(active, 'rest');
          v.thought = moodThought(v, 'Resting');
          return;
        }
      }
    }

    if (v.state === 'hydrating') {
      if (urgentFood) { endBuildingStay(v); v.state = 'idle'; }
      else {
        const active = getBuildingById(v.activeBuildingId);
        v.hydration = 1;
        v.hydrationBuffTicks = Math.max(v.hydrationBuffTicks, HYDRATION_BUFF_TICKS);
        v.hydrationTimer = Math.max(v.hydrationTimer || 0, Math.round(HYDRATION_BUFF_TICKS * 0.2));
        v.hydrationTimer = Math.max(0, v.hydrationTimer - 1);
        if (active) noteBuildingActivity(active, 'hydrate');
        v.happy = clamp(v.happy + HYDRATION_MOOD_TICK, 0, 1);
        v.thought = moodThought(v, 'Drinking');
        if (v.hydrationTimer <= 0) {
          endBuildingStay(v);
          v.state = 'idle';
          v.hydrationTimer = 0;
          v.nextHydrateTick = tick + Math.floor(DAY_LENGTH * 0.16);
          v.thought = moodThought(v, 'Hydrated');
        } else {
          return;
        }
      }
    }

    if (v.state === 'socializing') {
      if (urgentFood) { endBuildingStay(v); v.state = 'idle'; }
      else {
        v.socialTimer = Math.max(v.socialTimer || 0, SOCIAL_BASE_TICKS);
        v.socialTimer = Math.max(0, v.socialTimer - 1);
        v.happy = clamp(v.happy + SOCIAL_MOOD_TICK, 0, 1);
        v.energy = clamp(v.energy + SOCIAL_ENERGY_TICK, 0, 1);
        const active = getBuildingById(v.activeBuildingId);
        if (active) noteBuildingActivity(active, 'social');
        v.thought = moodThought(v, 'Sharing stories');
        if (v.socialTimer <= 0) {
          endBuildingStay(v);
          v.state = 'idle';
          v.nextSocialTick = tick + SOCIAL_COOLDOWN_TICKS;
          v.thought = moodThought(v, 'Refreshed');
        } else {
          return;
        }
      }
    }

    if (v.state === 'storage_linger') {
      if (urgentFood) { endBuildingStay(v); v.state = 'idle'; }
      else {
        v.storageIdleTimer = Math.max(v.storageIdleTimer || 0, STORAGE_IDLE_BASE);
        v.storageIdleTimer = Math.max(0, v.storageIdleTimer - 1);
        v.happy = clamp(v.happy + 0.00045, 0, 1);
        const active = getBuildingById(v.activeBuildingId);
        if (active) noteBuildingActivity(active, 'use');
        v.thought = moodThought(v, 'Tidying storage');
        if (v.storageIdleTimer <= 0) {
          endBuildingStay(v);
          v.state = 'idle';
          v.nextStorageIdleTick = tick + STORAGE_IDLE_COOLDOWN;
          v.thought = moodThought(v, 'Organized');
        } else {
          return;
        }
      }
    }

    // Phase 7 (B3/S6): the 'building' transient state accumulates labor on a
    // build site that already has its materials. The job stays in the queue
    // until laborProgress reaches buildLaborTicks; if the villager bails out
    // (urgentFood, missing site), another villager can pick the job up and
    // resume from the existing laborProgress.
    if (v.state === 'building') {
      if (urgentFood) {
        endBuildingStay(v);
        v.state = 'idle';
        finishJob(v, false);
      } else {
        const b = getBuildingById(v.activeBuildingId)
          || (v.targetJob ? buildings.find(bb => bb.id === v.targetJob.bid) : null);
        if (!b) {
          endBuildingStay(v);
          v.state = 'idle';
          finishJob(v, true);
        } else if (b.built >= 1) {
          endBuildingStay(v);
          v.state = 'idle';
          finishJob(v, true);
        } else {
          const def = BUILDINGS[b.kind] || {};
          const laborGoal = def.buildLaborTicks | 0;
          b.laborProgress = (b.laborProgress | 0) + 1;
          noteBuildingActivity(b, 'use');
          if (b.laborProgress >= laborGoal) {
            b.built = 1;
            if (!b.spent) b.spent = { wood: 0, stone: 0 };
            b.spent.wood = def.wood || 0;
            b.spent.stone = def.stone || 0;
            b.progress = def.cost || ((def.wood || 0) + (def.stone || 0));
            if (!b.store) b.store = { wood: 0, stone: 0, food: 0 };
            for (const res of ['wood', 'stone', 'food']) {
              const leftover = b.store[res] || 0;
              if (leftover > 0) {
                storageTotals[res] = (storageTotals[res] || 0) + leftover;
                b.store[res] = 0;
              }
            }
            if (b.kind === 'campfire') markEmittersDirty();
            cancelHaulJobsForBuilding(b);
            markStaticDirty();
            applySkillGain(v, 'constructionSkill', 0.02, 0.9, 1);
            addJobExperience(v, 'build', 3);
            v.thought = moodThought(v, 'Built');
            endBuildingStay(v);
            v.state = 'idle';
            finishJob(v, true);
          } else {
            v.thought = moodThought(v, 'Building');
            return;
          }
        }
      }
    }

    if (urgentFood) {
      if (consumeFood(v)) { v.thought = moodThought(v, 'Eating'); return; }
      if (foragingJob(v)) return;
      if (seekEmergencyFood(v, { pathLimit: 240, radius: 16 })) return;
    } else if (needsFood) {
      if (consumeFood(v)) { v.thought = moodThought(v, 'Eating'); return; }
      if (foragingJob(v)) return;
    }
    // Panic harvest behavior when hungry: grab ripe crops if idle and food is tight.
    if ((urgentFood || needsFood) && v.state === 'idle' && !v.targetJob) {
      panicHarvestJob = findPanicHarvestJob(v);
    }
    if (v.state === 'idle' && !urgentFood && !needsFood && !v.targetJob) {
      if (tryEquipBow(v)) return;
    }
    // Single source of truth for the rest decision (audit B1). The scoring
    // knob style.energyFatigueThreshold is intentionally NOT consulted here;
    // it controls job-scoring penalties and the blackboard fatigue flag.
    const restThreshold = Number.isFinite(style.restEnergyThreshold) ? style.restEnergyThreshold : 0.26;
    const restFatigueBoost = Number.isFinite(style.restFatigueBoost) ? style.restFatigueBoost : 0.04;
    const fatigueFlag = !!blackboard?.energy?.fatigue;
    const effectiveRest = fatigueFlag ? restThreshold + restFatigueBoost : restThreshold;
    if (v.energy < effectiveRest) { if (goRest(v)) return; }
    // Audit S1: night-anchored sleep. Pulls idle villagers to bed at night so
    // day/night has felt meaning. Sits before hydrate/social so sleep wins
    // when a villager wants to be in bed.
    if (v.state === 'idle' && !v.targetJob
        && wantsToSleep(v, { nightNow, deepNight: isDeepNight(dayTime), urgentFood })) {
      v._fellAsleepAtNight = nightNow;
      if (goRest(v)) return;
    }
    if (v.state === 'idle' && !urgentFood) {
      if (tryHydrateAtWell(v)) return;
    }
    if (nightNow && v.state === 'idle' && !needsFood && !urgentFood && !v.targetJob) {
      if (tryCampfireSocial(v, { ambientNow, forceNight: true })) return;
    }
    const reprioritizeMargin = Number.isFinite(style.reprioritizeMargin) ? style.reprioritizeMargin : 0.06;
    if (maybeInterruptJob(v, { blackboard, margin: reprioritizeMargin })) return;
    if (v.path && v.path.length > 0) { stepAlong(v); return; }
    if (v.inv) {
      const s = findNearestBuilding(v.x | 0, v.y | 0, 'storage');
      if (s && tick >= v._nextPathTick) {
        const entry = findEntryTileNear(s, v.x | 0, v.y | 0) || { x: Math.round(buildingCenter(s).x), y: Math.round(buildingCenter(s).y) };
        const p = pathfind(v.x | 0, v.y | 0, entry.x, entry.y);
        if (p) {
          v.path = p;
          v.state = 'to_storage';
          v.thought = moodThought(v, 'Storing');
          v._nextPathTick = tick + 12;
          return;
        }
      }
    }
    if (v.lifeStage === 'child') {
      v.targetJob = null;
    }
    const j = (panicHarvestJob || pickJobFor(v));
    if (j && tick >= v._nextPathTick) {
      let dest = { x: j.x, y: j.y };
      let plannedPath = null;
      if (j.type === 'build') {
        const b = buildings.find(bb => bb.id === j.bid);
        if (b) {
          const entry = findEntryTileNear(b, v.x | 0, v.y | 0);
          if (entry) { dest = entry; }
          else {
            const center = buildingCenter(b);
            dest = { x: Math.round(center.x), y: Math.round(center.y) };
          }
        }
      } else if (j.type === 'haul') {
        if (j.src) {
          const srcBuilding = buildingAt(j.src.x, j.src.y);
          if (srcBuilding) {
            const entry = findEntryTileNear(srcBuilding, v.x | 0, v.y | 0);
            if (entry) { dest = entry; }
            else { dest = { x: j.src.x, y: j.src.y }; }
          } else { dest = { x: j.src.x, y: j.src.y }; }
        } else {
          const b = buildings.find(bb => bb.id === j.bid);
          if (b) {
            const entry = findEntryTileNear(b, v.x | 0, v.y | 0);
            if (entry) { dest = entry; }
            else {
              const center = buildingCenter(b);
              dest = { x: Math.round(center.x), y: Math.round(center.y) };
            }
          }
        }
      } else if (j.type === 'craft_bow') {
        const lodge = buildings.find(bb => bb.id === j.bid && bb.kind === 'hunterLodge');
        if (lodge) {
          const entry = findEntryTileNear(lodge, v.x | 0, v.y | 0);
          if (entry) { dest = entry; }
          else {
            const center = buildingCenter(lodge);
            dest = { x: Math.round(center.x), y: Math.round(center.y) };
          }
        }
      } else if (j.type === 'hunt') {
        const animal = findAnimalById(j.targetAid);
        if (animal) {
          const approach = findHuntApproachPath(v, animal, { range: HUNT_RANGE });
          if (approach) {
            dest = approach.dest;
            plannedPath = approach.path;
          }
        }
        if (!plannedPath) {
          suppressJob(j, HUNT_RETRY_COOLDOWN);
          v._nextPathTick = tick + 12;
          // No viable path; skip further processing for this villager until retry.
          return;
        }
      }
      const p = plannedPath || pathfind(v.x | 0, v.y | 0, dest.x, dest.y);
      if (p) {
        v.path = p;
        v.state = j.type === 'haul' ? 'haul_pickup' : j.type;
        if (j.type === 'forage' && Number.isInteger(j.targetI)) {
          v.targetI = j.targetI;
        }
        v.targetJob = j;
        v.thought = j.type === 'haul' ? moodThought(v, 'Hauling') : moodThought(v, j.type.toUpperCase());
        j.assigned++;
        noteJobAssignmentChanged(j);
        v._nextPathTick = tick + 12;
        return;
      }
      const retryTicks = Number.isFinite(getJobCreationConfig()?.unreachableRetryTicks)
        ? getJobCreationConfig().unreachableRetryTicks
        : 0;
      if (retryTicks > 0) {
        suppressJob(j, retryTicks);
      }
      v._nextPathTick = tick + 12;
    }
    if (!j && v.state === 'idle' && !urgentFood && !v.targetJob && jobs.length === 0) {
      if (tryStorageIdle(v)) return;
    }
    if (v.state === 'idle' && !needsFood && !urgentFood && !v.targetJob) {
      if (tryCampfireSocial(v, { ambientNow })) return;
    }
    if (handleIdleRoam(v, { stage, needsFood, urgentFood })) return;
  }

  return { villagerTick };
}
