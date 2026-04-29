import { DAY_LENGTH, GRID_H, GRID_W, TILES } from './constants.js';
import { R, clamp, rnd, uid } from './rng.js';
import { createExperienceLedger, moodThought } from './simulation.js';

export const PREGNANCY_TICKS = DAY_LENGTH * 2;
export const CHILDHOOD_TICKS = DAY_LENGTH * 5;
export const PREGNANCY_ATTEMPT_COOLDOWN_TICKS = Math.floor(DAY_LENGTH * 1.1);
export const PREGNANCY_ATTEMPT_CHANCE = 0.12;
// Short recheck cooldown for villagers that fail body-state eligibility
// (tired, sad, sick, hungry). Keeps tryStartPregnancy off the hot path:
// at TICKS_PER_SECOND=6 this is ~10 s of game time per re-evaluation.
export const PREGNANCY_RECHECK_TICKS = 60;
export const POPULATION_SOFT_BUFFER = 2;
export const POPULATION_HARD_CAP = 80;
export const FOOD_HEADROOM_PER_VILLAGER = 1.25;

export function createPopulation(opts) {
  const {
    state,
    countBuildingsByKind,
    tileOccupiedByBuilding,
    idx,
    ensureVillagerNumber,
  } = opts;

  const villagers = state.units.villagers;
  const storageTotals = state.stocks.totals;
  // Drained every tick by flushPendingBirths (see src/app/tick.js); lifetime
  // of any entry is < 1 tick, so we deliberately don't persist it in saves.
  const pendingBirths = [];

  function getWorld() { return state.world; }
  function getTick() { return state.time.tick; }

  function rollAdultRole() {
    const r = R();
    return r < 0.25 ? 'farmer' : r < 0.5 ? 'worker' : r < 0.75 ? 'explorer' : 'sleepy';
  }

  function assignAdultTraits(v, role = rollAdultRole()) {
    const farmingSkill = Math.min(1, Math.max(0, rnd(0.35, 0.75) + (role === 'farmer' ? 0.1 : 0)));
    const constructionSkill = Math.min(1, Math.max(0, rnd(0.35, 0.7) + (role === 'worker' ? 0.12 : 0)));
    v.role = role;
    v.speed = 2 + rnd(-0.2, 0.2);
    v.farmingSkill = farmingSkill;
    v.constructionSkill = constructionSkill;
  }

  function newVillager(x, y) {
    const v = {
      id: uid(),
      x, y,
      path: [],
      hunger: rnd(0.2, 0.5),
      energy: rnd(0.5, 0.9),
      happy: rnd(0.4, 0.8),
      hydration: 0.7,
      hydrationBuffTicks: 0,
      nextHydrateTick: 0,
      inv: null,
      state: 'idle',
      thought: 'Wandering',
      _nextPathTick: 0,
      _wanderFailures: new Map(),
      _forageFailures: new Map(),
      condition: 'normal',
      starveStage: 0,
      nextStarveWarning: 0,
      sickTimer: 0,
      recoveryTimer: 0,
      ageTicks: 0,
      lifeStage: 'adult',
      pregnancyTimer: 0,
      pregnancyMateId: null,
      childhoodTimer: 0,
      parents: [],
      nextPregnancyTick: 0,
      socialTimer: 0,
      nextSocialTick: 0,
      storageIdleTimer: 0,
      nextStorageIdleTick: 0,
      hydrationTimer: 0,
      activeBuildingId: null,
      equippedBow: false,
      experience: createExperienceLedger(),
    };
    assignAdultTraits(v);
    ensureVillagerNumber(v);
    return v;
  }

  function newChildVillager(x, y, parents) {
    const v = newVillager(x, y);
    v.role = 'child';
    v.speed = 1.6 + rnd(-0.1, 0.1);
    v.hunger = rnd(0.1, 0.3);
    v.energy = rnd(0.55, 0.85);
    v.happy = rnd(0.45, 0.85);
    v.lifeStage = 'child';
    v.childhoodTimer = CHILDHOOD_TICKS;
    v.pregnancyTimer = 0;
    v.pregnancyMateId = null;
    v.farmingSkill = Math.max(0, v.farmingSkill - 0.2);
    v.constructionSkill = Math.max(0, v.constructionSkill - 0.2);
    v.parents = Array.isArray(parents) ? parents.slice(0, 2) : [];
    return v;
  }

  function housingCapacity() {
    const huts = countBuildingsByKind('hut');
    return Math.max(6, huts.built * 2 + 4);
  }

  function populationLimit(availableFood) {
    const housingGate = housingCapacity() + POPULATION_SOFT_BUFFER;
    const foodGate = Math.max(0, Math.floor((availableFood || 0) / FOOD_HEADROOM_PER_VILLAGER));
    const rawLimit = Math.min(housingGate, foodGate);
    return Math.max(6, Math.min(POPULATION_HARD_CAP, rawLimit));
  }

  function canSupportBirth() {
    const availableFood = storageTotals.food || 0;
    const projectedPop = villagers.length + pendingBirths.length;
    const housingRoom = housingCapacity() - projectedPop;
    if (housingRoom <= 0) return false;
    const underCap = projectedPop < populationLimit(availableFood);
    const wellFed = availableFood > Math.max(4, projectedPop * 0.8);
    return underCap && wellFed;
  }

  function isPregnancyEligible(v) {
    if (v.lifeStage !== 'adult') return false;
    if (v.pregnancyTimer > 0) return false;
    if ((v.starveStage || 0) >= 1) return false;
    if (v.condition === 'sick') return false;
    if ((v.energy || 0) < 0.4) return false;
    if ((v.happy || 0) < 0.35) return false;
    return true;
  }

  function findBirthMate(v) {
    const tick = getTick();
    let best = null;
    let bestDist = Infinity;
    for (const other of villagers) {
      if (other === v) continue;
      if ((other.nextPregnancyTick || 0) > tick) continue;
      if (!isPregnancyEligible(other)) continue;
      const dist = Math.abs((other.x | 0) - (v.x | 0)) + Math.abs((other.y | 0) - (v.y | 0));
      if (dist < bestDist) { best = other; bestDist = dist; }
    }
    return best;
  }

  function tryStartPregnancy(v) {
    const tick = getTick();
    if (tick < (v.nextPregnancyTick || 0)) return;
    if (!isPregnancyEligible(v)) {
      v.nextPregnancyTick = tick + PREGNANCY_RECHECK_TICKS;
      return;
    }
    if (!canSupportBirth()) {
      v.nextPregnancyTick = Math.max(v.nextPregnancyTick || 0, tick + Math.floor(PREGNANCY_ATTEMPT_COOLDOWN_TICKS * 0.5));
      return;
    }
    if (R() > PREGNANCY_ATTEMPT_CHANCE) {
      v.nextPregnancyTick = tick + PREGNANCY_ATTEMPT_COOLDOWN_TICKS;
      return;
    }
    const mate = findBirthMate(v);
    const cooldownUntil = tick + PREGNANCY_ATTEMPT_COOLDOWN_TICKS;
    if (!mate) {
      v.nextPregnancyTick = cooldownUntil;
      return;
    }
    v.pregnancyTimer = PREGNANCY_TICKS;
    v.pregnancyMateId = mate.id;
    v.thought = moodThought(v, 'Expecting');
    v.nextPregnancyTick = cooldownUntil;
    mate.nextPregnancyTick = Math.max(mate.nextPregnancyTick || 0, cooldownUntil);
  }

  function spawnChildNearParents(parent, mate) {
    const world = getWorld();
    const centerX = Math.round((parent.x + (mate ? mate.x : parent.x)) / 2);
    const centerY = Math.round((parent.y + (mate ? mate.y : parent.y)) / 2);
    const offsets = [
      { dx: 0, dy: 0 }, { dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 },
      { dx: 0, dy: -1 }, { dx: 1, dy: 1 }, { dx: -1, dy: 1 }, { dx: 1, dy: -1 },
      { dx: -1, dy: -1 },
    ];
    const parents = [parent.id];
    if (mate?.id) parents.push(mate.id);
    for (const off of offsets) {
      const x = clamp(centerX + off.dx, 0, GRID_W - 1);
      const y = clamp(centerY + off.dy, 0, GRID_H - 1);
      const i = idx(x, y);
      if (i < 0) continue;
      if (tileOccupiedByBuilding(x, y)) continue;
      if (world.tiles[i] === TILES.WATER) continue;
      pendingBirths.push({ x, y, parents });
      return true;
    }
    return false;
  }

  function flushPendingBirths() {
    if (pendingBirths.length === 0) return;
    for (const birth of pendingBirths) {
      villagers.push(newChildVillager(birth.x, birth.y, birth.parents));
    }
    pendingBirths.length = 0;
  }

  function completePregnancy(v) {
    const mate = v.pregnancyMateId ? villagers.find(o => o.id === v.pregnancyMateId) : null;
    if (!spawnChildNearParents(v, mate)) {
      v.pregnancyTimer = 10;
      return;
    }
    v.pregnancyTimer = 0;
    v.pregnancyMateId = null;
    v.thought = moodThought(v, 'Newborn');
  }

  function promoteChildToAdult(v) {
    const tick = getTick();
    v.lifeStage = 'adult';
    v.childhoodTimer = 0;
    assignAdultTraits(v);
    v.nextPregnancyTick = Math.max(v.nextPregnancyTick || 0, tick + PREGNANCY_ATTEMPT_COOLDOWN_TICKS);
    v.thought = moodThought(v, 'Grew up');
  }

  return {
    pendingBirths,
    rollAdultRole,
    assignAdultTraits,
    newVillager,
    newChildVillager,
    housingCapacity,
    populationLimit,
    canSupportBirth,
    isPregnancyEligible,
    findBirthMate,
    tryStartPregnancy,
    spawnChildNearParents,
    flushPendingBirths,
    completePregnancy,
    promoteChildToAdult,
  };
}
