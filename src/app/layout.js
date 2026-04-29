// Phase 1 — Settlement layout templates.
//
// Replaces the implicit "campfire-at-center, score-within-18-tiles" layout with
// an explicit archetype + named-slot table. `buildLayout(seed, world)` analyzes
// terrain features (water orientation, tree density, slope from aux.height),
// picks one of {radial, ribbon, terrace, courtyard} deterministically, and
// stamps a parametric set of anchor slots. The planner then routes each
// building kind into the matching slot; the legacy per-tile scoring becomes
// the within-slot tie-breaker.
//
// All randomness threads through mulberry32(seed) — no Math.random().

import { GRID_H, GRID_W, TILES } from './constants.js';
import { mulberry32 } from './rng.js';

export const LAYOUT_ARCHETYPES = Object.freeze({
  RADIAL: 'radial',
  RIBBON: 'ribbon',
  TERRACE: 'terrace',
  COURTYARD: 'courtyard'
});

const ARCHETYPE_LIST = ['radial', 'ribbon', 'terrace', 'courtyard'];

const DEFAULT_KIND_TO_FAMILY = Object.freeze({
  campfire: ['hearth'],
  storage: ['storage'],
  hut: ['housing'],
  hunterLodge: ['craft'],
  farmplot: ['fields'],
  well: ['wells', 'fields']
});

// Quadrant ids used by terrain analysis. N is the top half of the map (y < cy),
// S is the bottom half, etc.
const QUADRANTS = ['N', 'E', 'S', 'W'];

function isBuildableTile(tile) {
  return tile === TILES.GRASS
    || tile === TILES.FERTILE
    || tile === TILES.MEADOW
    || tile === TILES.SAND
    || tile === TILES.FARMLAND
    || tile === TILES.SNOW;
}

function clampInt(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v | 0;
}

function clampFootprint(fp) {
  const x = clampInt(fp.x, 0, Math.max(0, GRID_W - 1));
  const y = clampInt(fp.y, 0, Math.max(0, GRID_H - 1));
  const w = clampInt(Math.max(1, fp.w), 1, GRID_W - x);
  const h = clampInt(Math.max(1, fp.h), 1, GRID_H - y);
  return { x, y, w, h };
}

function rectsOverlap(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

// Walk an outward spiral from (cx, cy) until a tile satisfies `predicate`.
function spiralFind(cx, cy, predicate, maxRadius = Math.max(GRID_W, GRID_H)) {
  if (predicate(cx, cy)) return { x: cx, y: cy };
  for (let r = 1; r <= maxRadius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) continue;
        if (predicate(x, y)) return { x, y };
      }
    }
  }
  return { x: cx, y: cy };
}

export function analyzeTerrain(world) {
  const tiles = world?.tiles;
  const trees = world?.trees;
  const height = world?.aux?.height || null;
  const cx = (GRID_W / 2) | 0;
  const cy = (GRID_H / 2) | 0;

  const waterByQuad = { N: 0, E: 0, S: 0, W: 0 };
  const treeByQuad = { N: 0, E: 0, S: 0, W: 0 };
  let totalWater = 0;
  let totalTrees = 0;
  let centerTrees = 0;
  let centerSamples = 0;
  // Slope estimate: height range across the grid normalized to [0, 1].
  let hMin = Infinity;
  let hMax = -Infinity;
  let hSamples = 0;

  if (tiles && tiles.length === GRID_W * GRID_H) {
    for (let y = 0; y < GRID_H; y++) {
      const dy = y - cy;
      for (let x = 0; x < GRID_W; x++) {
        const i = y * GRID_W + x;
        const dx = x - cx;
        // Quadrant assignment: N if dy<=dx-... use the dominant axis.
        // Use sign of dx,dy and which has larger magnitude.
        let quad;
        if (Math.abs(dy) >= Math.abs(dx)) {
          quad = dy < 0 ? 'N' : 'S';
        } else {
          quad = dx < 0 ? 'W' : 'E';
        }
        if (tiles[i] === TILES.WATER) {
          waterByQuad[quad]++;
          totalWater++;
        }
        if (trees && trees[i] > 0) {
          treeByQuad[quad]++;
          totalTrees++;
          if (Math.abs(dx) <= 6 && Math.abs(dy) <= 6) {
            centerTrees++;
          }
        }
        if (Math.abs(dx) <= 6 && Math.abs(dy) <= 6) {
          centerSamples++;
        }
        if (height && height.length === tiles.length) {
          const h = height[i];
          if (h < hMin) hMin = h;
          if (h > hMax) hMax = h;
          hSamples++;
        }
      }
    }
  }

  const totalCells = GRID_W * GRID_H;
  let dominantWaterSide = null;
  if (totalWater > totalCells * 0.02) {
    let bestQuad = 'N';
    let bestCount = waterByQuad.N;
    for (const q of QUADRANTS) {
      if (waterByQuad[q] > bestCount) { bestCount = waterByQuad[q]; bestQuad = q; }
    }
    // Require dominant quadrant to hold ≥40% of all water tiles before we
    // call it directional — diffuse water shouldn't push us to ribbon.
    if (bestCount >= totalWater * 0.4) dominantWaterSide = bestQuad;
  }

  const slope = (hSamples > 0 && hMax > hMin)
    ? Math.min(1, (hMax - hMin) / 255)
    : 0;
  const treeDensityCenter = centerSamples > 0 ? centerTrees / centerSamples : 0;
  const treeDensityTotal = totalCells > 0 ? totalTrees / totalCells : 0;

  return {
    waterByQuad,
    treeByQuad,
    totalWater,
    totalTrees,
    treeDensityCenter,
    treeDensityTotal,
    slope,
    dominantWaterSide,
    center: { x: cx, y: cy }
  };
}

// Deterministic archetype pick. Terrain features dominate; mulberry32(seed)
// adds a small jitter so seeds with similar terrain still resolve consistently.
export function chooseArchetype(seed, features, opts = {}) {
  const jitterAmplitude = Number.isFinite(opts.jitterAmplitude) ? opts.jitterAmplitude : 0.15;
  const weights = opts.archetypeWeights || { radial: 1, ribbon: 1, terrace: 1, courtyard: 1 };
  const bias = opts.terrainBias || { waterToRibbon: 2, slopeToTerrace: 2, openToCourtyard: 1.5 };

  const score = {
    radial: (weights.radial || 1) * (1 + (features.dominantWaterSide ? 0 : 1)),
    ribbon: (weights.ribbon || 1) * (1 + (features.dominantWaterSide ? bias.waterToRibbon : 0)),
    terrace: (weights.terrace || 1) * (1 + Math.min(2, features.slope * bias.slopeToTerrace * 2)),
    courtyard: (weights.courtyard || 1) * (1 + (features.treeDensityCenter < 0.1 ? bias.openToCourtyard : 0))
  };

  const rng = mulberry32((seed >>> 0) || 1);
  let best = ARCHETYPE_LIST[0];
  let bestScore = -Infinity;
  for (const id of ARCHETYPE_LIST) {
    const s = score[id] + (rng() * 2 - 1) * jitterAmplitude;
    if (s > bestScore) { bestScore = s; best = id; }
  }
  return best;
}

function pickSettlementOrigin(world, features) {
  const cx = features.center.x;
  const cy = features.center.y;
  let originX = cx;
  let originY = cy;

  // Shift inland from the dominant water side so settlements anchored next to
  // a coast still sit on usable land.
  if (features.dominantWaterSide === 'N') originY = cy + 10;
  else if (features.dominantWaterSide === 'S') originY = cy - 10;
  else if (features.dominantWaterSide === 'E') originX = cx - 10;
  else if (features.dominantWaterSide === 'W') originX = cx + 10;

  const tiles = world?.tiles;
  if (!tiles) return { x: originX, y: originY };

  const snapped = spiralFind(
    clampInt(originX, 4, GRID_W - 5),
    clampInt(originY, 4, GRID_H - 5),
    (x, y) => {
      // Require a 4x4 buildable area around the origin so the hearth and
      // storage slots have somewhere to sit even without obstacle clearing.
      for (let yy = -2; yy <= 1; yy++) {
        for (let xx = -2; xx <= 1; xx++) {
          const tx = x + xx;
          const ty = y + yy;
          if (tx < 0 || ty < 0 || tx >= GRID_W || ty >= GRID_H) return false;
          if (!isBuildableTile(tiles[ty * GRID_W + tx])) return false;
        }
      }
      return true;
    },
    24
  );
  return snapped;
}

// Each archetype emits the same slot families (hearth, storage, housing×N,
// craft, fields, wells) but with different geometry, so the planner's slot
// lookup stays archetype-agnostic.
function radialSlots(origin, _features) {
  const { x, y } = origin;
  const slots = [
    { id: 'hearth', family: 'hearth', footprint: { x: x - 1, y: y - 1, w: 4, h: 4 }, capacity: 1, kindAffinity: ['campfire'] },
    { id: 'storage-main', family: 'storage', footprint: { x: x + 4, y: y - 1, w: 4, h: 4 }, capacity: 1, kindAffinity: ['storage'] },
    { id: 'housing-ring-N', family: 'housing', footprint: { x: x - 8, y: y - 12, w: 16, h: 5 }, capacity: 3, kindAffinity: ['hut'] },
    { id: 'housing-ring-E', family: 'housing', footprint: { x: x + 9, y: y - 6, w: 5, h: 14 }, capacity: 3, kindAffinity: ['hut'] },
    { id: 'housing-ring-S', family: 'housing', footprint: { x: x - 8, y: y + 8, w: 16, h: 5 }, capacity: 3, kindAffinity: ['hut'] },
    { id: 'housing-ring-W', family: 'housing', footprint: { x: x - 13, y: y - 6, w: 5, h: 14 }, capacity: 3, kindAffinity: ['hut'] },
    { id: 'craft', family: 'craft', footprint: { x: x + 9, y: y - 13, w: 6, h: 6 }, capacity: 2, kindAffinity: ['hunterLodge'] },
    { id: 'fields-1', family: 'fields', footprint: { x: x - 16, y: y + 4, w: 10, h: 10 }, capacity: 4, kindAffinity: ['farmplot', 'well'] },
    { id: 'wells', family: 'wells', footprint: { x: x - 14, y: y + 4, w: 4, h: 6 }, capacity: 1, kindAffinity: ['well'] }
  ];
  const anchors = {};
  for (const s of slots) {
    anchors[s.id] = { x: s.footprint.x + s.footprint.w / 2, y: s.footprint.y + s.footprint.h / 2 };
  }
  return { slots, anchors };
}

function ribbonSlots(origin, features) {
  const { x, y } = origin;
  // Ribbon runs along the water edge axis. If water is N or S, ribbon spans
  // east-west; otherwise it spans north-south.
  const horizontal = features.dominantWaterSide === 'N' || features.dominantWaterSide === 'S' || !features.dominantWaterSide;
  let slots;
  if (horizontal) {
    slots = [
      { id: 'hearth', family: 'hearth', footprint: { x: x - 1, y: y - 1, w: 4, h: 4 }, capacity: 1, kindAffinity: ['campfire'] },
      { id: 'storage-main', family: 'storage', footprint: { x: x + 4, y: y - 1, w: 4, h: 4 }, capacity: 1, kindAffinity: ['storage'] },
      { id: 'housing-band-A', family: 'housing', footprint: { x: x - 18, y: y - 6, w: 18, h: 4 }, capacity: 3, kindAffinity: ['hut'] },
      { id: 'housing-band-B', family: 'housing', footprint: { x: x + 9, y: y - 6, w: 18, h: 4 }, capacity: 3, kindAffinity: ['hut'] },
      { id: 'housing-band-C', family: 'housing', footprint: { x: x - 18, y: y + 5, w: 18, h: 4 }, capacity: 3, kindAffinity: ['hut'] },
      { id: 'craft', family: 'craft', footprint: { x: x - 24, y: y - 1, w: 5, h: 5 }, capacity: 2, kindAffinity: ['hunterLodge'] },
      { id: 'fields-1', family: 'fields', footprint: { x: x - 6, y: y + 11, w: 14, h: 14 }, capacity: 4, kindAffinity: ['farmplot', 'well'] },
      { id: 'wells', family: 'wells', footprint: { x: x + 8, y: y + 11, w: 4, h: 6 }, capacity: 1, kindAffinity: ['well'] }
    ];
  } else {
    slots = [
      { id: 'hearth', family: 'hearth', footprint: { x: x - 1, y: y - 1, w: 4, h: 4 }, capacity: 1, kindAffinity: ['campfire'] },
      { id: 'storage-main', family: 'storage', footprint: { x: x - 1, y: y + 4, w: 4, h: 4 }, capacity: 1, kindAffinity: ['storage'] },
      { id: 'housing-band-A', family: 'housing', footprint: { x: x - 6, y: y - 18, w: 4, h: 18 }, capacity: 3, kindAffinity: ['hut'] },
      { id: 'housing-band-B', family: 'housing', footprint: { x: x - 6, y: y + 9, w: 4, h: 18 }, capacity: 3, kindAffinity: ['hut'] },
      { id: 'housing-band-C', family: 'housing', footprint: { x: x + 5, y: y - 18, w: 4, h: 18 }, capacity: 3, kindAffinity: ['hut'] },
      { id: 'craft', family: 'craft', footprint: { x: x - 1, y: y - 24, w: 5, h: 5 }, capacity: 2, kindAffinity: ['hunterLodge'] },
      { id: 'fields-1', family: 'fields', footprint: { x: x + 11, y: y - 6, w: 14, h: 14 }, capacity: 4, kindAffinity: ['farmplot', 'well'] },
      { id: 'wells', family: 'wells', footprint: { x: x + 11, y: y + 8, w: 6, h: 4 }, capacity: 1, kindAffinity: ['well'] }
    ];
  }
  const anchors = {};
  for (const s of slots) {
    anchors[s.id] = { x: s.footprint.x + s.footprint.w / 2, y: s.footprint.y + s.footprint.h / 2 };
  }
  return { slots, anchors };
}

function terraceSlots(origin, _features) {
  const { x, y } = origin;
  // Three stacked rows climbing the slope. Hearth on the lowest row, fields on
  // the flattest band (the lowest one), housing rows above.
  const slots = [
    { id: 'hearth', family: 'hearth', footprint: { x: x - 1, y: y + 5, w: 4, h: 4 }, capacity: 1, kindAffinity: ['campfire'] },
    { id: 'storage-main', family: 'storage', footprint: { x: x + 4, y: y - 1, w: 4, h: 4 }, capacity: 1, kindAffinity: ['storage'] },
    { id: 'housing-row-1', family: 'housing', footprint: { x: x - 12, y: y - 13, w: 24, h: 4 }, capacity: 3, kindAffinity: ['hut'] },
    { id: 'housing-row-2', family: 'housing', footprint: { x: x - 12, y: y - 7, w: 24, h: 4 }, capacity: 3, kindAffinity: ['hut'] },
    { id: 'housing-row-3', family: 'housing', footprint: { x: x - 12, y: y - 1, w: 24, h: 4 }, capacity: 3, kindAffinity: ['hut'] },
    { id: 'craft', family: 'craft', footprint: { x: x + 13, y: y - 7, w: 6, h: 6 }, capacity: 2, kindAffinity: ['hunterLodge'] },
    { id: 'fields-1', family: 'fields', footprint: { x: x - 12, y: y + 11, w: 24, h: 10 }, capacity: 4, kindAffinity: ['farmplot', 'well'] },
    { id: 'wells', family: 'wells', footprint: { x: x - 4, y: y + 11, w: 4, h: 6 }, capacity: 1, kindAffinity: ['well'] }
  ];
  const anchors = {};
  for (const s of slots) {
    anchors[s.id] = { x: s.footprint.x + s.footprint.w / 2, y: s.footprint.y + s.footprint.h / 2 };
  }
  return { slots, anchors };
}

function courtyardSlots(origin, _features) {
  const { x, y } = origin;
  // Storage and craft form a U around an empty central plaza; hearth at the
  // plaza center; housing slots on the outer N/E/S/W; fields outside the U.
  const slots = [
    { id: 'hearth', family: 'hearth', footprint: { x: x - 1, y: y - 1, w: 4, h: 4 }, capacity: 1, kindAffinity: ['campfire'] },
    { id: 'storage-main', family: 'storage', footprint: { x: x - 7, y: y - 2, w: 4, h: 5 }, capacity: 1, kindAffinity: ['storage'] },
    { id: 'craft', family: 'craft', footprint: { x: x + 5, y: y - 2, w: 5, h: 5 }, capacity: 2, kindAffinity: ['hunterLodge'] },
    { id: 'housing-ring-N', family: 'housing', footprint: { x: x - 8, y: y - 11, w: 18, h: 5 }, capacity: 3, kindAffinity: ['hut'] },
    { id: 'housing-ring-E', family: 'housing', footprint: { x: x + 12, y: y - 6, w: 5, h: 14 }, capacity: 3, kindAffinity: ['hut'] },
    { id: 'housing-ring-S', family: 'housing', footprint: { x: x - 8, y: y + 8, w: 18, h: 5 }, capacity: 3, kindAffinity: ['hut'] },
    { id: 'housing-ring-W', family: 'housing', footprint: { x: x - 16, y: y - 6, w: 5, h: 14 }, capacity: 3, kindAffinity: ['hut'] },
    { id: 'fields-1', family: 'fields', footprint: { x: x - 8, y: y + 15, w: 18, h: 10 }, capacity: 4, kindAffinity: ['farmplot', 'well'] },
    { id: 'wells', family: 'wells', footprint: { x: x + 1, y: y + 15, w: 4, h: 6 }, capacity: 1, kindAffinity: ['well'] }
  ];
  const anchors = {};
  for (const s of slots) {
    anchors[s.id] = { x: s.footprint.x + s.footprint.w / 2, y: s.footprint.y + s.footprint.h / 2 };
  }
  return { slots, anchors };
}

const ARCHETYPE_BUILDERS = {
  radial: radialSlots,
  ribbon: ribbonSlots,
  terrace: terraceSlots,
  courtyard: courtyardSlots
};

export const ARCHETYPES = Object.freeze({
  radial: { id: 'radial', label: 'Radial', build: radialSlots },
  ribbon: { id: 'ribbon', label: 'Ribbon', build: ribbonSlots },
  terrace: { id: 'terrace', label: 'Terrace', build: terraceSlots },
  courtyard: { id: 'courtyard', label: 'Courtyard', build: courtyardSlots }
});

export function buildLayout(seed, world, opts = {}) {
  const features = analyzeTerrain(world);
  const archetype = chooseArchetype(seed, features, opts);
  const origin = pickSettlementOrigin(world, features);
  const builder = ARCHETYPE_BUILDERS[archetype] || radialSlots;
  const { slots: rawSlots, anchors: rawAnchors } = builder(origin, features);

  const slots = rawSlots.map((s) => ({
    id: s.id,
    family: s.family,
    footprint: clampFootprint(s.footprint),
    capacity: s.capacity,
    kindAffinity: Array.isArray(s.kindAffinity) ? s.kindAffinity.slice() : []
  }));

  const anchors = {};
  for (const key of Object.keys(rawAnchors)) {
    const a = rawAnchors[key];
    anchors[key] = {
      x: clampInt(Math.round(a.x), 0, GRID_W - 1),
      y: clampInt(Math.round(a.y), 0, GRID_H - 1)
    };
  }

  return {
    archetype,
    origin: { x: origin.x | 0, y: origin.y | 0 },
    anchors,
    slots,
    occupancy: new Map(),
    features: {
      dominantWaterSide: features.dominantWaterSide,
      slope: +features.slope.toFixed(3),
      treeDensityCenter: +features.treeDensityCenter.toFixed(3)
    }
  };
}

export function findSlotForKind(layout, kind, opts = {}) {
  if (!layout || !Array.isArray(layout.slots)) return null;
  const kindToFamily = opts.kindToSlotFamily || DEFAULT_KIND_TO_FAMILY;
  const families = kindToFamily[kind] || [];
  // Prefer slots whose primary family matches the kind, then fall back to any
  // slot that lists the kind in its kindAffinity array.
  for (const family of families) {
    for (const slot of layout.slots) {
      if (slot.family !== family) continue;
      const used = layout.occupancy.get(slot.id) || 0;
      if (used < slot.capacity && slot.kindAffinity.includes(kind)) return slot;
    }
  }
  for (const slot of layout.slots) {
    if (!slot.kindAffinity.includes(kind)) continue;
    const used = layout.occupancy.get(slot.id) || 0;
    if (used < slot.capacity) return slot;
  }
  return null;
}

export function tileInsideSlot(slot, x, y) {
  if (!slot || !slot.footprint) return false;
  const fp = slot.footprint;
  return x >= fp.x && x < fp.x + fp.w && y >= fp.y && y < fp.y + fp.h;
}

// Walk the live buildings list and rebuild layout.occupancy from scratch.
// Called once per planBuildings cycle so claims survive saves/loads (the
// layout itself is recomputed at world-gen, not persisted).
export function recomputeOccupancy(layout, buildings, opts = {}) {
  if (!layout || !Array.isArray(layout.slots)) return;
  layout.occupancy.clear();
  if (!Array.isArray(buildings) || buildings.length === 0) return;
  const kindToFamily = opts.kindToSlotFamily || DEFAULT_KIND_TO_FAMILY;
  for (const b of buildings) {
    if (!b || typeof b.x !== 'number' || typeof b.y !== 'number') continue;
    const families = kindToFamily[b.kind];
    if (!families) continue;
    // Match the building footprint against slot footprints. We accept a slot
    // as the owner of this building if the building's bounding box intersects
    // the slot AND the slot allows this kind.
    let owner = null;
    const fpW = 2;
    const fpH = 2; // current 6 building kinds all share 2x2; planner footprint is authoritative.
    const bRect = { x: b.x, y: b.y, w: fpW, h: fpH };
    for (const slot of layout.slots) {
      if (!slot.kindAffinity.includes(b.kind)) continue;
      if (rectsOverlap(bRect, slot.footprint)) { owner = slot; break; }
    }
    if (!owner) continue;
    const cur = layout.occupancy.get(owner.id) || 0;
    layout.occupancy.set(owner.id, cur + 1);
  }
}

export const __test = {
  isBuildableTile,
  clampFootprint,
  rectsOverlap,
  spiralFind,
  pickSettlementOrigin,
  ARCHETYPE_BUILDERS,
  DEFAULT_KIND_TO_FAMILY
};
