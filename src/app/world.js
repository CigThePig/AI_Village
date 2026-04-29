import { GRID_W, GRID_H, TILES } from './constants.js';

// buildLaborTicks gates the new "felt construction" arc (Phase 7 / B3-S6):
// once materials are delivered, the build job stays in the queue while the
// villager accumulates `b.laborProgress` per-tick in the 'building' state.
// Zero ticks (campfire) keeps the legacy one-tick finish path so emitter
// initialization and the cost-0 case stay simple.
export const BUILDINGS = {
  campfire: { label: 'Campfire', cost: 0, wood: 0, stone: 0, buildLaborTicks: 0, effects: { radius: 4 }, tooltip: 'Villagers gather here at night; warms and cheers everyone within 4 tiles.' },
  storage:  { label: 'Storage',  cost: 8, wood: 8, stone: 0, buildLaborTicks: 80 },
  hut:      { label: 'Hut',      cost: 10, wood: 10, stone: 0, buildLaborTicks: 60, effects: { radius: 3, moodBonus: 0.0008 }, tooltip: 'Shelter that gently lifts moods nearby.' },
  hunterLodge: {
    label: 'Hunter Lodge',
    cost: 12,
    wood: 10,
    stone: 2,
    buildLaborTicks: 80,
    effects: {
      huntingRadius: 6,
      gameYieldBonus: 0.25,
      hideYieldBonus: 0.2
    },
    tooltip: 'Organizes hunts; improves meat and hide yields from wildlife within 6 tiles.'
  },
  farmplot: {
    label: 'Farm Plot',
    cost: 4,
    wood: 4,
    stone: 0,
    buildLaborTicks: 30,
    effects: {
      radius: 3,
      growthBonus: 0.85,
      harvestBonus: 0.65
    },
    tooltip: 'Boosts crop growth and yields within 3 tiles.'
  },
  well: {
    label: 'Well',
    cost: 6,
    wood: 0,
    stone: 6,
    buildLaborTicks: 100,
    effects: {
      hydrationRadius: 4,
      hydrationGrowthBonus: 0.45,
      moodBonus: 0.0007,
      hydrationBuff: 0.25
    },
    tooltip: 'Villagers drink here to stay hydrated; hydrates farms in 4 tiles and keeps nearby villagers cheerful.'
  }
};

export const CAMPFIRE_EFFECT_RADIUS = (BUILDINGS?.campfire?.effects?.radius | 0) || 2;

export const FOOTPRINT = {
  campfire: { w: 2, h: 2 },
  storage:  { w: 2, h: 2 },
  hut:      { w: 2, h: 2 },
  hunterLodge: { w: 2, h: 2 },
  farmplot: { w: 2, h: 2 },
  well:     { w: 2, h: 2 }
};

export function getFootprint(kind) {
  return FOOTPRINT[kind] || { w: 2, h: 2 };
}

export function buildingCenter(b) {
  const fp = getFootprint(b.kind);
  return {
    x: b.x + (fp.w - 1) / 2,
    y: b.y + (fp.h - 1) / 2
  };
}

export function forEachFootprintTile(b, fn) {
  const fp = getFootprint(b.kind);
  for (let yy = 0; yy < fp.h; yy++) {
    for (let xx = 0; xx < fp.w; xx++) {
      fn(b.x + xx, b.y + yy);
    }
  }
}

export function distanceToFootprint(x, y, b) {
  const fp = getFootprint(b.kind);
  const minX = b.x;
  const maxX = b.x + fp.w - 1;
  const minY = b.y;
  const maxY = b.y + fp.h - 1;
  let dx = 0;
  if (x < minX) dx = minX - x;
  else if (x > maxX) dx = x - maxX;
  let dy = 0;
  if (y < minY) dy = minY - y;
  else if (y > maxY) dy = y - maxY;
  return dx + dy;
}

export function buildingEntryTiles(b) {
  const fp = getFootprint(b.kind);
  const tiles = [];
  const x0 = b.x;
  const y0 = b.y;
  const x1 = b.x + fp.w - 1;
  const y1 = b.y + fp.h - 1;
  for (let xx = x0; xx <= x1; xx++) {
    tiles.push({ x: xx, y: y0 - 1 });
    tiles.push({ x: xx, y: y1 + 1 });
  }
  for (let yy = y0; yy <= y1; yy++) {
    tiles.push({ x: x0 - 1, y: yy });
    tiles.push({ x: x1 + 1, y: yy });
  }
  return tiles;
}

export function ensureBuildingData(b) {
  if (!b) return;
  if (!b.store) { b.store = { wood: 0, stone: 0, food: 0 }; }
  if (!b.spent) {
    const def = BUILDINGS[b.kind] || {};
    const cost = def.cost || ((def.wood || 0) + (def.stone || 0));
    const woodReq = def.wood || 0;
    const stoneReq = def.stone || 0;
    let progress = Math.max(0, b.progress || 0);
    if (b.built >= 1) {
      b.spent = { wood: woodReq, stone: stoneReq };
    } else {
      const spentWood = Math.min(progress, woodReq);
      const spentStone = Math.min(Math.max(0, progress - spentWood), stoneReq);
      b.spent = { wood: spentWood, stone: spentStone };
    }
    if (b.progress === undefined) b.progress = Math.min(cost, (b.spent.wood || 0) + (b.spent.stone || 0));
  } else {
    if (typeof b.spent.wood !== 'number') b.spent.wood = 0;
    if (typeof b.spent.stone !== 'number') b.spent.stone = 0;
  }
  if (!b.pending) { b.pending = { wood: 0, stone: 0 }; }
  if (typeof b.pending.wood !== 'number') b.pending.wood = 0;
  if (typeof b.pending.stone !== 'number') b.pending.stone = 0;
  if (typeof b.progress !== 'number') b.progress = (b.spent.wood || 0) + (b.spent.stone || 0);
  if (typeof b.laborProgress !== 'number') b.laborProgress = b.built >= 1 ? (BUILDINGS[b.kind]?.buildLaborTicks || 0) : 0;
  if (!b.activity) { b.activity = { occupants: 0, lastUse: 0, lastHydrate: 0, lastSocial: 0, lastRest: 0 }; }
  if (typeof b.activity.occupants !== 'number') b.activity.occupants = 0;
  if (typeof b.activity.lastUse !== 'number') b.activity.lastUse = 0;
  if (typeof b.activity.lastHydrate !== 'number') b.activity.lastHydrate = 0;
  if (typeof b.activity.lastSocial !== 'number') b.activity.lastSocial = 0;
  if (typeof b.activity.lastRest !== 'number') b.activity.lastRest = 0;
}

export function buildingResourceNeed(b, resource) {
  const def = BUILDINGS[b?.kind] || {};
  const required = def[resource] || 0;
  const spent = b?.spent?.[resource] || 0;
  return Math.max(0, required - spent);
}

export function buildingSupplyStatus(b) {
  ensureBuildingData(b);
  const woodNeed = buildingResourceNeed(b, 'wood');
  const stoneNeed = buildingResourceNeed(b, 'stone');
  const storeWood = b?.store?.wood || 0;
  const storeStone = b?.store?.stone || 0;
  const pendingWood = b?.pending?.wood || 0;
  const pendingStone = b?.pending?.stone || 0;
  const reservedWood = storeWood + pendingWood;
  const reservedStone = storeStone + pendingStone;
  const requiresResources = (woodNeed > 0) || (stoneNeed > 0);
  const hasAnySupply = requiresResources ? (reservedWood > 0 || reservedStone > 0) : true;
  const hasAllReserved = reservedWood >= woodNeed && reservedStone >= stoneNeed;
  const fullyDelivered = storeWood >= woodNeed && storeStone >= stoneNeed;
  return {
    woodNeed,
    stoneNeed,
    storeWood,
    storeStone,
    pendingWood,
    pendingStone,
    reservedWood,
    reservedStone,
    hasAnySupply,
    hasAllReserved,
    fullyDelivered
  };
}

export function tileOccupiedByBuildingIn(buildings, x, y, ignoreId = null) {
  for (const b of buildings) {
    if (ignoreId && b.id === ignoreId) continue;
    const fp = getFootprint(b.kind);
    if (x >= b.x && x < b.x + fp.w && y >= b.y && y < b.y + fp.h) {
      return true;
    }
  }
  return false;
}

export function buildingAtIn(buildings, x, y) {
  for (const b of buildings) {
    const fp = getFootprint(b.kind);
    if (x >= b.x && x < b.x + fp.w && y >= b.y && y < b.y + fp.h) {
      return b;
    }
  }
  return null;
}

export function validateFootprintPlacementIn(buildings, world, kind, tx, ty, opts = {}) {
  const normalizedOpts = (opts && typeof opts === 'object') ? opts : { ignoreId: opts };
  const { ignoreId = null, allowObstacles = false } = normalizedOpts;
  const fp = getFootprint(kind);
  if (tx < 0 || ty < 0 || tx + fp.w > GRID_W || ty + fp.h > GRID_H) return 'bounds';
  for (let yy = 0; yy < fp.h; yy++) {
    for (let xx = 0; xx < fp.w; xx++) {
      const gx = tx + xx;
      const gy = ty + yy;
      const i = gy * GRID_W + gx;
      const tile = world.tiles[i];
      if (tile === TILES.WATER) return 'water';
      if (tile === TILES.ROCK) return 'rock';
      if (!allowObstacles) {
        if (world.trees?.[i] > 0) return 'blocked';
        if (world.rocks?.[i] > 0) return 'blocked';
      }
    }
  }
  for (let yy = 0; yy < fp.h; yy++) {
    for (let xx = 0; xx < fp.w; xx++) {
      const gx = tx + xx;
      const gy = ty + yy;
      if (tileOccupiedByBuildingIn(buildings, gx, gy, ignoreId)) return 'occupied';
    }
  }
  return null;
}

export function agricultureBonusesAt(buildings, x, y) {
  let growthBonus = 0, harvestBonus = 0, moodBonus = 0;
  if (!buildings.length) return { growthBonus, harvestBonus, moodBonus };
  const influenceFor = (radius, dist) => {
    if (radius > 0) { return dist > radius ? 0 : Math.max(0, 1 - dist / (radius + 1)); }
    return dist === 0 ? 1 : 0;
  };
  for (const b of buildings) {
    if (b.built < 1) continue;
    const def = BUILDINGS[b.kind] || {};
    const eff = def.effects || {};
    const dist = distanceToFootprint(x, y, b);
    if (b.kind === 'farmplot') {
      const radius = (eff.radius | 0);
      const influence = influenceFor(radius, dist);
      if (influence <= 0) continue;
      if (eff.growthBonus) { growthBonus += eff.growthBonus * influence; }
      if (eff.harvestBonus) { harvestBonus += eff.harvestBonus * influence; }
    } else if (b.kind === 'well') {
      const radius = (eff.hydrationRadius | 0);
      const influence = influenceFor(radius, dist);
      if (influence <= 0) continue;
      if (eff.hydrationGrowthBonus) { growthBonus += eff.hydrationGrowthBonus * influence; }
      if (eff.moodBonus) { moodBonus += eff.moodBonus * influence; }
    } else if (eff.moodBonus) {
      const radius = (eff.radius | 0);
      const influence = influenceFor(radius, dist);
      if (influence <= 0) continue;
      moodBonus += eff.moodBonus * influence;
    }
  }
  return { growthBonus, harvestBonus, moodBonus };
}
