import {
  CRAFTING_RECIPES,
  GRID_H,
  GRID_W,
  ITEM,
  TILES,
  ZONES
} from './constants.js';
import {
  BUILDINGS,
  buildingCenter,
  buildingSupplyStatus,
  distanceToFootprint,
  ensureBuildingData,
  getFootprint,
  tileOccupiedByBuildingIn,
  validateFootprintPlacementIn
} from './world.js';
import { clamp } from './rng.js';
import { computeFamineSeverity } from '../ai/scoring.js';

export function createPlanner(opts) {
  const {
    state,
    policy,
    pathfind,
    addJob,
    hasSimilarJob,
    noteJobRemoved,
    requestBuildHauls,
    countBuildingsByKind,
    ensureBlackboardSnapshot,
    getJobCreationConfig,
    violatesSpacing,
    zoneCanEverWork,
    zoneHasWorkNow,
    updateZoneRow,
    markZoneOverlayDirty,
    markStaticDirty,
    availableToReserve,
    reserveMaterials,
    releaseReservedMaterials,
    addBuilding,
    Toast,
    toTile
  } = opts;

  const progressionMemory = new Map();
  const jobNeedState = { food: false, wood: false, stone: false, sow: false, harvest: false, bow: false };

  function tileOccupiedByBuilding(x, y, ignoreId = null) {
    return tileOccupiedByBuildingIn(state.units.buildings, x, y, ignoreId);
  }

  function validateFootprintPlacement(kind, tx, ty, opts2 = {}) {
    return validateFootprintPlacementIn(state.units.buildings, state.world, kind, tx, ty, opts2);
  }

  function countZoneTiles(zone) {
    const world = state.world;
    if (!world || !world.zone) return 0;
    let total = 0;
    for (let i = 0; i < world.zone.length; i++) {
      if (world.zone[i] === zone) total++;
    }
    return total;
  }

  function countNaturalResourceTiles(kind) {
    const world = state.world;
    if (!world) return 0;
    const source = kind === 'wood' ? world.trees : world.rocks;
    if (!source) return 0;
    let total = 0;
    for (let i = 0; i < source.length; i++) {
      if (source[i] > 0 && world.tiles[i] !== TILES.WATER) total++;
    }
    return total;
  }

  function outstandingResource(resource) {
    const buildings = state.units.buildings;
    let need = 0;
    for (const b of buildings) {
      if (!b || b.built >= 1) continue;
      const status = buildingSupplyStatus(b);
      const required = resource === 'wood' ? status.woodNeed : status.stoneNeed;
      const reserved = resource === 'wood' ? status.reservedWood : status.reservedStone;
      need += Math.max(0, required - reserved);
    }
    return need;
  }

  function resourcePressure(resource, buffer = 0) {
    const available = availableToReserve(resource);
    const outstanding = outstandingResource(resource);
    return Math.max(0, outstanding + buffer - available);
  }

  function zoneCentroid(zone) {
    const world = state.world;
    if (!world || !world.zone) return null;
    let sumX = 0, sumY = 0, count = 0;
    for (let i = 0; i < world.zone.length; i++) {
      if (world.zone[i] !== zone) continue;
      const x = i % GRID_W;
      const y = (i / GRID_W) | 0;
      sumX += x; sumY += y; count++;
    }
    if (count === 0) return null;
    return { x: sumX / count, y: sumY / count };
  }

  function findPrimaryAnchor() {
    const buildings = state.units.buildings;
    const camp = buildings.find(b => b.kind === 'campfire');
    if (camp) return buildingCenter(camp);
    const storage = findNearestStorage(GRID_W / 2, GRID_H / 2);
    if (storage) return buildingCenter(storage);
    return { x: GRID_W * 0.5, y: GRID_H * 0.5 };
  }

  function findNearestStorage(x, y) {
    const buildings = state.units.buildings;
    let best = null, bd = Infinity;
    for (const b of buildings) {
      if (!b || b.kind !== 'storage' || b.built < 1) continue;
      const d = distanceToFootprint(x, y, b);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  function findPlacementNear(kind, anchorX, anchorY, maxRadius = 18, context = {}) {
    const world = state.world;
    const animals = state.units.animals;
    const fp = getFootprint(kind);
    let best = null, bestScore = -Infinity;
    const anchorTx = Math.round(anchorX);
    const anchorTy = Math.round(anchorY);
    let reachableFound = false;

    const wildlifeDensity = (x, y, radius = 6) => {
      if (!Array.isArray(animals) || animals.length === 0) return 0;
      let score = 0;
      for (const a of animals) {
        if (!a || a.state === 'dead') continue;
        const dist = Math.abs(a.x - x) + Math.abs(a.y - y);
        if (dist > radius) continue;
        score += Math.max(0, radius - dist + 1);
      }
      return score;
    };

    const nearbyZoneScore = (zone, x, y, radius = 3) => {
      if (!world?.zone) return 0;
      let count = 0;
      for (let yy = y - radius; yy <= y + radius; yy++) {
        for (let xx = x - radius; xx <= x + radius; xx++) {
          if (xx < 0 || yy < 0 || xx >= GRID_W || yy >= GRID_H) continue;
          const i = yy * GRID_W + xx;
          if (world.zone[i] === zone) count++;
        }
      }
      return count;
    };

    const resourceDensity = (resource, x, y, radius = 2) => {
      if (!world) return 0;
      const source = resource === 'wood' ? world.trees : world.rocks;
      if (!source) return 0;
      let score = 0;
      for (let yy = y - radius; yy <= y + radius; yy++) {
        for (let xx = x - radius; xx <= x + radius; xx++) {
          if (xx < 0 || yy < 0 || xx >= GRID_W || yy >= GRID_H) continue;
          const i = yy * GRID_W + xx;
          score += Math.max(0, source[i] || 0);
        }
      }
      return score;
    };

    const fertileScore = (x, y, radius = 1) => {
      if (!world?.tiles) return 0;
      let score = 0;
      for (let yy = y - radius; yy <= y + radius; yy++) {
        for (let xx = x - radius; xx <= x + radius; xx++) {
          if (xx < 0 || yy < 0 || xx >= GRID_W || yy >= GRID_H) continue;
          const tile = world.tiles[yy * GRID_W + xx];
          if (tile === TILES.FERTILE || tile === TILES.MEADOW) score += 2;
          else if (tile === TILES.GRASS) score += 1;
        }
      }
      return score;
    };

    for (let r = 0; r <= maxRadius; r++) {
      const minX = Math.max(0, Math.floor(anchorX - r));
      const maxX = Math.min(GRID_W - fp.w, Math.floor(anchorX + r));
      const minY = Math.max(0, Math.floor(anchorY - r));
      const maxY = Math.min(GRID_H - fp.h, Math.floor(anchorY + r));
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          if (validateFootprintPlacement(kind, x, y) !== null) continue;
          const cx = x + (fp.w - 1) / 2;
          const cy = y + (fp.h - 1) / 2;
          const baseDist = Math.abs(cx - anchorX) + Math.abs(cy - anchorY);
          let score = -baseDist;

          if (kind === 'hut') {
            score += nearbyZoneScore(ZONES.FARM, cx, cy, 4) * -0.3;
            score += nearbyZoneScore(ZONES.CUT, cx, cy, 3) * -0.1;
          }
          if (kind === 'farmplot') {
            score += nearbyZoneScore(ZONES.FARM, cx, cy, 3) * 1.8;
            score += fertileScore(cx, cy, 2) * 0.6;
          }
          if (kind === 'well') {
            score += nearbyZoneScore(ZONES.FARM, cx, cy, 4) * 2.2;
            score += fertileScore(cx, cy, 1) * 0.2;
          }
          if (kind === 'storage') {
            score += nearbyZoneScore(ZONES.CUT, cx, cy, 4) * 1.1;
            score += nearbyZoneScore(ZONES.MINE, cx, cy, 4) * 1.1;
            score += resourceDensity('wood', cx, cy, 2) * 0.05;
            score += resourceDensity('stone', cx, cy, 2) * 0.06;
          }
          if (kind === 'hunterLodge') {
            score += wildlifeDensity(cx, cy, 6) * 0.45;
            score += resourceDensity('wood', cx, cy, 2) * 0.08;
            score += nearbyZoneScore(ZONES.FARM, cx, cy, 4) * -0.2;
          }

          if (score > bestScore - 4) {
            const path = pathfind(anchorTx, anchorTy, Math.round(cx), Math.round(cy), Math.max(140, maxRadius * 8));
            if (!path) continue;
            reachableFound = true;
            const pathCost = path.length || baseDist * 2;
            score -= pathCost * 0.35;
          } else {
            continue;
          }

          if (score > bestScore) {
            bestScore = score;
            best = { x, y };
          }
        }
      }
    }
    if (!reachableFound && maxRadius < Math.max(GRID_W, GRID_H)) {
      const nextRadius = Math.min(Math.max(GRID_W, GRID_H), maxRadius + 8);
      if (nextRadius > maxRadius) {
        return findPlacementNear(kind, anchorX, anchorY, nextRadius, { ...context, expanded: true });
      }
    }
    return reachableFound ? best : null;
  }

  function ensureZoneCoverage(zone, targetTiles, anchor, radius = 0) {
    const world = state.world;
    if (!anchor) anchor = findPrimaryAnchor();
    let current = countZoneTiles(zone);
    if (current >= targetTiles) return false;
    const baseSearchRadius = Math.max(6, Math.ceil(targetTiles * 0.6));
    const anchorX = Math.round(anchor.x);
    const anchorY = Math.round(anchor.y);
    const fertilityNeighborhood = (x, y, radius2) => {
      let fertile = 0;
      for (let yy = y - radius2; yy <= y + radius2; yy++) {
        for (let xx = x - radius2; xx <= x + radius2; xx++) {
          if (xx < 0 || yy < 0 || xx >= GRID_W || yy >= GRID_H) continue;
          const tile = world.tiles[yy * GRID_W + xx];
          if (tile === TILES.FERTILE || tile === TILES.MEADOW) fertile++;
        }
      }
      return fertile;
    };

    const woodDensity = (x, y, radius2) => {
      let total = 0;
      for (let yy = y - radius2; yy <= y + radius2; yy++) {
        for (let xx = x - radius2; xx <= x + radius2; xx++) {
          if (xx < 0 || yy < 0 || xx >= GRID_W || yy >= GRID_H) continue;
          total += Math.max(0, world.trees[yy * GRID_W + xx] || 0);
        }
      }
      return total;
    };

    const stoneDensity = (x, y, radius2) => {
      let total = 0;
      for (let yy = y - radius2; yy <= y + radius2; yy++) {
        for (let xx = x - radius2; xx <= x + radius2; xx++) {
          if (xx < 0 || yy < 0 || xx >= GRID_W || yy >= GRID_H) continue;
          total += Math.max(0, world.rocks[yy * GRID_W + xx] || 0);
        }
      }
      return total;
    };

    const cohesionScore = (x, y) => {
      let adj = 0;
      for (let yy = y - 1; yy <= y + 1; yy++) {
        for (let xx = x - 1; xx <= x + 1; xx++) {
          if (xx < 0 || yy < 0 || xx >= GRID_W || yy >= GRID_H || (xx === x && yy === y)) continue;
          if (world.zone[yy * GRID_W + xx] === zone) adj++;
        }
      }
      return adj;
    };

    const localResourceScore = (x, y) => {
      const i = y * GRID_W + x;
      if (zone === ZONES.FARM) {
        const tile = world.tiles[i];
        let s = (tile === TILES.FERTILE ? 5 : 0) + (tile === TILES.MEADOW ? 4 : 0) + (tile === TILES.GRASS ? 2 : 0);
        if (world.trees[i] > 0 || world.rocks[i] > 0) s -= 3;
        return s + fertilityNeighborhood(x, y, 2) * 0.4;
      }
      if (zone === ZONES.CUT) {
        return woodDensity(x, y, 2) * 0.45;
      }
      if (zone === ZONES.MINE) {
        return stoneDensity(x, y, 2) * 0.55;
      }
      return 0;
    };

    const attemptPlacement = (searchRadius) => {
      const candidates = [];
      const minX = Math.max(0, Math.floor(anchor.x - searchRadius));
      const maxX = Math.min(GRID_W - 1, Math.floor(anchor.x + searchRadius));
      const minY = Math.max(0, Math.floor(anchor.y - searchRadius));
      const maxY = Math.min(GRID_H - 1, Math.floor(anchor.y + searchRadius));
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const i = y * GRID_W + x;
          if (world.zone[i] === zone) continue;
          if (!zoneCanEverWork(zone, i)) continue;
          if (tileOccupiedByBuilding(x, y)) continue;
          const dist = Math.abs(x - anchor.x) + Math.abs(y - anchor.y);
          const score = localResourceScore(x, y) + cohesionScore(x, y) * 1.2 - dist * 0.35;
          candidates.push({ x, y, score });
        }
      }

      candidates.sort((a, b) => b.score - a.score);
      let reachableSeen = false;
      let changed = false;
      const pathable = [];
      const pathLimit = Math.max(120, searchRadius * 3);
      for (const c of candidates) {
        if (current >= targetTiles) break;
        if (c.score <= -Infinity) continue;
        const path = pathfind(anchorX, anchorY, c.x, c.y, pathLimit);
        if (!path) continue;
        reachableSeen = true;
        const pathCost = path.length || Math.abs(c.x - anchorX) + Math.abs(c.y - anchorY);
        const adjustedScore = c.score - pathCost * 0.2;
        if (adjustedScore <= -Infinity) continue;
        pathable.push({ ...c, adjustedScore });
      }

      pathable.sort((a, b) => b.adjustedScore - a.adjustedScore);
      for (const c of pathable) {
        if (current >= targetTiles) break;
        if (applyZoneBrush(c.x, c.y, zone, radius)) {
          changed = true;
          current = countZoneTiles(zone);
        }
      }
      return { changed, reachableSeen };
    };

    let changed = false;
    const firstPass = attemptPlacement(baseSearchRadius);
    changed = changed || firstPass.changed;
    const needMore = current < targetTiles;
    if (needMore && firstPass.reachableSeen) {
      const expandedRadius = Math.min(Math.max(GRID_W, GRID_H), baseSearchRadius + 8);
      if (expandedRadius > baseSearchRadius) {
        const secondPass = attemptPlacement(expandedRadius);
        changed = changed || secondPass.changed;
      }
    }
    return changed;
  }

  function applyZoneBrush(cx, cy, z, radius = 0) {
    const world = state.world;
    const x0 = toTile(cx), y0 = toTile(cy);
    if (x0 < 0 || y0 < 0 || x0 >= GRID_W || y0 >= GRID_H) return false;
    const r = Math.max(0, Math.floor(radius));
    const touchedRows = new Set();
    for (let y = y0 - r; y <= y0 + r; y++) {
      for (let x = x0 - r; x <= x0 + r; x++) {
        if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) continue;
        const i = y * GRID_W + x;
        if (z === ZONES.NONE) {
          if (world.zone[i] !== ZONES.NONE) {
            world.zone[i] = ZONES.NONE;
            touchedRows.add(y);
          }
          continue;
        }
        if (tileOccupiedByBuilding(x, y)) continue;
        if (zoneCanEverWork(z, i)) {
          if (world.zone[i] !== z) {
            world.zone[i] = z;
            touchedRows.add(y);
          }
        }
      }
    }
    touchedRows.forEach(updateZoneRow);
    if (touchedRows.size > 0) markZoneOverlayDirty();
    return touchedRows.size > 0;
  }

  function placeBlueprint(kind, x, y, opts2 = {}) {
    const world = state.world;
    const tx = toTile(x), ty = toTile(y);
    if (tx < 0 || ty < 0 || tx >= GRID_W || ty >= GRID_H) return;
    const result = validateFootprintPlacement(kind, tx, ty);
    if (result === 'bounds') return;
    if (result === 'water') { Toast.show('Cannot build on water.'); return; }
    if (result === 'rock') { Toast.show('Too rocky to build here.'); return; }
    if (result === 'blocked') { Toast.show('Clear trees and rocks first.'); return; }
    if (result === 'occupied') { Toast.show('Tile occupied.'); return; }
    const fp = getFootprint(kind);
    const touchedRows = new Set();
    for (let yy = 0; yy < fp.h; yy++) {
      for (let xx = 0; xx < fp.w; xx++) {
        const idx = (ty + yy) * GRID_W + (tx + xx);
        if (world.zone[idx] !== ZONES.NONE) {
          world.zone[idx] = ZONES.NONE;
          touchedRows.add(ty + yy);
        }
      }
    }
    touchedRows.forEach(updateZoneRow);
    if (touchedRows.size > 0) markZoneOverlayDirty();
    const b = addBuilding(kind, tx, ty, { built: 0 });
    requestBuildHauls(b);
    markStaticDirty();
    const def = BUILDINGS[kind];
    const label = def?.label || kind;
    if (opts2.silent !== true) {
      const reason = opts2.reason ? ` (${opts2.reason})` : '';
      Toast.show(`Villagers planned a ${label}${reason}.`);
    }
  }

  function getProgressionSettings() {
    const cfg = policy?.progression || {};
    const tiers = Array.isArray(cfg.tiers) ? cfg.tiers : [];
    const hysteresisTicks = Number.isFinite(cfg.hysteresisTicks) ? cfg.hysteresisTicks : 240;
    const resourceHysteresis = clamp(Number.isFinite(cfg.resourceHysteresis) ? cfg.resourceHysteresis : 0.18, 0, 0.9);
    const maxPlansPerTick = Math.max(1, Number.isFinite(cfg.maxPlansPerTick) ? cfg.maxPlansPerTick | 0 : 2);
    return { tiers, hysteresisTicks, resourceHysteresis, maxPlansPerTick };
  }

  function meetsProgressionRequirements(requirements, available, unlocked, hysteresis) {
    if (!requirements || typeof requirements !== 'object') return true;
    const slack = Math.max(0, unlocked ? 1 - hysteresis : 1);
    for (const [key, needRaw] of Object.entries(requirements)) {
      const need = Number(needRaw);
      if (!Number.isFinite(need) || need <= 0) continue;
      const threshold = Math.max(0, need * slack);
      if ((available[key] || 0) < threshold) return false;
    }
    return true;
  }

  function applyProgressionPlanner(buildQueue, bb, plannedTotals, anchor) {
    const villagers = state.units.villagers;
    const tick = state.time.tick;
    const cfg = getProgressionSettings();
    if (cfg.tiers.length === 0) return {};
    const defaultAnchor = anchor || findPrimaryAnchor() || { x: Math.round(GRID_W / 2), y: Math.round(GRID_H / 2) };
    const available = {
      food: bb?.availableFood ?? availableToReserve('food'),
      wood: bb?.availableWood ?? availableToReserve('wood'),
      stone: bb?.availableStone ?? availableToReserve('stone')
    };
    const additionalTargets = {};
    let injected = 0;

    for (const tier of cfg.tiers) {
      if (injected >= cfg.maxPlansPerTick) break;
      if (!tier || !tier.id) continue;
      const tierState = progressionMemory.get(tier.id) || { cooldownUntil: 0, unlocked: false };
      const minPop = Number.isFinite(tier.minPopulation) ? tier.minPopulation : (Number.isFinite(tier.minVillagers) ? tier.minVillagers : 0);
      if (minPop > 0 && (bb?.villagers || villagers.length) < minPop) {
        tierState.unlocked = false;
        progressionMemory.set(tier.id, tierState);
        continue;
      }
      const requirements = tier.requires || tier.requirements;
      const resourcesOk = meetsProgressionRequirements(requirements, available, tierState.unlocked, cfg.resourceHysteresis);
      if (!resourcesOk) {
        if (!meetsProgressionRequirements(requirements, available, false, cfg.resourceHysteresis * 0.5)) {
          tierState.unlocked = false;
        }
        progressionMemory.set(tier.id, tierState);
        continue;
      }
      if (tick < tierState.cooldownUntil) continue;

      const plans = Array.isArray(tier.plans) ? tier.plans : [];
      let addedForTier = 0;
      for (const plan of plans) {
        if (injected >= cfg.maxPlansPerTick) break;
        if (!plan || !plan.kind) continue;
        const counts = countBuildingsByKind(plan.kind);
        const target = Number.isFinite(plan.target) ? plan.target : Number.isFinite(plan.minTotal) ? plan.minTotal : Number.isFinite(tier.target) ? tier.target : 1;
        if (counts.total >= target) continue;
        const anchorOffset = plan.anchorOffset || tier.anchorOffset || null;
        const tierAnchor = plan.anchor || tier.anchor || defaultAnchor;
        const planAnchor = anchorOffset ? { x: (tierAnchor.x || 0) + (anchorOffset.x || 0), y: (tierAnchor.y || 0) + (anchorOffset.y || 0) } : tierAnchor;
        const priority = Number.isFinite(plan.priority) ? plan.priority : (Number.isFinite(tier.priority) ? tier.priority : 2);
        buildQueue.push({ priority, kind: plan.kind, anchor: planAnchor, reason: plan.reason || tier.reason || 'progress milestone', radius: plan.radius || tier.radius || 18, context: plan.context || tier.context });
        additionalTargets[plan.kind] = Math.max(additionalTargets[plan.kind] || 0, target);
        addedForTier++; injected++;
      }
      if (addedForTier > 0) {
        tierState.unlocked = true;
        tierState.cooldownUntil = tick + cfg.hysteresisTicks;
        progressionMemory.set(tier.id, tierState);
      }
    }

    for (const key of Object.keys(additionalTargets)) {
      if (!Number.isFinite(plannedTotals[key])) {
        plannedTotals[key] = plannedTotals[key] || 0;
      }
    }

    return additionalTargets;
  }

  function planZones(bb) {
    const world = state.world;
    const villagers = state.units.villagers;
    if (!world) return false;
    const anchor = findPrimaryAnchor();
    const villagerCount = Math.max(1, villagers.length || 0);
    const baseFarmTarget = Math.max(6, Math.ceil(villagerCount * 3));
    const famineSeverity = computeFamineSeverity(bb);
    const lowFood = (bb?.availableFood ?? Infinity) < villagerCount * 2;
    let farmTarget = baseFarmTarget;
    if (bb?.famine || lowFood) {
      const famineScale = 1.25 + famineSeverity * 0.75;
      const safetyFloor = Math.max(baseFarmTarget, Math.ceil(villagerCount * 3.5));
      farmTarget = Math.max(safetyFloor, Math.ceil(baseFarmTarget * famineScale));
    }
    const farmTiles = countZoneTiles(ZONES.FARM);
    const woodPressure = resourcePressure('wood', 6);
    const stonePressure = resourcePressure('stone', 3);
    let changed = false;

    if (bb?.famine || bb?.availableFood < villagerCount * 2 || farmTiles < farmTarget) {
      changed = ensureZoneCoverage(ZONES.FARM, farmTarget, zoneCentroid(ZONES.FARM) || anchor, 1) || changed;
    }

    const naturalTrees = countNaturalResourceTiles('wood');
    const cutTarget = woodPressure > 0 ? Math.min(naturalTrees, Math.max(8, Math.ceil(woodPressure * 2))) : 0;
    if (cutTarget > 0 && countZoneTiles(ZONES.CUT) < cutTarget) {
      changed = ensureZoneCoverage(ZONES.CUT, cutTarget, anchor, 0) || changed;
    }

    const naturalRocks = countNaturalResourceTiles('stone');
    const mineTarget = stonePressure > 0 ? Math.min(naturalRocks, Math.max(4, Math.ceil(stonePressure * 1.5))) : 0;
    if (mineTarget > 0 && countZoneTiles(ZONES.MINE) < mineTarget) {
      const rockAnchor = zoneCentroid(ZONES.MINE) || anchor;
      changed = ensureZoneCoverage(ZONES.MINE, mineTarget, rockAnchor, 0) || changed;
    }

    if (changed) {
      generateJobs();
    }
    return changed;
  }

  function planBuildings(bb) {
    const world = state.world;
    const villagers = state.units.villagers;
    const animals = state.units.animals;
    if (!world) return false;
    const anchor = findPrimaryAnchor();
    const villagerCount = Math.max(1, villagers.length || 0);
    let placed = false;

    const TUNING = {
      famineFarmMultiplier: 1.4,
      winterPrepBonus: 0.35,
      foodGapWeight: 0.2,
      hutFatigueGate: 0.35,
      storageWoodBuffer: 18,
      wellWoodBuffer: 10,
      maxPlacements: 3
    };

    const famine = !!bb?.famine;
    const availableFood = bb?.availableFood ?? Infinity;
    const availableWood = bb?.availableWood ?? availableToReserve('wood');
    const availableStone = bb?.availableStone ?? availableToReserve('stone');
    const season = bb?.season ?? 0;
    const seasonProgress = bb?.seasonProgress ?? 0;
    const approachingWinter = (season === 2 && seasonProgress > 0.55) || season === 3;
    const growthPush = !!bb?.growthPush;
    const energy = bb?.energy || {};
    const lowEnergy = !!energy.fatigue || (energy.avgEnergy ?? 1) < TUNING.hutFatigueGate;
    const foodGap = Math.max(0, villagerCount * 2 - availableFood);

    const hutCounts = countBuildingsByKind('hut');
    const farmTiles = countZoneTiles(ZONES.FARM);
    const farmplotCounts = countBuildingsByKind('farmplot');
    const wellCounts = countBuildingsByKind('well');
    const storageCounts = countBuildingsByKind('storage');
    const hunterCounts = countBuildingsByKind('hunterLodge');

    const plannedTotals = {
      hut: hutCounts.total,
      farmplot: farmplotCounts.total,
      well: wellCounts.total,
      storage: storageCounts.total,
      hunterLodge: hunterCounts.total
    };

    const hutTargetBase = Math.max(1, Math.ceil(villagerCount / 2));
    const hutTarget = lowEnergy ? Math.max(hutCounts.built, Math.ceil(hutTargetBase * 0.85)) : hutTargetBase;

    let desiredFarmplots = farmTiles > 0 ? Math.max(1, Math.floor(farmTiles / 8)) : 0;
    const farmUrgency = 1
      + (famine ? TUNING.famineFarmMultiplier - 1 : 0)
      + (foodGap > 0 ? Math.min(0.8, (foodGap / Math.max(1, villagerCount * 2)) * (1 + TUNING.foodGapWeight)) : 0)
      + (approachingWinter ? TUNING.winterPrepBonus : 0)
      + (growthPush ? 0.25 : 0);
    if (farmTiles > 0) {
      desiredFarmplots = Math.max(desiredFarmplots, Math.round(Math.max(1, farmTiles / 8) * farmUrgency));
    } else if (famine) {
      desiredFarmplots = Math.max(desiredFarmplots, Math.round(farmUrgency));
    }

    let wellTarget = farmTiles >= 8 ? 1 : 0;
    if (approachingWinter && farmTiles >= 6) wellTarget = 1;
    if (famine && !approachingWinter && farmTiles < 16) wellTarget = 0;

    const wildlifeInfo = (() => {
      if (!Array.isArray(animals) || animals.length === 0) return { hotspot: null, nearby: 0 };
      let best = null;
      const searchRadius = 26;
      const clusterRadius = 6;
      for (const a of animals) {
        if (!a || a.state === 'dead') continue;
        const dist = Math.abs(a.x - anchor.x) + Math.abs(a.y - anchor.y);
        if (dist > searchRadius) continue;
        let cluster = 0;
        for (const b of animals) {
          if (!b || b.state === 'dead') continue;
          const d = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
          if (d <= clusterRadius) cluster++;
        }
        if (!best || cluster > best.count) {
          best = { x: a.x, y: a.y, count: cluster };
        }
      }
      return { hotspot: best, nearby: best?.count || 0 };
    })();

    const lowFoodPressure = availableFood < villagerCount * 1.5;
    const hunterTarget = wildlifeInfo.nearby >= 3 && (famine || lowFoodPressure) ? 1 : 0;

    let storageTarget = famine ? 1 : 2;
    const woodBufferOk = availableWood > TUNING.storageWoodBuffer;
    if (!woodBufferOk) storageTarget = Math.min(storageTarget, 1);

    const buildQueue = [];
    const progressionTargets = applyProgressionPlanner(buildQueue, bb, plannedTotals, anchor);
    if (plannedTotals.hut < hutTarget && (!lowEnergy || hutCounts.total < hutTargetBase)) {
      const fatiguePenalty = lowEnergy ? 1 : 0;
      buildQueue.push({ priority: 1 + fatiguePenalty, kind: 'hut', anchor: { x: anchor.x + 2, y: anchor.y + 1 }, reason: 'shelter plan' });
    }
    if (desiredFarmplots > plannedTotals.farmplot) {
      const farmAnchor = zoneCentroid(ZONES.FARM) || anchor;
      const farmPriority = famine ? 0.5 : (approachingWinter ? 1 : 2);
      buildQueue.push({ priority: farmPriority, kind: 'farmplot', anchor: farmAnchor, reason: 'support crops', radius: 14 });
    }
    if (wellTarget > plannedTotals.well && (availableWood > TUNING.wellWoodBuffer || availableStone > 0) && (!famine || approachingWinter)) {
      const farmAnchor = zoneCentroid(ZONES.FARM) || anchor;
      const prio = approachingWinter ? 2.5 : 3;
      buildQueue.push({ priority: prio, kind: 'well', anchor: farmAnchor, reason: approachingWinter ? 'prepare for winter water' : 'hydrate farms', radius: 16 });
    }
    if (plannedTotals.storage < storageTarget && (woodBufferOk || storageCounts.built === 0) && (!famine || storageCounts.total === 0)) {
      buildQueue.push({ priority: famine ? 6 : 4, kind: 'storage', anchor: { x: anchor.x - 2, y: anchor.y }, reason: 'extra storage', radius: 18 });
    }
    if (hunterTarget > plannedTotals.hunterLodge) {
      const hotspot = wildlifeInfo.hotspot || anchor;
      buildQueue.push({
        priority: famine ? 0.4 : 1.8,
        kind: 'hunterLodge',
        anchor: { x: hotspot.x, y: hotspot.y },
        reason: famine ? 'hunt to survive' : 'secure wild food',
        radius: 18,
        context: { wildlife: true }
      });
    }

    buildQueue.sort((a, b) => a.priority - b.priority);

    const targetByKind = {
      hut: hutTarget,
      farmplot: desiredFarmplots,
      well: wellTarget,
      storage: storageTarget,
      hunterLodge: hunterTarget
    };
    for (const [kind, target] of Object.entries(progressionTargets)) {
      targetByKind[kind] = Math.max(targetByKind[kind] ?? 0, target);
    }
    const maxPlacements = Math.min(TUNING.maxPlacements, buildQueue.length);
    let placedThisTick = 0;
    let reservedWoodForPlans = 0;
    let reservedStoneForPlans = 0;
    for (const task of buildQueue) {
      if (placedThisTick >= maxPlacements) break;
      const def = BUILDINGS[task.kind] || {};
      const woodNeed = def.wood || 0;
      const stoneNeed = def.stone || 0;
      const woodBudget = availableToReserve('wood') - reservedWoodForPlans;
      const stoneBudget = availableToReserve('stone') - reservedStoneForPlans;
      if (woodNeed > 0 && woodBudget < woodNeed) continue;
      if (stoneNeed > 0 && stoneBudget < stoneNeed) continue;
      if (plannedTotals[task.kind] >= (targetByKind[task.kind] ?? 0)) continue;

      const pos = findPlacementNear(task.kind, task.anchor.x, task.anchor.y, task.radius || 18, task.context || {});
      if (pos) {
        placeBlueprint(task.kind, pos.x, pos.y, { reason: task.reason });
        plannedTotals[task.kind]++;
        reservedWoodForPlans += woodNeed;
        reservedStoneForPlans += stoneNeed;
        placed = true;
        placedThisTick++;
      }
    }

    return placed;
  }

  function evaluateResourceNeed(kind, available, villagerCount, cfg, thresholdKey, stateKey = kind) {
    const threshold = Number.isFinite(cfg?.[thresholdKey]) ? cfg[thresholdKey] : 0;
    const hysteresis = Number.isFinite(cfg?.hysteresis) ? cfg.hysteresis : 0;
    const ratio = villagerCount > 0 ? available / Math.max(1, villagerCount) : available;
    const prevNeed = jobNeedState[stateKey] === true;
    let need = ratio < threshold;
    if (!need && prevNeed && ratio < (threshold + hysteresis)) {
      need = true;
    }
    jobNeedState[stateKey] = need;
    return need;
  }

  function hasAnyFarmTiles() {
    const world = state.world;
    if (!world) return false;
    if (world.zone && countZoneTiles(ZONES.FARM) > 0) return true;
    if (world.tiles) {
      for (let i = 0; i < world.tiles.length; i++) {
        if (world.tiles[i] === TILES.FARMLAND) return true;
      }
    }
    return false;
  }

  function countVillagerInventory(itemType) {
    let total = 0;
    for (const v of state.units.villagers) {
      if (v?.inv && v.inv.type === itemType) {
        total += v.inv.qty || 1;
      }
    }
    return total;
  }

  function countEquippedBows() {
    let total = 0;
    for (const v of state.units.villagers) {
      if (v?.equippedBow) total++;
    }
    return total;
  }

  function findHunterLodge() {
    let best = null;
    for (const b of state.units.buildings) {
      if (!b || b.kind !== 'hunterLodge' || b.built < 1) continue;
      if (!best) { best = b; continue; }
      if (b.progress < (best.progress || 0)) best = b;
    }
    return best;
  }

  function hasRipeCrops(threshold = 160) {
    const world = state.world;
    if (!world || !world.growth || !world.tiles) return false;
    for (let i = 0; i < world.growth.length; i++) {
      if (world.tiles[i] === TILES.FARMLAND && world.growth[i] >= threshold) return true;
    }
    return false;
  }

  function shouldGenerateJobType(type, bb, cfg) {
    if (!bb) return true;
    const villagersCount = Math.max(1, bb.villagers || 0);
    if (type === 'forage') {
      if (bb.famine) return true;
      return evaluateResourceNeed('food', bb.availableFood || 0, villagersCount, cfg, 'minFoodPerVillager', 'food');
    }
    if (type === 'sow' || type === 'harvest') {
      if (bb.famine) return true;
      if (hasAnyFarmTiles()) return true;
      return evaluateResourceNeed('food', bb.availableFood || 0, villagersCount, cfg, 'minFoodPerVillager', type);
    }
    if (type === 'chop') {
      return evaluateResourceNeed('wood', bb.availableWood || 0, villagersCount, cfg, 'minWoodPerVillager');
    }
    if (type === 'mine') {
      return evaluateResourceNeed('stone', bb.availableStone || 0, villagersCount, cfg, 'minStonePerVillager');
    }
    if (type === 'craft_bow') {
      return evaluateResourceNeed('bow', bb.availableBow || 0, villagersCount, cfg, 'minBowsPerVillager', 'bow');
    }
    return true;
  }

  function generateJobs() {
    const world = state.world;
    const villagers = state.units.villagers;
    const animals = state.units.animals;
    const buildings = state.units.buildings;
    const jobs = state.units.jobs;
    const storageTotals = state.stocks.totals;
    const creationCfg = getJobCreationConfig();
    const bb = ensureBlackboardSnapshot();
    const allowSow = shouldGenerateJobType('sow', bb, creationCfg);
    const allowChop = shouldGenerateJobType('chop', bb, creationCfg);
    const allowMine = shouldGenerateJobType('mine', bb, creationCfg);
    const allowCraftBow = shouldGenerateJobType('craft_bow', bb, creationCfg);
    const villagerCount = Math.max(1, bb?.villagers || villagers.length || 0);
    const famineSeverity = computeFamineSeverity(bb);
    const foodOnHand = bb?.availableFood ?? storageTotals.food ?? 0;
    const forageNeed = bb?.famine || !hasRipeCrops() || foodOnHand < villagerCount * 2;
    const allowForage = shouldGenerateJobType('forage', bb, creationCfg) && forageNeed;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const i = y * GRID_W + x;
        if (tileOccupiedByBuilding(x, y)) continue;
        const z = world.zone[i];
        if (z === ZONES.FARM) {
          if (allowSow && zoneHasWorkNow(z, i) && !violatesSpacing(x, y, 'sow', creationCfg)) {
            addJob({ type: 'sow', x, y, prio: 0.6 + (policy.sliders.food || 0) * 0.6 });
          }
        } else if (z === ZONES.CUT) {
          if (allowChop && zoneHasWorkNow(z, i) && !violatesSpacing(x, y, 'chop', creationCfg)) {
            addJob({ type: 'chop', x, y, prio: 0.5 + (policy.sliders.build || 0) * 0.5 });
          }
        } else if (z === ZONES.MINE) {
          if (allowMine && zoneHasWorkNow(z, i) && !violatesSpacing(x, y, 'mine', creationCfg)) {
            addJob({ type: 'mine', x, y, prio: 0.5 + (policy.sliders.build || 0) * 0.5 });
          }
        }
      }
    }
    if (allowForage) {
      const anchor = findPrimaryAnchor() || { x: Math.round(GRID_W / 2), y: Math.round(GRID_H / 2) };
      const clampX = (val) => clamp(val, 0, GRID_W - 1);
      const clampY = (val) => clamp(val, 0, GRID_H - 1);
      const radius = Math.max(8, Math.round(10 + famineSeverity * 8));
      const minX = Math.max(0, clampX(anchor.x - radius));
      const maxX = Math.min(GRID_W - 1, clampX(anchor.x + radius));
      const minY = Math.max(0, clampY(anchor.y - radius));
      const maxY = Math.min(GRID_H - 1, clampY(anchor.y + radius));
      const foragePrio = Math.min(1, 0.85 + famineSeverity * 0.15 + (policy.sliders.food || 0) * 0.25);
      const maxJobs = Math.max(2, Math.ceil(villagerCount * 0.75));
      const candidates = [];
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const i = y * GRID_W + x;
          if (world.berries[i] <= 0) continue;
          if (tileOccupiedByBuilding(x, y)) continue;
          if (violatesSpacing(x, y, 'forage', creationCfg)) continue;
          const dist = Math.abs(x - anchor.x) + Math.abs(y - anchor.y);
          candidates.push({ x, y, i, dist });
        }
      }
      candidates.sort((a, b) => a.dist - b.dist);
      let added = 0;
      for (const c of candidates) {
        if (added >= maxJobs) break;
        if (hasSimilarJob({ type: 'forage', x: c.x, y: c.y })) continue;
        if (addJob({ type: 'forage', x: c.x, y: c.y, targetI: c.i, prio: foragePrio })) {
          added++;
        }
      }
    }

    if (allowCraftBow) {
      const desiredBows = Math.max(1, Math.ceil(villagerCount * 0.25));
      const bowOnVillagers = countVillagerInventory(ITEM.BOW) + countEquippedBows();
      const availableBows = (bb?.availableBow ?? availableToReserve('bow')) + bowOnVillagers;
      const activeCraftJobs = jobs.filter(j => j && j.type === 'craft_bow' && !j.cancelled).length;
      const shortage = Math.max(0, desiredBows - availableBows - activeCraftJobs);
      const recipe = CRAFTING_RECIPES.bow;
      if (shortage > 0 && recipe) {
        const lodge = findHunterLodge();
        if (lodge && reserveMaterials(recipe)) {
          const craftJob = addJob({
            type: 'craft_bow',
            x: lodge.x,
            y: lodge.y,
            bid: lodge.id,
            prio: 0.62 + (policy.sliders.explore || 0) * 0.2,
            materials: recipe
          });
          if (!craftJob) {
            releaseReservedMaterials(recipe);
          }
        }
      }
    }

    const lodge = findHunterLodge();
    if (lodge && countEquippedBows() > 0) {
      const center = buildingCenter(lodge);
      const effects = lodge.effects || {};
      const huntRadius = Number.isFinite(effects.huntingRadius) ? effects.huntingRadius : 6;
      const existingHunts = jobs.filter(j => j && j.type === 'hunt' && !j.cancelled);
      const targeted = new Set(existingHunts.map(j => j.targetAid).filter(Boolean));
      const availableArchers = Math.max(0, countEquippedBows() - existingHunts.length);
      if (availableArchers > 0) {
        const candidates = animals
          .filter(a => a && a.state !== 'dead')
          .filter(a => Math.abs(a.x - center.x) <= huntRadius && Math.abs(a.y - center.y) <= huntRadius)
          .filter(a => !targeted.has(a.id))
          .map(a => ({ animal: a, dist: Math.abs(a.x - center.x) + Math.abs(a.y - center.y) }))
          .sort((a, b) => a.dist - b.dist);
        const huntPrio = 0.6 + famineSeverity * 0.25 + (policy.sliders.food || 0) * 0.25 + (policy.sliders.explore || 0) * 0.12;
        let created = 0;
        for (const { animal } of candidates) {
          if (created >= availableArchers) break;
          const job = addJob({
            type: 'hunt',
            x: Math.round(animal.x),
            y: Math.round(animal.y),
            targetAid: animal.id,
            bid: lodge.id,
            prio: huntPrio
          });
          if (job) {
            created++;
          }
        }
      }
    }

    for (const b of buildings) {
      ensureBuildingData(b);
      if (b.built >= 1) {
        continue;
      }
      let status = buildingSupplyStatus(b);
      if (!status.hasAllReserved) {
        requestBuildHauls(b);
        status = buildingSupplyStatus(b);
      }
      let job = jobs.find(j => j.type === 'build' && j.bid === b.id);
      if (!status.hasAnySupply) {
        if (job) {
          const ji = jobs.indexOf(job);
          if (ji !== -1) {
            noteJobRemoved(job);
            jobs.splice(ji, 1);
          }
        }
        continue;
      }
      const buildSlider = policy.sliders.build || 0;
      const readyPrio = 0.6 + buildSlider * 0.6;
      const waitingPrio = 0.5 + buildSlider * 0.35;
      if (!job) {
        job = addJob({ type: 'build', bid: b.id, x: b.x, y: b.y, prio: status.fullyDelivered ? readyPrio : waitingPrio });
      } else {
        job.prio = status.fullyDelivered ? readyPrio : waitingPrio;
      }
      job.waitingForMaterials = !status.fullyDelivered;
      job.hasAllReserved = status.hasAllReserved;
    }
  }

  return { planZones, planBuildings, generateJobs };
}
