import {
  DAY_LENGTH,
  GRID_H,
  GRID_W,
  ITEM,
} from './constants.js';
import { CAMPFIRE_EFFECT_RADIUS, buildingCenter, buildingSupplyStatus, distanceToFootprint } from './world.js';
import { R, clamp, irnd } from './rng.js';
import {
  isDawnAmbient,
  isNightAmbient,
  moodThought,
} from './simulation.js';
import { score as scoreJob, computeFamineSeverity } from '../ai/scoring.js';

// Single source of truth for villager-tuning constants. villagerTick.js,
// onArrive.js, and this module all read from here.
export const STARVE_THRESH = { hungry: 0.82, starving: 1.08, sick: 1.18 };
export const STARVE_COLLAPSE_TICKS = 140;
export const STARVE_RECOVERY_TICKS = 280;
export const STARVE_TOAST_COOLDOWN = 420;
export const FOOD_HUNGER_RECOVERY = 0.65;
export const REST_BASE_TICKS = 90;
export const REST_EXTRA_PER_ENERGY = 110;
export const HYDRATION_VISIT_THRESHOLD = 0.46;
// Phase 10 (S10): shorter buff window so the energy/hunger/mood bonus is a
// punctual reward rather than the default state. With Phase 10's faster decay
// villagers visit wells ~2× per day, but the buff still only covers ~5.5%
// of the day instead of ~9%.
export const HYDRATION_BUFF_TICKS = 200;
export const SOCIAL_BASE_TICKS = 88;
export const SOCIAL_COOLDOWN_TICKS = DAY_LENGTH * 0.2;
export const STORAGE_IDLE_BASE = 70;
export const STORAGE_IDLE_COOLDOWN = DAY_LENGTH * 0.12;

// Single source of truth for rest duration (audit S3). Both villagerTick.js
// and onArrive.js use this so the in-state clamp and the on-arrive seed can
// never drift apart again.
export function restDurationTicks(energy) {
  const e = Number.isFinite(energy) ? energy : 0;
  return REST_BASE_TICKS + Math.round(Math.max(0, 1 - e) * REST_EXTRA_PER_ENERGY);
}

// Phase 10 (S5): per-action work efficiency. Building labor (Phase 7)
// accumulates by this fraction per tick instead of a flat 1, and harvest
// yield is scaled by the same factor (with a min of 1 food). Single source of
// truth so villagerTick.js and onArrive.js can't drift.
export function workEffortMultiplier(v) {
  const condition = v?.condition || 'normal';
  const conditionMult = condition === 'sick' ? 0.5
    : condition === 'starving' ? 0.7
    : condition === 'hungry' ? 0.9
    : 1;
  const energy = Number.isFinite(v?.energy) ? v.energy : 1;
  const energyMult = energy < 0.30 ? 0.85 : 1;
  return conditionMult * energyMult;
}

// Night-anchored sleep predicate (audit S1). Pure function so tests can
// mirror it without instantiating the full villager-tick state machine.
// Critical active states ('building', 'hunt') and urgentFood override the
// night pull; the 0.30 hard floor still always sleeps.
export function wantsToSleep(v, { nightNow, deepNight, urgentFood } = {}) {
  if (urgentFood) return false;
  const energy = Number.isFinite(v?.energy) ? v.energy : 1;
  const criticalState = v?.state === 'building' || v?.state === 'hunt';
  if (energy < 0.30) return true;
  if (criticalState) return false;
  if (deepNight) return true;
  if (nightNow && energy < 0.65) return true;
  return false;
}

export function createVillagerAI(opts) {
  const {
    state,
    policy,
    pathfind,
    passable,
    Toast,
    addJob: _addJob, // unused but kept for symmetry; pickJobFor doesn't add jobs directly
    finishJob,
    noteJobAssignmentChanged,
    availableToReserve: _availableToReserve,
    reserveMaterials,
    releaseReservedMaterials,
    findAnimalById,
    findEntryTileNear,
    getBuildingById: _getBuildingById,
    buildingsByKind,
    idx,
    ambientAt,
    isNightTime,
  } = opts;

  void _addJob;
  void _availableToReserve;
  void _getBuildingById;

  const buildings = state.units.buildings;
  const jobs = state.units.jobs;
  const villagers = state.units.villagers;
  const itemsOnGround = state.units.itemsOnGround;
  const storageTotals = state.stocks.totals;

  function getWorld() { return state.world; }
  function getTick() { return state.time.tick; }
  function getDayTime() { return state.time.dayTime; }

  function findNearestBuilding(x, y, kind) {
    let best = null, bd = Infinity;
    const list = buildingsByKind.get(kind);
    if (!list) return null;
    for (const b of list) {
      if (b.built < 1) continue;
      const d = distanceToFootprint(x, y, b);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  function nearbyWarmth(x, y) {
    return buildings.some(b => b.kind === 'campfire' && distanceToFootprint(x, y, b) <= CAMPFIRE_EFFECT_RADIUS);
  }

  function issueStarveToast(v, text, force = false) {
    const tick = getTick();
    const ready = (v.nextStarveWarning || 0) <= tick;
    if (force || ready) {
      Toast.show(text);
      v.nextStarveWarning = tick + STARVE_TOAST_COOLDOWN;
    }
  }

  function enterSickState(v) {
    if (v.condition === 'sick') return;
    v.condition = 'sick';
    v.sickTimer = STARVE_COLLAPSE_TICKS;
    v.starveStage = Math.max(3, v.starveStage || 0);
    finishJob(v);
    if (v.path) v.path.length = 0;
    v.state = 'sick';
    v.thought = moodThought(v, 'Collapsed');
    issueStarveToast(v, 'A villager collapsed from hunger! They need food now.', true);
  }

  function handleVillagerFed(v, source = 'food') {
    const tick = getTick();
    const wasCritical = (v.condition === 'sick') || ((v.starveStage || 0) >= 2);
    v.sickTimer = 0;
    v.starveStage = 0;
    if (wasCritical) {
      v.condition = 'recovering';
      v.recoveryTimer = STARVE_RECOVERY_TICKS;
    } else {
      v.condition = 'normal';
      // recoveryTimer intentionally untouched (audit B7): healthy meals must
      // not arm the buff, but a real in-flight recovery must not be shortened.
    }
    v.nextStarveWarning = tick + Math.floor(STARVE_TOAST_COOLDOWN * 0.6);
    if (v.state === 'sick') v.state = 'idle';
    v.thought = moodThought(v, wasCritical ? 'Recovering' : 'Content');
    v.happy = clamp(v.happy + 0.05, 0, 1);
    if (wasCritical) {
      const detail = source === 'camp' ? 'camp stores'
        : source === 'pack' ? 'their pack'
        : source === 'berries' ? 'wild berries'
        : source;
      issueStarveToast(v, `Villager recovered after eating ${detail}.`, true);
    }
  }

  function consumeFood(v) {
    let source = null;
    if (v.inv && v.inv.type === ITEM.FOOD) {
      v.hunger -= FOOD_HUNGER_RECOVERY;
      v.inv = null;
      source = 'pack';
    } else if (storageTotals.food > 0) {
      storageTotals.food--;
      v.hunger -= FOOD_HUNGER_RECOVERY;
      source = 'camp';
    }
    if (source) {
      if (v.hunger < 0) v.hunger = 0;
      handleVillagerFed(v, source);
      return true;
    }
    return false;
  }

  function nearestFoodTarget(v, { radius = 12, pathLimit = 200 } = {}) {
    const world = getWorld();
    const sx = v.x | 0, sy = v.y | 0;
    let best = null;
    const consider = (target) => {
      if (!target) return;
      const { x, y, kind, targetI } = target;
      const p = pathfind(sx, sy, x, y, pathLimit);
      if (!p) return;
      const score = p.length;
      if (!best || score < best.score) {
        best = { path: p, score, kind, x, y, targetI };
      }
    };
    if (storageTotals.food > 0) {
      const storage = findNearestBuilding(sx, sy, 'storage');
      if (storage) {
        const entry = findEntryTileNear(storage, sx, sy) || { x: Math.round(buildingCenter(storage).x), y: Math.round(buildingCenter(storage).y) };
        consider({ x: entry.x, y: entry.y, kind: 'storage' });
      }
    }
    for (const it of itemsOnGround) {
      if (!it || it.type !== ITEM.FOOD) continue;
      consider({ x: it.x, y: it.y, kind: 'ground' });
    }
    const clampX = (val) => clamp(val, 0, GRID_W - 1);
    const clampY = (val) => clamp(val, 0, GRID_H - 1);
    const x0 = clampX(sx - radius), x1 = clampX(sx + radius);
    const y0 = clampY(sy - radius), y1 = clampY(sy + radius);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = idx(x, y);
        if (i < 0) continue;
        if (world.berries[i] > 0) {
          consider({ x, y, kind: 'berry', targetI: i });
        }
      }
    }
    return best;
  }

  function seekEmergencyFood(v, { radius = 14, pathLimit = 200 } = {}) {
    const tick = getTick();
    if (tick < v._nextPathTick) return false;
    const target = nearestFoodTarget(v, { radius, pathLimit });
    if (!target) return false;
    v.path = target.path;
    const cooldown = Math.max(8, Math.min(22, target.path.length + 6));
    v._nextPathTick = tick + cooldown;
    if (target.kind === 'berry') {
      // Attach an existing planner-emitted forage job at this tile so the
      // arrival path's finishJob(remove=true) cleans it up. Without this,
      // the queue accumulates orphaned forage jobs at picked-empty tiles.
      const existing = jobs.find(j =>
        j && j.type === 'forage'
        && j.targetI === target.targetI
        && (j.assigned || 0) < 1
      );
      if (existing) {
        // Release any prior claim so its assigned counter doesn't leak when
        // the urgent-food path interrupts a non-forage job.
        if (v.targetJob && v.targetJob !== existing) finishJob(v);
        v.targetJob = existing;
        existing.assigned = (existing.assigned || 0) + 1;
        noteJobAssignmentChanged(existing);
      }
      v.state = 'forage';
      v.targetI = target.targetI;
      v.thought = moodThought(v, 'Foraging');
    } else {
      v.state = 'seek_food';
      v.targetFood = target.kind;
      v.targetFoodPos = { x: target.x, y: target.y };
      v.thought = moodThought(v, 'Seeking food');
    }
    return true;
  }

  function getRallyPoint() {
    const camp = buildings.find(b => b.kind === 'campfire' && b.built >= 1);
    if (camp) {
      const entry = findEntryTileNear(camp, camp.x, camp.y) || { x: Math.round(buildingCenter(camp).x), y: Math.round(buildingCenter(camp).y) };
      return entry;
    }
    const storage = buildings.find(b => b.kind === 'storage' && b.built >= 1);
    if (storage) {
      const entry = findEntryTileNear(storage, storage.x, storage.y) || { x: Math.round(buildingCenter(storage).x), y: Math.round(buildingCenter(storage).y) };
      return entry;
    }
    return null;
  }

  function countNearbyVillagers(v, radius = 3) {
    const sx = v.x, sy = v.y;
    let count = 0;
    for (const other of villagers) {
      if (other === v) continue;
      if (Math.abs(other.x - sx) <= radius && Math.abs(other.y - sy) <= radius) {
        count++;
      }
    }
    return count;
  }

  function collectFoodHubs(v, radius = 12) {
    const world = getWorld();
    const hubs = [];
    const sx = v.x | 0, sy = v.y | 0;
    const radiusX = Math.max(1, radius);
    const clampX = (val) => clamp(val, 0, GRID_W - 1);
    const clampY = (val) => clamp(val, 0, GRID_H - 1);
    if (storageTotals.food > 0) {
      for (const b of buildings) {
        if (b.kind !== 'storage' || b.built < 1) continue;
        const c = buildingCenter(b);
        hubs.push({ x: Math.round(c.x), y: Math.round(c.y), weight: 2.5 });
      }
    }
    for (const b of buildings) {
      if (b.kind === 'campfire' && b.built >= 1) {
        const c = buildingCenter(b);
        hubs.push({ x: Math.round(c.x), y: Math.round(c.y), weight: 1.5 });
      }
    }
    for (const it of itemsOnGround) {
      if (!it || it.type !== ITEM.FOOD) continue;
      if (Math.abs(it.x - sx) <= radiusX && Math.abs(it.y - sy) <= radiusX) {
        hubs.push({ x: it.x, y: it.y, weight: 3 });
      }
    }
    const x0 = clampX(sx - radiusX), x1 = clampX(sx + radiusX);
    const y0 = clampY(sy - radiusX), y1 = clampY(sy + radiusX);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = idx(x, y);
        if (i < 0) continue;
        if (world.berries[i] > 0) {
          hubs.push({ x, y, weight: 2 });
        }
      }
    }
    return hubs;
  }

  function pickWeightedRandom(candidates) {
    if (!candidates || candidates.length === 0) return null;
    const total = candidates.reduce((sum, c) => sum + (c.weight || 1), 0);
    let r = R() * total;
    for (const c of candidates) {
      r -= c.weight || 1;
      if (r <= 0) return c;
    }
    return candidates[candidates.length - 1];
  }

  function selectReachableWanderTarget(v, candidates, pathLimit, cooldown) {
    if (!candidates || candidates.length === 0) return null;
    const tick = getTick();
    for (const [key, until] of Array.from(v._wanderFailures.entries())) {
      if (until <= tick) v._wanderFailures.delete(key);
    }
    const attempts = Math.min(8, candidates.length * 2);
    for (let n = 0; n < attempts; n++) {
      const cand = pickWeightedRandom(candidates);
      if (!cand) break;
      const cx = clamp(cand.x | 0, 0, GRID_W - 1);
      const cy = clamp(cand.y | 0, 0, GRID_H - 1);
      const key = idx(cx, cy);
      if (key < 0) continue;
      const failedUntil = v._wanderFailures.get(key);
      if (failedUntil && failedUntil > tick) continue;
      if (!passable(cx, cy)) {
        v._wanderFailures.set(key, tick + 180);
        continue;
      }
      const p = pathfind(v.x | 0, v.y | 0, cx, cy, pathLimit);
      if (p) {
        return { path: p, cooldown };
      }
      v._wanderFailures.set(key, tick + 240);
    }
    return null;
  }

  function handleIdleRoam(v, { stage, needsFood, urgentFood }) {
    const tick = getTick();
    const baseRange = stage === 1 ? 3 : 4;
    const crowd = countNearbyVillagers(v, 3);
    const crowdCooldown = Math.max(10, 12 + Math.max(0, crowd - 2) * 4 + irnd(0, 4));
    const adjustedRange = crowd > 3 ? Math.max(1, baseRange - 1) : baseRange;
    if (urgentFood && seekEmergencyFood(v, { radius: 14, pathLimit: 220 })) return true;
    const rally = (!needsFood && !urgentFood && !v.inv) ? getRallyPoint() : null;
    const ready = tick >= v._nextPathTick;
    if (rally && ready) {
      const rallyPath = pathfind(v.x | 0, v.y | 0, rally.x, rally.y, 160);
      if (rallyPath) {
        v.path = rallyPath;
        v.thought = moodThought(v, 'Regrouping');
        v._nextPathTick = tick + crowdCooldown;
        return true;
      }
    }
    const hungry = needsFood || urgentFood;
    const hubs = hungry ? collectFoodHubs(v, 12) : [];
    const candidates = [];
    if (hubs.length > 0) {
      for (const hub of hubs) {
        candidates.push({
          x: clamp(hub.x + irnd(-2, 2), 0, GRID_W - 1),
          y: clamp(hub.y + irnd(-2, 2), 0, GRID_H - 1),
          weight: hub.weight || 1,
        });
      }
    }
    const cx = v.x | 0, cy = v.y | 0;
    for (let i = 0; i < 4; i++) {
      candidates.push({
        x: clamp(cx + irnd(-adjustedRange, adjustedRange), 0, GRID_W - 1),
        y: clamp(cy + irnd(-adjustedRange, adjustedRange), 0, GRID_H - 1),
        weight: 1,
      });
    }
    const pathLimit = hungry ? 120 : 80;
    const wander = ready ? selectReachableWanderTarget(v, candidates, pathLimit, crowdCooldown + irnd(0, 4)) : null;
    v.thought = moodThought(v, urgentFood ? 'Starving' : (stage === 1 ? 'Hungry' : 'Wandering'));
    if (wander) {
      v.path = wander.path;
      v._nextPathTick = tick + wander.cooldown;
    } else if (tick >= v._nextPathTick) {
      v._nextPathTick = tick + crowdCooldown;
    }
    return true;
  }

  function foragingJob(v) {
    const tick = getTick();
    const world = getWorld();
    if (tick < v._nextPathTick) return false;
    const style = policy?.style?.jobScoring || {};
    const bb = state?.bb;
    const famineSeverity = computeFamineSeverity(bb);
    const baseRadius = 10;
    const maxRadius = Number.isFinite(style.adaptiveForageMaxRadius) ? style.adaptiveForageMaxRadius : 18;
    const radius = Math.max(baseRadius, Math.round(baseRadius + famineSeverity * Math.max(0, maxRadius - baseRadius)));
    const basePathLimit = 120;
    const maxPathLimit = Number.isFinite(style.adaptiveForageMaxPath) ? style.adaptiveForageMaxPath : 240;
    const pathLimit = Math.max(basePathLimit, Math.round(basePathLimit + famineSeverity * Math.max(0, maxPathLimit - basePathLimit)));
    const sx = v.x | 0, sy = v.y | 0;
    let best = null, bd = 999;
    for (const [key, until] of Array.from(v._forageFailures.entries())) {
      if (until <= tick) v._forageFailures.delete(key);
    }
    for (let y = sy - radius; y <= sy + radius; y++) {
      for (let x = sx - radius; x <= sx + radius; x++) {
        const i = idx(x, y);
        if (i < 0) continue;
        if (world.berries[i] > 0) {
          if (v._forageFailures.has(i)) continue;
          const d = Math.abs(x - sx) + Math.abs(y - sy);
          if (d < bd) { bd = d; best = { x, y, i }; }
        }
      }
    }
    if (best) {
      const p = pathfind(v.x | 0, v.y | 0, best.x, best.y, pathLimit);
      if (p) {
        v.path = p;
        v.state = 'forage';
        v.targetI = best.i;
        v.thought = moodThought(v, 'Foraging');
        v._nextPathTick = tick + 12;
        return true;
      }
      v._forageFailures.set(best.i, tick + 180);
    }
    return false;
  }

  function goRest(v) {
    const tick = getTick();
    if (tick < v._nextPathTick) return false;
    const hut = findNearestBuilding(v.x | 0, v.y | 0, 'hut') || buildings.find(b => b.kind === 'campfire' && b.built >= 1);
    if (hut) {
      const entry = findEntryTileNear(hut, v.x | 0, v.y | 0) || { x: Math.round(buildingCenter(hut).x), y: Math.round(buildingCenter(hut).y) };
      const p = pathfind(v.x | 0, v.y | 0, entry.x, entry.y);
      if (p) {
        v.path = p;
        v.state = 'rest';
        v.targetBuilding = hut;
        v.thought = moodThought(v, 'Resting');
        v._nextPathTick = tick + 12;
        return true;
      }
    }
    return false;
  }

  function tryHydrateAtWell(v) {
    const tick = getTick();
    if (tick < v._nextPathTick) return false;
    if (v.nextHydrateTick > tick) return false;
    if (v.hydration > HYDRATION_VISIT_THRESHOLD) return false;
    const well = findNearestBuilding(v.x | 0, v.y | 0, 'well');
    if (!well) return false;
    const entry = findEntryTileNear(well, v.x | 0, v.y | 0) || { x: Math.round(buildingCenter(well).x), y: Math.round(buildingCenter(well).y) };
    const p = pathfind(v.x | 0, v.y | 0, entry.x, entry.y);
    if (p) {
      v.path = p;
      v.state = 'hydrate';
      v.targetBuilding = well;
      v.thought = moodThought(v, 'Fetching water');
      v._nextPathTick = tick + 12;
      v.nextHydrateTick = tick + Math.floor(DAY_LENGTH * 0.12);
      return true;
    }
    v.nextHydrateTick = Math.max(v.nextHydrateTick || 0, tick + 60);
    return false;
  }

  function tryCampfireSocial(v, { ambientNow = ambientAt(getDayTime()), forceNight = false } = {}) {
    const tick = getTick();
    if (tick < v._nextPathTick) return false;
    if (v.nextSocialTick > tick) return false;
    if ((v.starveStage || 0) >= 1) return false;
    const nightAmbient = isNightAmbient(ambientNow);
    if (!nightAmbient && !forceNight) return false;
    if (!nightAmbient && forceNight && !isNightTime()) return false;
    if (isDawnAmbient(ambientNow)) return false;
    const camp = findNearestBuilding(v.x | 0, v.y | 0, 'campfire');
    if (!camp) return false;
    const entry = findEntryTileNear(camp, v.x | 0, v.y | 0) || { x: Math.round(buildingCenter(camp).x), y: Math.round(buildingCenter(camp).y) };
    const p = pathfind(v.x | 0, v.y | 0, entry.x, entry.y);
    if (p) {
      v.path = p;
      v.state = 'socialize';
      v.targetBuilding = camp;
      v.thought = moodThought(v, 'Gathering by fire');
      v._nextPathTick = tick + 12;
      v.nextSocialTick = tick + Math.floor(SOCIAL_COOLDOWN_TICKS * 0.25);
      return true;
    }
    v.nextSocialTick = Math.max(v.nextSocialTick || 0, tick + 90);
    return false;
  }

  function tryStorageIdle(v) {
    const tick = getTick();
    if (tick < v._nextPathTick) return false;
    if (v.nextStorageIdleTick > tick) return false;
    if (v.inv) return false;
    if (v.targetJob) return false;
    const storage = findNearestBuilding(v.x | 0, v.y | 0, 'storage');
    if (!storage) return false;
    const entry = findEntryTileNear(storage, v.x | 0, v.y | 0) || { x: Math.round(buildingCenter(storage).x), y: Math.round(buildingCenter(storage).y) };
    const p = pathfind(v.x | 0, v.y | 0, entry.x, entry.y);
    if (p) {
      v.path = p;
      v.state = 'storage_idle';
      v.targetBuilding = storage;
      v.thought = moodThought(v, 'Checking storage');
      v._nextPathTick = tick + 12;
      v.nextStorageIdleTick = tick + Math.floor(STORAGE_IDLE_COOLDOWN * 0.4);
      return true;
    }
    v.nextStorageIdleTick = Math.max(v.nextStorageIdleTick || 0, tick + 80);
    return false;
  }

  function tryEquipBow(v) {
    const tick = getTick();
    if (v.lifeStage === 'child') return false;
    if (v.equippedBow) return false;
    if (v.inv) return false;
    if (v.state !== 'idle') return false;
    if (tick < v._nextPathTick) return false;
    // Reserve on intent so two villagers can't race for the same bow (audit #12).
    if (!reserveMaterials({ bow: 1 })) return false;
    const storage = findNearestBuilding(v.x | 0, v.y | 0, 'storage');
    if (!storage) { releaseReservedMaterials({ bow: 1 }); return false; }
    const entry = findEntryTileNear(storage, v.x | 0, v.y | 0) || { x: Math.round(buildingCenter(storage).x), y: Math.round(buildingCenter(storage).y) };
    const p = pathfind(v.x | 0, v.y | 0, entry.x, entry.y);
    if (!p) { releaseReservedMaterials({ bow: 1 }); return false; }
    v.path = p;
    v.state = 'equip_bow';
    v.targetBuilding = storage;
    v.reservedPickup = { type: ITEM.BOW, qty: 1 };
    v.thought = moodThought(v, 'Fetching bow');
    v._nextPathTick = tick + 12;
    return true;
  }

  function scoreExistingJobForVillager(j, v, blackboard) {
    const world = getWorld();
    if (!j) return -Infinity;
    let supplyStatus = null;
    let buildTarget = null;
    if (j.type === 'build') {
      buildTarget = buildings.find(bb => bb.id === j.bid);
      if (!buildTarget || buildTarget.built >= 1) return -Infinity;
      supplyStatus = buildingSupplyStatus(buildTarget);
      if (!supplyStatus.fullyDelivered) return -Infinity;
    }
    const i = idx(j.x, j.y);
    if (j.type === 'chop' && world.trees[i] === 0) return -Infinity;
    if (j.type === 'mine' && world.rocks[i] === 0) return -Infinity;
    if (j.type === 'sow' && world.growth[i] > 0) return -Infinity;
    if (j.type === 'forage' && world.berries[j.targetI ?? i] <= 0) return -Infinity;
    let distance;
    if (j.type === 'build') {
      distance = buildTarget ? distanceToFootprint(v.x | 0, v.y | 0, buildTarget) : Math.abs((v.x | 0) - j.x) + Math.abs((v.y | 0) - j.y);
    } else if (j.type === 'hunt') {
      // Must mirror pickJobFor's live-animal lookup — j.x/j.y is the hunt's
      // spawn point, not where the animal is now. Without this,
      // maybeInterruptJob compares stale-distance current vs fresh-distance
      // candidate and drops live pursuits.
      const targetAnimal = findAnimalById(j.targetAid);
      const targetX = targetAnimal?.x ?? j.x;
      const targetY = targetAnimal?.y ?? j.y;
      distance = Math.abs((v.x | 0) - Math.round(targetX)) + Math.abs((v.y | 0) - Math.round(targetY));
    } else {
      distance = Math.abs((v.x | 0) - j.x) + Math.abs((v.y | 0) - j.y);
    }
    const jobView = {
      type: j.type,
      prio: j.prio,
      distance,
      supply: supplyStatus,
    };
    return scoreJob(jobView, v, policy, blackboard);
  }

  function maybeInterruptJob(v, { blackboard = null, margin = 0 } = {}) {
    const currentJob = v.targetJob;
    if (!currentJob) return false;
    const bb = blackboard || state.bb;
    const famineEmergency = bb?.famine === true && currentJob.type !== 'harvest' && currentJob.type !== 'sow' && currentJob.type !== 'forage';
    const jobStyle = policy?.style?.jobScoring || {};
    const reprioritizeMargin = Number.isFinite(margin) ? margin : (Number.isFinite(jobStyle.reprioritizeMargin) ? jobStyle.reprioritizeMargin : 0);
    if (!famineEmergency && reprioritizeMargin <= 0) return false;

    const wasAssigned = currentJob.assigned || 0;
    if (wasAssigned > 0) { currentJob.assigned = Math.max(0, wasAssigned - 1); }
    const candidate = pickJobFor(v);
    if (wasAssigned > 0) { currentJob.assigned = wasAssigned; }
    if (!candidate || candidate === currentJob) return false;

    const currentScore = scoreExistingJobForVillager(currentJob, v, bb);
    const candidateScore = scoreExistingJobForVillager(candidate, v, bb);
    if (candidateScore > currentScore + reprioritizeMargin || famineEmergency) {
      finishJob(v);
      if (v.path) v.path.length = 0;
      v.state = 'idle';
      return true;
    }
    return false;
  }

  function findPanicHarvestJob(v) {
    const world = getWorld();
    const bb = state.bb;
    let best = null, bestScore = -Infinity;
    for (const j of jobs) {
      if (!j || j.type !== 'harvest') continue;
      if (j.assigned >= 1) continue;
      const i = idx(j.x, j.y);
      if (world.growth[i] <= 0) continue;
      const distance = Math.abs((v.x | 0) - j.x) + Math.abs((v.y | 0) - j.y);
      const jobView = { type: j.type, prio: j.prio, distance };
      const jobScore = scoreJob(jobView, v, policy, bb);
      if (jobScore > bestScore) { bestScore = jobScore; best = j; }
    }
    return best;
  }

  function pickJobFor(v) {
    const world = getWorld();
    if (v.lifeStage === 'child') return null;
    let best = null, bs = -Infinity;
    const blackboard = state.bb;
    const minScore = typeof policy?.style?.jobScoring?.minPickScore === 'number'
      ? policy.style.jobScoring.minPickScore
      : 0;
    for (const j of jobs) {
      let supplyStatus = null;
      let buildTarget = null;
      if (j.type === 'hunt' && !v.equippedBow) continue;
      // Phase 7: build jobs decrement `assigned` when the first builder
      // arrives at the site (see onArrive.js build branch), so this skip
      // gates "in-flight to job" rather than "construction in progress" —
      // a second villager can join an already-staffed build site.
      if (j.assigned >= 1) continue;
      if (j.type === 'build') {
        buildTarget = buildings.find(bb => bb.id === j.bid);
        if (!buildTarget || buildTarget.built >= 1) continue;
        supplyStatus = buildingSupplyStatus(buildTarget);
        // Defensive: planner only emits build jobs when fullyDelivered, but
        // a save/load race or stale job could leave one behind.
        if (!supplyStatus.fullyDelivered) continue;
      }
      const i = idx(j.x, j.y);
      if (j.type === 'chop' && world.trees[i] === 0) continue;
      if (j.type === 'mine' && world.rocks[i] === 0) continue;
      if (j.type === 'sow' && world.growth[i] > 0) continue;
      if (j.type === 'forage' && world.berries[j.targetI ?? i] <= 0) continue;
      let distance;
      if (j.type === 'build') {
        distance = buildTarget ? distanceToFootprint(v.x | 0, v.y | 0, buildTarget) : Math.abs((v.x | 0) - j.x) + Math.abs((v.y | 0) - j.y);
      } else if (j.type === 'hunt') {
        const targetAnimal = findAnimalById(j.targetAid);
        const targetX = targetAnimal?.x ?? j.x;
        const targetY = targetAnimal?.y ?? j.y;
        distance = Math.abs((v.x | 0) - Math.round(targetX)) + Math.abs((v.y | 0) - Math.round(targetY));
      } else {
        distance = Math.abs((v.x | 0) - j.x) + Math.abs((v.y | 0) - j.y);
      }
      const jobView = {
        type: j.type,
        prio: j.prio,
        distance,
        supply: supplyStatus,
      };
      const jobScore = scoreJob(jobView, v, policy, blackboard);
      if (jobScore > bs) { bs = jobScore; best = j; }
    }
    return bs > minScore ? best : null;
  }

  // Phase 11 (S11): consolidated pre-job idle decision tree. Returns true
  // when the villager was put on a path; caller should `return` to end the
  // tick. Branches are evaluated in priority order:
  //   1. Bow equip — only when fully idle and no food pressure.
  //   2. Energy-driven rest — fires REGARDLESS of v.state or v.targetJob, so
  //      a fatigued villager mid-task is sent home (audit B1).
  //   3. Night-anchored sleep — pulls idle villagers to bed at night (S1).
  //   4. Hydrate at well — preempts available work; only blocked by urgentFood.
  //   5. Night campfire social — forced night branch.
  function chooseIdleBeforeJobs(v, ctx) {
    const { urgentFood, needsFood, nightNow, deepNight, ambientNow, effectiveRest } = ctx;
    if (v.state === 'idle' && !urgentFood && !needsFood && !v.targetJob) {
      if (tryEquipBow(v)) return true;
    }
    // audit B1: single source of truth for the rest decision; intentionally
    // not gated on v.state === 'idle' so mid-task fatigue still routes home.
    if (v.energy < effectiveRest) {
      if (goRest(v)) return true;
    }
    if (v.state === 'idle' && !v.targetJob
        && wantsToSleep(v, { nightNow, deepNight, urgentFood })) {
      v._fellAsleepAtNight = nightNow;
      if (goRest(v)) return true;
    }
    if (v.state === 'idle' && !urgentFood) {
      if (tryHydrateAtWell(v)) return true;
    }
    if (nightNow && v.state === 'idle' && !needsFood && !urgentFood && !v.targetJob) {
      if (tryCampfireSocial(v, { ambientNow, forceNight: true })) return true;
    }
    return false;
  }

  // Phase 11 (S11): consolidated post-job idle decision tree. Always returns
  // true (the final handleIdleRoam fallback always acts). Branches:
  //   1. Storage idle — only when no job was picked and the queue is empty.
  //   2. Daytime campfire social.
  //   3. Roam fallback (rally point / wander toward food / random walk).
  function chooseIdleAfterJobs(v, ctx) {
    const { urgentFood, needsFood, ambientNow, jobs, hasPickedJob, stage } = ctx;
    if (!hasPickedJob && v.state === 'idle' && !urgentFood && !v.targetJob && jobs.length === 0) {
      if (tryStorageIdle(v)) return true;
    }
    if (v.state === 'idle' && !needsFood && !urgentFood && !v.targetJob) {
      if (tryCampfireSocial(v, { ambientNow })) return true;
    }
    return handleIdleRoam(v, { stage, needsFood, urgentFood });
  }

  return {
    findNearestBuilding,
    nearbyWarmth,
    issueStarveToast,
    enterSickState,
    handleVillagerFed,
    consumeFood,
    nearestFoodTarget,
    seekEmergencyFood,
    getRallyPoint,
    countNearbyVillagers,
    collectFoodHubs,
    pickWeightedRandom,
    selectReachableWanderTarget,
    handleIdleRoam,
    foragingJob,
    goRest,
    tryHydrateAtWell,
    tryCampfireSocial,
    tryStorageIdle,
    tryEquipBow,
    chooseIdleBeforeJobs,
    chooseIdleAfterJobs,
    scoreExistingJobForVillager,
    maybeInterruptJob,
    findPanicHarvestJob,
    pickJobFor,
  };
}
