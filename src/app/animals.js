import {
  ANIMAL_BEHAVIORS,
  ANIMAL_TYPES,
  GRID_H,
  GRID_SIZE,
  GRID_W,
  HUNT_RANGE,
  TILES,
  WALKABLE,
  tileToPxX,
  tileToPxY,
} from './constants.js';
import { cam } from './canvas.js';
import { R, clamp, irnd, uid } from './rng.js';
import { moodThought } from './simulation.js';

const DEFAULT_ANIMAL_BEHAVIOR = {
  roamRadius: 2,
  idleTicks: [20, 60],
  roamTicks: [40, 90],
  speed: 0.12,
  fleeSpeed: 0.16,
  grazeChance: 0.1,
  grazeRadius: 1,
  fearRadius: 3,
  fleeDistance: 3,
  observeMood: 0.003,
  idleBob: 1,
};

export function createAnimalsSystem(opts) {
  const {
    state,
    pathfindToRegion,
    tileOccupiedByBuilding,
    idx,
  } = opts;

  const animals = state.units.animals;
  const villagers = state.units.villagers;
  const villagerLabels = state.queue.villagerLabels;

  function getWorld() { return state.world; }
  function getTick() { return state.time.tick; }

  function desiredAnimalsForType(type) {
    const def = ANIMAL_TYPES[type];
    if (!def) return 0;
    const density = typeof def.density === 'number' ? def.density : 0;
    const baseCount = Math.round(GRID_SIZE * density);
    const minCount = def.minCount || 0;
    return Math.max(minCount, baseCount);
  }

  function isAnimalTileAllowed(tile, def, allowFallback) {
    const preferred = Array.isArray(def?.preferred) ? def.preferred : [];
    const fallback = Array.isArray(def?.fallback) ? def.fallback : preferred;
    const allowedSet = allowFallback ? (fallback.length ? fallback : preferred) : preferred;
    if (allowedSet.length === 0) {
      return WALKABLE.has(tile);
    }
    return allowedSet.includes(tile);
  }

  function spawnAnimalsForWorld() {
    const world = getWorld();
    animals.length = 0;
    const occupied = new Set();

    const tileFree = (x, y) => {
      if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) return false;
      const i = y * GRID_W + x;
      if (occupied.has(i)) return false;
      if (tileOccupiedByBuilding(x, y)) return false;
      const tile = world.tiles[i];
      if (tile === TILES.WATER) return false;
      if (world.trees[i] > 0 || world.rocks[i] > 0) return false;
      return WALKABLE.has(tile);
    };

    for (const [type, def] of Object.entries(ANIMAL_TYPES)) {
      const target = desiredAnimalsForType(type);
      if (target <= 0) continue;
      let placed = 0;
      let attempts = 0;
      const maxAttempts = Math.max(target * 180, target * 24);
      while (placed < target && attempts < maxAttempts) {
        attempts++;
        const x = irnd(0, GRID_W - 1);
        const y = irnd(0, GRID_H - 1);
        if (!tileFree(x, y)) continue;
        const i = y * GRID_W + x;
        const tile = world.tiles[i];
        const allowFallback = attempts > target * 60;
        if (!isAnimalTileAllowed(tile, def, allowFallback)) continue;
        animals.push({ id: uid(), type, x, y, dir: R() < 0.5 ? 'left' : 'right' });
        occupied.add(i);
        placed++;
      }
    }
  }

  function behaviorForAnimal(a) {
    return ANIMAL_BEHAVIORS[a.type] || DEFAULT_ANIMAL_BEHAVIOR;
  }

  function ensureAnimalDefaults(a) {
    const tick = getTick();
    if (!a.state) a.state = 'idle';
    if (!Number.isFinite(a.nextActionTick)) a.nextActionTick = tick + irnd(12, 48);
    if (!Number.isFinite(a.idlePhase)) a.idlePhase = irnd(0, 900);
    if (!Number.isFinite(a.nextVillageTick)) a.nextVillageTick = 0;
    if (!Number.isFinite(a.nextGrazeTick)) a.nextGrazeTick = 0;
    if (!Number.isFinite(a.fleeTicks)) a.fleeTicks = 0;
  }

  function animalTileBlocked(x, y, occupancy, id) {
    const world = getWorld();
    const tx = x | 0, ty = y | 0;
    if (tx < 0 || ty < 0 || tx >= GRID_W || ty >= GRID_H) return true;
    const i = ty * GRID_W + tx;
    if (world.tiles[i] === TILES.WATER) return true;
    if (world.trees[i] > 0 || world.rocks[i] > 0) return true;
    if (tileOccupiedByBuilding(tx, ty)) return true;
    if (occupancy) {
      const key = ty * GRID_W + tx;
      const other = occupancy.get(key);
      if (other && other !== id) return true;
    }
    return false;
  }

  function queueAnimalLabel(text, color, x, y) {
    if (!text) return;
    const fontSize = Math.max(6, 6 * cam.z);
    const boxH = fontSize + 4 * cam.z;
    villagerLabels.push({
      text,
      color,
      cx: tileToPxX(x, cam),
      cy: tileToPxY(y, cam) - 6 * cam.z,
      fontSize,
      boxH,
      camZ: cam.z,
    });
  }

  function nearestVillagerWithin(x, y, radius) {
    let best = null, bd = radius + 0.001;
    for (const v of villagers) {
      const d = Math.hypot((v.x | 0) - x, (v.y | 0) - y);
      if (d <= bd) { bd = d; best = v; }
    }
    return best;
  }

  function pickRoamTarget(a, behavior, occupancy) {
    const world = getWorld();
    const tries = 14;
    for (let t = 0; t < tries; t++) {
      const dx = irnd(-behavior.roamRadius, behavior.roamRadius);
      const dy = irnd(-behavior.roamRadius, behavior.roamRadius);
      const tx = clamp((a.x | 0) + dx, 0, GRID_W - 1);
      const ty = clamp((a.y | 0) + dy, 0, GRID_H - 1);
      const i = ty * GRID_W + tx;
      const def = ANIMAL_TYPES[a.type];
      if (!isAnimalTileAllowed(world.tiles[i], def, true)) continue;
      if (animalTileBlocked(tx, ty, occupancy, a.id)) continue;
      return { x: tx + 0.02 * R(), y: ty + 0.02 * R() };
    }
    return null;
  }

  function attemptGraze(animal, behavior) {
    const tick = getTick();
    const world = getWorld();
    if (animal.nextGrazeTick > tick) return false;
    if (R() > behavior.grazeChance) return false;
    const radius = Math.max(1, behavior.grazeRadius || 1);
    const ax = animal.x | 0, ay = animal.y | 0;
    let target = null;
    for (let y = ay - radius; y <= ay + radius; y++) {
      for (let x = ax - radius; x <= ax + radius; x++) {
        const i = idx(x, y);
        if (i < 0) continue;
        if (world.berries[i] > 0) { target = { x, y, i }; break; }
      }
      if (target) break;
    }
    if (!target) return false;
    world.berries[target.i] = Math.max(0, world.berries[target.i] - 1);
    animal.nextGrazeTick = tick + Math.round(60 + R() * 120);
    queueAnimalLabel('Grazing', '#cde6b7', target.x + 0.1, target.y - 0.15);
    return true;
  }

  function chooseFleeTarget(animal, from, behavior, occupancy) {
    const fx = from?.x ?? animal.x;
    const fy = from?.y ?? animal.y;
    const dirX = animal.x - fx;
    const dirY = animal.y - fy;
    const mag = Math.hypot(dirX, dirY) || 1;
    const dist = Math.max(behavior.fleeDistance || 3, 1.5);
    const targetX = clamp(Math.round(animal.x + (dirX / mag) * dist), 0, GRID_W - 1);
    const targetY = clamp(Math.round(animal.y + (dirY / mag) * dist), 0, GRID_H - 1);
    if (!animalTileBlocked(targetX, targetY, occupancy, animal.id)) {
      return { x: targetX + 0.12 * R(), y: targetY + 0.12 * R() };
    }
    return pickRoamTarget(animal, behavior, occupancy);
  }

  function findAnimalById(id) {
    if (!id) return null;
    for (const a of animals) {
      if (a && a.id === id) { return a; }
    }
    return null;
  }

  function removeAnimal(animal) {
    if (!animal) return false;
    const i = animals.indexOf(animal);
    if (i !== -1) { animals.splice(i, 1); return true; }
    return false;
  }

  function resolveHuntYield({ animal: _animal, lodge }) {
    const effects = lodge?.effects || {};
    const gameBonus = Number.isFinite(effects.gameYieldBonus) ? effects.gameYieldBonus : 0;
    const hideBonus = Number.isFinite(effects.hideYieldBonus) ? effects.hideYieldBonus : 0;
    const baseMeat = 1 + (R() < 0.42 ? 1 : 0);
    const meat = Math.max(1, Math.round(baseMeat * (1 + gameBonus)));
    const hideChance = 0.35 + hideBonus * 0.5;
    return { meat, pelts: R() < hideChance ? 1 : 0 };
  }

  // Phase 12 (B23): a single A*-to-region search instead of one pathfind per
  // candidate tile in the 9×9 box around the animal. The predicate accepts
  // the first walkable, in-range, unobstructed tile reached from the
  // villager; the heuristic — Manhattan distance to the animal minus the
  // hunt range, floored at 0 — is admissible because reaching any in-range
  // tile takes at least that many steps from the current node.
  function findHuntApproachPath(v, animal, { range = HUNT_RANGE, maxPath = 2000 } = {}) {
    if (!v || !animal) return null;
    if (typeof pathfindToRegion !== 'function') return null;
    const world = getWorld();
    const ax = animal.x;
    const ay = animal.y;
    const rangeSq = range * range;
    const axR = Math.round(ax);
    const ayR = Math.round(ay);
    const isTarget = (tx, ty) => {
      if (tx < 0 || ty < 0 || tx >= GRID_W || ty >= GRID_H) return false;
      const dxr = tx - ax, dyr = ty - ay;
      if (dxr * dxr + dyr * dyr > rangeSq) return false;
      if (tileOccupiedByBuilding(tx, ty)) return false;
      const tile = world.tiles[idx(tx, ty)];
      if (tile === TILES.WATER) return false;
      return WALKABLE.has(tile);
    };
    const heuristic = (x, y) => {
      const d = Math.abs(x - axR) + Math.abs(y - ayR) - range;
      return d > 0 ? d : 0;
    };
    return pathfindToRegion(v.x | 0, v.y | 0, isTarget, maxPath, heuristic);
  }

  // Audit Phase 6: ambient food creation removed. Hungry-villager proximity no
  // longer drops meat or kills the animal — formal hunting (planner hunt jobs +
  // onArrive `hunt` arrival) is the only meat producer. This function survives
  // as a non-food, mood-only wildlife observation interaction.
  function interactWithVillage(animal, behavior, _occupancy) {
    const tick = getTick();
    if (animal.nextVillageTick > tick) return;
    const radius = Math.max(2, behavior.fearRadius || 3);
    const villager = nearestVillagerWithin(animal.x, animal.y, radius);
    if (!villager) return;
    if (R() < 0.16) {
      villager.happy = clamp(villager.happy + (behavior.observeMood || 0.003), 0, 1);
      villager.thought = moodThought(villager, 'Watching wildlife');
      queueAnimalLabel('👀', '#d8e7ff', animal.x + 0.05, animal.y - 0.2);
      animal.nextVillageTick = tick + Math.round(90 + R() * 120);
    }
  }

  function stepAnimal(animal, behavior, occupancy) {
    const tick = getTick();
    const oldKey = (animal.y | 0) * GRID_W + (animal.x | 0);
    let speed = behavior.speed || 0.12;
    if (animal.state === 'flee') speed = behavior.fleeSpeed || speed * 1.3;
    const target = animal.target;
    if (!target) { return; }
    const dx = target.x - animal.x;
    const dy = target.y - animal.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.001) { animal.state = 'idle'; animal.target = null; return; }
    const step = Math.min(dist, speed);
    const nx = animal.x + (dx / dist) * step;
    const ny = animal.y + (dy / dist) * step;
    const blocked = animalTileBlocked(nx, ny, occupancy, animal.id);
    if (blocked) {
      animal.state = 'idle';
      animal.target = null;
      animal.nextActionTick = tick + irnd(10, 40);
      return;
    }
    const newKey = (ny | 0) * GRID_W + (nx | 0);
    if (newKey !== oldKey) {
      const occupant = occupancy.get(newKey);
      if (occupant && occupant !== animal.id) {
        animal.state = 'idle';
        animal.target = null;
        animal.nextActionTick = tick + irnd(8, 24);
        return;
      }
      occupancy.delete(oldKey);
      occupancy.set(newKey, animal.id);
    }
    animal.x = nx;
    animal.y = ny;
    if (dx < 0) animal.dir = 'left';
    else if (dx > 0) animal.dir = 'right';
    if (dist <= step + 0.01) {
      animal.state = 'idle';
      animal.target = null;
      animal.nextActionTick = tick + irnd(behavior.idleTicks[0], behavior.idleTicks[1]);
    }
  }

  function animalTick(animal, occupancy) {
    const tick = getTick();
    ensureAnimalDefaults(animal);
    const behavior = behaviorForAnimal(animal);
    animal.bobOffset = Math.sin((tick + animal.idlePhase) * 0.16) * (behavior.idleBob || 1);
    const blocked = animalTileBlocked(animal.x, animal.y, occupancy, animal.id);
    if (blocked) {
      const target = pickRoamTarget(animal, behavior, occupancy);
      if (target) {
        animal.x = target.x;
        animal.y = target.y;
        const k = (animal.y | 0) * GRID_W + (animal.x | 0);
        occupancy.set(k, animal.id);
      }
    }

    if (animal.state === 'idle' && attemptGraze(animal, behavior)) {
      animal.nextActionTick = Math.max(animal.nextActionTick || tick, tick + behavior.idleTicks[0]);
    }
    interactWithVillage(animal, behavior, occupancy);

    if (animal.state === 'idle' && tick >= animal.nextActionTick) {
      const target = pickRoamTarget(animal, behavior, occupancy);
      if (target) {
        animal.state = 'roam';
        animal.target = target;
        animal.nextActionTick = tick + irnd(behavior.roamTicks[0], behavior.roamTicks[1]);
      } else {
        animal.nextActionTick = tick + irnd(behavior.idleTicks[0], behavior.idleTicks[1]);
      }
    }
    if (animal.state === 'flee') {
      animal.fleeTicks = Math.max(0, (animal.fleeTicks | 0) - 1);
      if (!animal.target) {
        animal.target = pickRoamTarget(animal, behavior, occupancy);
      }
      if (animal.fleeTicks <= 0 && animal.target) {
        animal.state = 'roam';
      }
    }
    if (animal.state === 'roam' || animal.state === 'flee') {
      if (!animal.target) { animal.state = 'idle'; return; }
      stepAnimal(animal, behavior, occupancy);
    } else if (animal.state === 'idle' && R() < 0.015) {
      animal.dir = animal.dir === 'left' ? 'right' : 'left';
    }
  }

  function updateAnimals() {
    if (animals.length === 0) return;
    const occupancy = new Map();
    for (const a of animals) {
      const key = (a.y | 0) * GRID_W + (a.x | 0);
      if (!occupancy.has(key)) occupancy.set(key, a.id);
    }
    for (const a of animals) {
      animalTick(a, occupancy);
    }
  }

  return {
    spawnAnimalsForWorld,
    behaviorForAnimal,
    ensureAnimalDefaults,
    animalTileBlocked,
    queueAnimalLabel,
    nearestVillagerWithin,
    pickRoamTarget,
    attemptGraze,
    chooseFleeTarget,
    findAnimalById,
    removeAnimal,
    resolveHuntYield,
    findHuntApproachPath,
    interactWithVillage,
    stepAnimal,
    animalTick,
    updateAnimals,
  };
}
