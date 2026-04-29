import {
  TILE_SIZE,
  ENTITY_TILE_SIZE,
  GRID_WIDTH,
  GRID_HEIGHT,
  SPEED_OPTIONS,
  CAMERA_MIN_Z,
  CAMERA_MAX_Z,
  DAY_LENGTH,
  LAYER_ORDER
} from '../config.js';

const coords = (() => {
  const TILE = TILE_SIZE;
  const ENTITY_TILE_PX = ENTITY_TILE_SIZE;
  let GRID_W = GRID_WIDTH;
  let GRID_H = GRID_HEIGHT;

  function tileToPxX(tx, cam){ return Math.floor((tx - cam.x) * TILE * cam.z); }
  function tileToPxY(ty, cam){ return Math.floor((ty - cam.y) * TILE * cam.z); }
  function pxToTileX(sx, cam){ return (sx / (TILE * cam.z)) + cam.x; }
  function pxToTileY(sy, cam){ return (sy / (TILE * cam.z)) + cam.y; }
  function idx(x, y){ return y * GRID_W + x; }
  function visibleTileBounds(W,H,cam){
    const spanX = Math.ceil(W/(TILE*cam.z));
    const spanY = Math.ceil(H/(TILE*cam.z));
    return {
      x0: Math.floor(cam.x)-1,
      y0: Math.floor(cam.y)-1,
      x1: Math.ceil(cam.x)+spanX+1,
      y1: Math.ceil(cam.y)+spanY+1
    };
  }

  return {
    TILE,
    ENTITY_TILE_PX,
    get GRID_W(){ return GRID_W; },
    set GRID_W(v){ GRID_W = v; },
    get GRID_H(){ return GRID_H; },
    set GRID_H(v){ GRID_H = v; },
    tileToPxX,
    tileToPxY,
    pxToTileX,
    pxToTileY,
    idx,
    visibleTileBounds
  };
})();

const {
  TILE,
  ENTITY_TILE_PX,
  tileToPxX,
  tileToPxY,
  pxToTileX,
  pxToTileY,
  visibleTileBounds: baseVisibleTileBounds,
  idx: baseIdx
} = coords;
const GRID_W = coords.GRID_W;
const GRID_H = coords.GRID_H;
const GRID_SIZE = GRID_W * GRID_H;
const SAVE_KEY = 'aiv_px_v3_save';
const SAVE_VERSION = 8;
const COARSE_SAVE_SIZE = 96;

// Sequential save-format migrations: when loading a save with version `v`,
// `loadGame` runs SAVE_MIGRATIONS.get(v), then SAVE_MIGRATIONS.get(v+1), …
// up to but not including SAVE_VERSION. Each function takes the parsed save
// object and returns a (possibly mutated) save object suitable for the
// next version.
const SAVE_MIGRATIONS = new Map([
  // v4 -> v5: introduces top-level tick/dayTime + per-villager np/rt.
  // Missing fields default via Number.isFinite checks at load time, so the
  // migration body is intentionally a no-op.
  [4, (data) => data],
  // v5 -> v6: Phase 7 adds `b.laborProgress` per building. ensureBuildingData
  // defaults missing fields to 0 (or to the kind's full buildLaborTicks if
  // the building was already built), so old mid-build saves resume from
  // scratch — acceptable per CLAUDE.md save-compat rule.
  [5, (data) => data],
  // v6 -> v7: Phase 8 adds per-villager `restStartedAtNight` (saved as `rsn`).
  // Absent fields coerce to false at load time, matching pre-Phase-8 wake
  // behavior on the first post-load sleep — no-op migration.
  [6, (data) => data],
  // v7 -> v8: Phase 1 adds world.layout (archetype + slots + anchors). Layout
  // is a pure function of seed+terrain and is recomputed at world-gen, so it
  // is not serialized — the migration body is intentionally a no-op.
  [7, (data) => data]
]);
const LAYOUT_ARCHETYPES = Object.freeze({
  RADIAL: 'radial',
  RIBBON: 'ribbon',
  TERRACE: 'terrace',
  COURTYARD: 'courtyard'
});
const TILES = { GRASS:0, FOREST:1, ROCK:2, WATER:3, FERTILE:4, FARMLAND:5, SAND:6, SNOW:7, MEADOW:8, MARSH:9 };
const ZONES = { NONE:0, FARM:1, CUT:2, MINE:4 };
const WALKABLE = new Set([
  TILES.GRASS,
  TILES.FOREST,
  TILES.ROCK,
  TILES.FERTILE,
  TILES.FARMLAND,
  TILES.SAND,
  TILES.SNOW,
  TILES.MEADOW,
  TILES.MARSH
]);
const ANIMAL_TYPES = {
  deer: {
    label: 'Deer',
    preferred: [TILES.MEADOW, TILES.FOREST],
    fallback: [TILES.GRASS, TILES.FERTILE],
    density: 0.00045,
    minCount: 10
  },
  boar: {
    label: 'Boar',
    preferred: [TILES.FOREST, TILES.MARSH],
    fallback: [TILES.GRASS, TILES.SAND],
    density: 0.00035,
    minCount: 8
  }
};
const HUNT_RANGE = 3.5;
const HUNT_RETRY_COOLDOWN = 140;
// Crops are harvest-ready at this growth value. Used by both the planner's
// harvest-job emit scan and `hasRipeCrops()` so the two stay in sync — a
// mismatch caused B2/S8/S9 (forage jobs scheduled on top of harvest in the
// 150–160 window).
const RIPE_THRESHOLD = 150;
const ANIMAL_BEHAVIORS = {
  deer: {
    roamRadius: 4,
    idleTicks: [28, 90],
    roamTicks: [60, 140],
    speed: 0.14,
    fleeSpeed: 0.21,
    grazeChance: 0.12,
    grazeRadius: 1,
    fearRadius: 4,
    fleeDistance: 4.5,
    observeMood: 0.006,
    idleBob: 1.6
  },
  boar: {
    roamRadius: 3,
    idleTicks: [22, 70],
    roamTicks: [45, 120],
    speed: 0.12,
    fleeSpeed: 0.18,
    grazeChance: 0.16,
    grazeRadius: 1,
    fearRadius: 3,
    fleeDistance: 3.5,
    observeMood: 0.004,
    idleBob: 1.2
  }
};
const ITEM = { FOOD:'food', WOOD:'wood', STONE:'stone', BOW:'bow', PELT:'pelt' };
// Explicit list (not Object.values(ITEM)) so future non-stored ITEM entries
// don't silently join the storage/save pipeline.
const RESOURCE_TYPES = Object.freeze(['food', 'wood', 'stone', 'bow', 'pelt']);
const ITEM_COLORS = Object.freeze({
  food: '#b6d97a',
  wood: '#b48a52',
  stone: '#aeb7c3',
  bow: '#d4c08a',
  pelt: '#8a6a3f'
});
const CRAFTING_RECIPES = {
  bow: Object.freeze({ wood: 2, stone: 1 })
};
const DIR4 = [[1,0],[-1,0],[0,1],[0,-1]];
const TREE_VERTICAL_RAISE = 6; // pixels to lift tree sprites so trunks anchor in their tile
const LIGHT_VECTOR = { x:-0.75, y:-0.65 };
const LIGHT_VECTOR_LENGTH = Math.hypot(LIGHT_VECTOR.x, LIGHT_VECTOR.y) || 1;
const SHADOW_DIRECTION = {
  x: -LIGHT_VECTOR.x / LIGHT_VECTOR_LENGTH,
  y: -LIGHT_VECTOR.y / LIGHT_VECTOR_LENGTH
};
const SHADOW_DIRECTION_ANGLE = Math.atan2(SHADOW_DIRECTION.y, SHADOW_DIRECTION.x);
const SHADE_COLOR_CACHE = (() => {
  const cache = new Array(256);
  for (let i = 0; i < 256; i++) {
    cache[i] = `rgb(${i},${i},${i})`;
  }
  return cache;
})();
const SPEEDS = SPEED_OPTIONS;

export {
  ANIMAL_BEHAVIORS,
  ANIMAL_TYPES,
  CAMERA_MAX_Z,
  CAMERA_MIN_Z,
  COARSE_SAVE_SIZE,
  CRAFTING_RECIPES,
  DAY_LENGTH,
  DIR4,
  ENTITY_TILE_PX,
  GRID_H,
  GRID_SIZE,
  GRID_W,
  HUNT_RANGE,
  HUNT_RETRY_COOLDOWN,
  ITEM,
  ITEM_COLORS,
  LAYOUT_ARCHETYPES,
  LIGHT_VECTOR,
  LIGHT_VECTOR_LENGTH,
  LAYER_ORDER,
  RESOURCE_TYPES,
  RIPE_THRESHOLD,
  SAVE_KEY,
  SAVE_MIGRATIONS,
  SAVE_VERSION,
  SHADOW_DIRECTION,
  SHADOW_DIRECTION_ANGLE,
  SHADE_COLOR_CACHE,
  SPEEDS,
  TILE,
  TILES,
  TREE_VERTICAL_RAISE,
  WALKABLE,
  ZONES,
  baseIdx,
  baseVisibleTileBounds,
  coords,
  pxToTileX,
  pxToTileY,
  tileToPxX,
  tileToPxY
};
