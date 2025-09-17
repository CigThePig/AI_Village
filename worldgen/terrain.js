import { makeNoise2D, mulberry32 } from './noise.js';

const TILES = { GRASS:0, FOREST:1, ROCK:2, WATER:3, FERTILE:4, FARMLAND:5, SAND:6, SNOW:7 };
const DIR4 = [[1,0],[-1,0],[0,1],[0,-1]];
const DIR8 = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];

let GW = 0;
let GH = 0;
let GS = 0;
let baseSeed = 0;
let currentCfg = null;
let RNG_RIVER = null;
let RNG_RESOURCE = null;

export function generateTerrain(seed, cfg, dims) {
  baseSeed = seed >>> 0;
  currentCfg = cfg;
  GW = dims.w|0;
  GH = dims.h|0;
  GS = GW * GH;
  RNG_RIVER = mulberry32((baseSeed ^ 0xA341316C) >>> 0);
  RNG_RESOURCE = mulberry32((baseSeed ^ 0xAD90777D) >>> 0);

  const tiles = new Uint8Array(GS);
  const trees = new Uint8Array(GS);
  const rocks = new Uint8Array(GS);
  const berries = new Uint8Array(GS);

  const t0 = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

  const { height, moisture } = makeHeightMoisture(baseSeed, GW, GH, cfg);
  const waterLevel = adjustWaterLevel(height, cfg);
  const lakeMask = floodFillBasins(height, waterLevel, cfg.water);
  boostMoistureAroundLakes(moisture, lakeMask);
  const { mask: riverMask, traces } = traceRivers(height, cfg.rivers, lakeMask);
  tiles.fill(TILES.GRASS);
  const hydro = applyHydrology(tiles, lakeMask, riverMask);
  const slope = computeSlope(height);
  assignBiomes(tiles, height, moisture, cfg, slope, hydro.shorelineMask);
  const eligibleMask = makeForestMask(tiles);
  const centers = poissonCenters(eligibleMask, cfg.forests.clusterSpacing, baseSeed ^ 0x51633E2D);
  const forestIntensity = growForestBlobs(tiles, moisture, centers, cfg);
  placeResources(trees, rocks, berries, tiles, {
    forestIntensity,
    moisture,
    shoreline: hydro.shorelineMask,
    waterMask: hydro.waterMask
  }, cfg);
  clearSpawnArea(tiles, trees, rocks, berries, Math.floor(GW/2), Math.floor(GH/2), cfg.spawn.radius|0);

  const aux = { height, moisture, riverMask, lakeMask };
  logGenerationStats(tiles, traces, cfg, t0);

  return { tiles, trees, rocks, berries, aux };
}
function makeHeightMoisture(seed, w, h, cfg) {
  const size = w * h;
  const height = new Float32Array(size);
  const moisture = new Float32Array(size);
  const noiseH = makeNoise2D(seed ^ 0x9E3779B9);
  const noiseM = makeNoise2D(seed ^ 0x243F6A88);
  const warpNoise = makeNoise2D(seed ^ 0xB7E15162);

  let minH = Infinity, maxH = -Infinity;
  let minM = Infinity, maxM = -Infinity;
  const lacunarityH = 2.03;
  const gainH = 0.52;
  const octavesH = 5;
  const lacunarityM = 2.11;
  const gainM = 0.54;
  const octavesM = 4;
  const warpStrength = 3.5;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const hVal = noiseH.fbm2D(x, y, cfg.heightScale, octavesH, lacunarityH, gainH);
      height[idx] = hVal;
      if (hVal < minH) minH = hVal;
      if (hVal > maxH) maxH = hVal;

      const warpX = warpNoise.noise2D(x * cfg.warpScale, y * cfg.warpScale) * warpStrength;
      const warpY = warpNoise.noise2D((x + 37.2) * cfg.warpScale, (y - 19.8) * cfg.warpScale) * warpStrength;
      const mVal = noiseM.fbm2D(x + warpX, y + warpY, cfg.moistureScale, octavesM, lacunarityM, gainM);
      moisture[idx] = mVal;
      if (mVal < minM) minM = mVal;
      if (mVal > maxM) maxM = mVal;
    }
  }

  const minHeight = minH;
  const maxHeight = maxH;
  const minMoist = minM;
  const maxMoist = maxM;
  const invRangeH = 1 / (maxHeight - minHeight || 1);
  const invRangeM = 1 / (maxMoist - minMoist || 1);

  minH = Infinity;
  maxH = -Infinity;
  for (let y = 0; y < h; y++) {
    const fy = h > 1 ? (y / (h - 1)) * 2 - 1 : 0;
    for (let x = 0; x < w; x++) {
      const fx = w > 1 ? (x / (w - 1)) * 2 - 1 : 0;
      const idx = y * w + x;
      const radial = Math.max(Math.abs(fx), Math.abs(fy));
      const falloff = 1 - Math.pow(Math.max(0, radial), 3) * 0.5;
      const base = (height[idx] - minHeight) * invRangeH;
      let hVal = base * falloff + 0.08 * (1 - falloff);
      hVal = Math.min(1, Math.max(0, hVal));
      height[idx] = hVal;
      if (hVal < minH) minH = hVal;
      if (hVal > maxH) maxH = hVal;
      const mVal = (moisture[idx] - minMoist) * invRangeM;
      moisture[idx] = Math.min(1, Math.max(0, mVal));
    }
  }

  const rangeH = maxH - minH || 1;
  for (let i = 0; i < size; i++) {
    height[i] = (height[i] - minH) / rangeH;
  }

  return { height, moisture };
}
function adjustWaterLevel(height, cfg) {
  const [targetMin, targetMax] = cfg.ratiosTarget.water;
  const tolerance = 0.03;
  const size = height.length;
  const sorted = Array.from(height);
  sorted.sort((a, b) => a - b);

  const ratioAt = (level) => upperBound(sorted, level) / size;
  const quantile = (ratio) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(ratio * (sorted.length - 1))));
    return sorted[idx];
  };

  let level = cfg.water.level;
  const ratio = ratioAt(level);
  if (ratio < targetMin - tolerance) {
    level = quantile(targetMin);
  } else if (ratio > targetMax + tolerance) {
    level = quantile(targetMax);
  }
  return level;
}
function floodFillBasins(height, threshold, sizeRange) {
  const mask = new Uint8Array(GS);
  const visited = new Uint8Array(GS);
  const stack = [];
  const minSize = sizeRange.minLakeSize | 0;
  const maxSize = sizeRange.maxLakeSize | 0;

  for (let i = 0; i < GS; i++) {
    if (visited[i] || height[i] >= threshold) continue;
    stack.length = 0;
    stack.push(i);
    visited[i] = 1;
    const region = [];
    while (stack.length) {
      const idx = stack.pop();
      region.push(idx);
      const x = idx % GW;
      const y = (idx / GW) | 0;
      for (const [dx, dy] of DIR4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
        const nIdx = ny * GW + nx;
        if (visited[nIdx] || height[nIdx] >= threshold) continue;
        visited[nIdx] = 1;
        stack.push(nIdx);
      }
    }
    if (region.length >= minSize && region.length <= maxSize) {
      for (const idx of region) {
        mask[idx] = 1;
      }
    }
  }
  return mask;
}
function boostMoistureAroundLakes(moisture, lakeMask) {
  const boost = 0.07;
  for (let idx = 0; idx < GS; idx++) {
    if (!lakeMask[idx]) continue;
    const x = idx % GW;
    const y = (idx / GW) | 0;
    for (const [dx, dy] of DIR8) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
      const nIdx = ny * GW + nx;
      if (lakeMask[nIdx]) continue;
      moisture[nIdx] = Math.min(1, moisture[nIdx] + boost);
    }
  }
}
function traceRivers(height, cfg, lakeMask) {
  const mask = new Uint8Array(GS);
  const traces = [];
  const sources = findRiverSources(height, cfg);
  const visitedMarks = new Uint16Array(GS);
  let visitToken = 1;
  const epsilon = 1e-5;

  for (const source of sources) {
    const trace = { length: 0, reachedLake: false, reachedEdge: false };
    let idx = source.idx;
    let x = source.x;
    let y = source.y;
    let steps = 0;
    visitToken++;
    if (visitToken === 0) visitToken = 1;
    const localMark = visitToken;

    while (true) {
      if (visitedMarks[idx] === localMark) {
        break;
      }
      visitedMarks[idx] = localMark;
      steps++;
      trace.length++;
      let width = 1;
      for (const threshold of cfg.widenFlow) {
        if (steps >= threshold) width = Math.min(cfg.maxWidth, width + 1);
      }
      width = Math.max(2, Math.min(cfg.maxWidth, width));
      mask[idx] = Math.max(mask[idx], width);
      if (lakeMask[idx]) {
        trace.reachedLake = true;
        break;
      }
      if (x === 0 || y === 0 || x === GW - 1 || y === GH - 1) {
        trace.reachedEdge = true;
        break;
      }
      const h0 = height[idx];
      let bestHeight = Infinity;
      const candidates = [];
      for (const [dx, dy] of DIR8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
        const nIdx = ny * GW + nx;
        const nh = height[nIdx];
        if (nh > h0 + epsilon) continue;
        if (nh < bestHeight - epsilon) {
          bestHeight = nh;
          candidates.length = 0;
          candidates.push({ idx: nIdx, dx, dy });
        } else if (Math.abs(nh - bestHeight) <= epsilon) {
          candidates.push({ idx: nIdx, dx, dy });
        }
      }
      if (!candidates.length) {
        break;
      }
      const choice = candidates[Math.floor(RNG_RIVER() * candidates.length) % candidates.length];
      const nextIdx = choice.idx;
      const nextX = x + choice.dx;
      const nextY = y + choice.dy;
      if (mask[nextIdx] > 0 && !lakeMask[nextIdx]) {
        mask[nextIdx] = Math.max(mask[nextIdx], width);
        trace.reachedEdge = trace.reachedEdge || nextX === 0 || nextY === 0 || nextX === GW - 1 || nextY === GH - 1;
        break;
      }
      idx = nextIdx;
      x = nextX;
      y = nextY;
    }
    traces.push(trace);
  }
  return { mask, traces };
}
function findRiverSources(height, cfg) {
  const candidates = [];
  for (let idx = 0; idx < GS; idx++) {
    candidates.push(idx);
  }
  candidates.sort((a, b) => height[b] - height[a]);
  const spacing = cfg.sourceSpacing;
  const spacingSq = spacing * spacing;
  const sources = [];
  for (const idx of candidates) {
    const hVal = height[idx];
    if (hVal < cfg.sourceMin) break;
    const x = idx % GW;
    const y = (idx / GW) | 0;
    let isMax = true;
    for (const [dx, dy] of DIR8) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
      const nIdx = ny * GW + nx;
      if (height[nIdx] > hVal) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    let spaced = true;
    for (const src of sources) {
      const dx = src.x - x;
      const dy = src.y - y;
      if (dx * dx + dy * dy < spacingSq) {
        spaced = false;
        break;
      }
    }
    if (!spaced) continue;
    sources.push({ idx, x, y });
    if (sources.length >= cfg.count) break;
  }
  return sources;
}
function applyHydrology(tiles, lakeMask, riverMask) {
  const shorelineMask = new Uint8Array(GS);
  const waterMask = new Uint8Array(GS);
  const radiusCache = new Map();

  for (let idx = 0; idx < GS; idx++) {
    if (lakeMask[idx]) {
      tiles[idx] = TILES.WATER;
      waterMask[idx] = 1;
    }
  }

  for (let idx = 0; idx < GS; idx++) {
    const width = riverMask[idx];
    if (!width) continue;
    const x = idx % GW;
    const y = (idx / GW) | 0;
    const radius = radiusCache.has(width) ? radiusCache.get(width) : Math.max(1, Math.ceil(width / 2));
    radiusCache.set(width, radius);
    const rSq = radius * radius;
    for (let dy = -radius; dy <= radius; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= GH) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= GW) continue;
        if (dx * dx + dy * dy > rSq) continue;
        const nIdx = ny * GW + nx;
        tiles[nIdx] = TILES.WATER;
        waterMask[nIdx] = 1;
      }
    }
  }

  for (let idx = 0; idx < GS; idx++) {
    if (!waterMask[idx]) continue;
    const x = idx % GW;
    const y = (idx / GW) | 0;
    for (const [dx, dy] of DIR4) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
      const nIdx = ny * GW + nx;
      if (!waterMask[nIdx]) shorelineMask[nIdx] = 1;
    }
  }

  return { shorelineMask, waterMask };
}
function computeSlope(height) {
  const slope = new Float32Array(GS);
  for (let idx = 0; idx < GS; idx++) {
    const x = idx % GW;
    const y = (idx / GW) | 0;
    let maxDelta = 0;
    const h0 = height[idx];
    for (const [dx, dy] of DIR8) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
      const delta = Math.abs(height[ny * GW + nx] - h0);
      if (delta > maxDelta) maxDelta = delta;
    }
    slope[idx] = maxDelta;
  }
  return slope;
}
function assignBiomes(tiles, height, moisture, cfg, slope, shorelineMask) {
  const biomes = cfg.biomes;
  for (let idx = 0; idx < GS; idx++) {
    if (tiles[idx] === TILES.WATER) continue;
    const h = height[idx];
    const m = moisture[idx];
    const s = slope[idx];
    if (h > biomes.hSnow) {
      tiles[idx] = TILES.SNOW;
      continue;
    }
    if (h > biomes.hRock && s > biomes.sRock) {
      tiles[idx] = TILES.ROCK;
      continue;
    }
    if (shorelineMask[idx] && m < biomes.mSand) {
      tiles[idx] = TILES.SAND;
      continue;
    }
    if (m > biomes.mFertile) {
      tiles[idx] = TILES.FERTILE;
      continue;
    }
    tiles[idx] = TILES.GRASS;
  }
}
function makeForestMask(tiles) {
  const mask = new Uint8Array(GS);
  for (let idx = 0; idx < GS; idx++) {
    const tile = tiles[idx];
    if (tile === TILES.GRASS) mask[idx] = 1;
  }
  return mask;
}
function poissonCenters(mask, spacing, seed) {
  const rng = mulberry32((seed ^ baseSeed) >>> 0);
  const candidates = [];
  for (let idx = 0; idx < GS; idx++) {
    if (mask[idx]) candidates.push(idx);
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = candidates[i];
    candidates[i] = candidates[j];
    candidates[j] = tmp;
  }
  const spacingSq = spacing * spacing;
  const centers = [];
  for (const idx of candidates) {
    const x = idx % GW;
    const y = (idx / GW) | 0;
    let ok = true;
    for (const center of centers) {
      const dx = center.x - x;
      const dy = center.y - y;
      if (dx * dx + dy * dy < spacingSq) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    centers.push({ x, y });
  }
  return centers;
}
function growForestBlobs(tiles, moisture, centers, cfg) {
  const intensity = new Float32Array(GS);
  const radius = cfg.forests.clusterRadius;
  const radiusSq = radius * radius;
  const sigma = Math.max(1, radius * 0.55);
  const denom = 2 * sigma * sigma;
  const mForest = cfg.biomes.mForest;

  for (const center of centers) {
    const { x: cx, y: cy } = center;
    for (let dy = -radius; dy <= radius; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= GH) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= GW) continue;
        const distSq = dx * dx + dy * dy;
        if (distSq > radiusSq) continue;
        const idx = y * GW + x;
        if (tiles[idx] !== TILES.GRASS) continue;
        if (moisture[idx] <= mForest) continue;
        const value = Math.exp(-distSq / denom);
        if (value > intensity[idx]) intensity[idx] = value;
      }
    }
  }

  const candidates = [];
  for (let idx = 0; idx < GS; idx++) {
    const val = intensity[idx];
    if (val > 0) {
      candidates.push({ idx, val });
    }
  }
  candidates.sort((a, b) => b.val - a.val);

  const totalTiles = GS;
  const [forestMin, forestMax] = currentCfg.ratiosTarget.forest;
  const targetMid = (forestMin + forestMax) * 0.5;
  let desired = Math.min(candidates.length, Math.round(targetMid * totalTiles));
  const minAllowed = Math.min(candidates.length, Math.round(forestMin * totalTiles));
  const maxAllowed = Math.min(candidates.length, Math.round(forestMax * totalTiles));
  if (desired < minAllowed) desired = minAllowed;
  if (desired > maxAllowed) desired = maxAllowed;

  const forestIntensity = new Float32Array(GS);
  for (let i = 0; i < desired; i++) {
    const { idx, val } = candidates[i];
    tiles[idx] = TILES.FOREST;
    forestIntensity[idx] = Math.min(1, val);
  }
  return forestIntensity;
}
function placeResources(trees, rocks, berries, tiles, masks, cfg) {
  const forestIntensity = masks.forestIntensity;
  const moisture = masks.moisture;
  const shoreline = masks.shoreline;
  const waterMask = masks.waterMask;

  const nearWater = new Uint8Array(GS);
  if (waterMask) {
    const radius = 3;
    const rSq = radius * radius;
    for (let idx = 0; idx < GS; idx++) {
      if (!waterMask[idx]) continue;
      const x = idx % GW;
      const y = (idx / GW) | 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= GH) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= GW) continue;
          if (dx * dx + dy * dy > rSq) continue;
          const nIdx = ny * GW + nx;
          if (!waterMask[nIdx]) nearWater[nIdx] = 1;
        }
      }
    }
  }

  const nearForestGrass = new Uint8Array(GS);
  const edgeRadius = 2;
  const edgeSq = edgeRadius * edgeRadius;
  for (let idx = 0; idx < GS; idx++) {
    if (tiles[idx] !== TILES.FOREST) continue;
    const x = idx % GW;
    const y = (idx / GW) | 0;
    for (let dy = -edgeRadius; dy <= edgeRadius; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= GH) continue;
      for (let dx = -edgeRadius; dx <= edgeRadius; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= GW) continue;
        if (dx * dx + dy * dy > edgeSq) continue;
        const nIdx = ny * GW + nx;
        if (tiles[nIdx] === TILES.GRASS) nearForestGrass[nIdx] = 1;
      }
    }
  }

  for (let idx = 0; idx < GS; idx++) {
    if (tiles[idx] !== TILES.FOREST) continue;
    const intensity = forestIntensity[idx] || 0.35;
    let chance = 0.45 + intensity * 0.4;
    if (RNG_RESOURCE() < chance) {
      trees[idx] = 1;
      if (RNG_RESOURCE() < intensity * 0.65) trees[idx] = 2;
    }
  }

  for (let idx = 0; idx < GS; idx++) {
    if (tiles[idx] !== TILES.GRASS || !nearForestGrass[idx]) continue;
    if (RNG_RESOURCE() < 0.06) trees[idx] = 1;
  }

  for (let idx = 0; idx < GS; idx++) {
    if (tiles[idx] !== TILES.ROCK) continue;
    if (RNG_RESOURCE() < 0.68) {
      rocks[idx] = 1;
      if (RNG_RESOURCE() < 0.22) {
        const blob = RNG_RESOURCE() < 0.5 ? 1 : 2;
        let current = idx;
        for (let n = 0; n < blob; n++) {
          const dir = DIR4[Math.floor(RNG_RESOURCE() * DIR4.length) % DIR4.length];
          const x = current % GW;
          const y = (current / GW) | 0;
          const nx = x + dir[0];
          const ny = y + dir[1];
          if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
          const nIdx = ny * GW + nx;
          if (tiles[nIdx] === TILES.ROCK && rocks[nIdx] === 0) {
            rocks[nIdx] = 1;
            current = nIdx;
          }
        }
      }
    }
  }

  for (let idx = 0; idx < GS; idx++) {
    const tile = tiles[idx];
    if (tile !== TILES.FERTILE && tile !== TILES.GRASS) continue;
    const moist = moisture[idx];
    if (tile === TILES.GRASS && moist < 0.55) continue;
    let chance = tile === TILES.FERTILE ? 0.22 : 0.09;
    chance += Math.max(0, moist - 0.6) * 0.25;
    if (nearWater[idx]) chance += 0.08;
    if (shoreline && shoreline[idx]) chance += 0.03;
    if (RNG_RESOURCE() < chance) berries[idx] = 1;
  }
}
function clearSpawnArea(tiles, trees, rocks, berries, cx, cy, r) {
  const radiusSq = r * r;
  for (let y = cy - r; y <= cy + r; y++) {
    if (y < 0 || y >= GH) continue;
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || x >= GW) continue;
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > radiusSq) continue;
      const idx = y * GW + x;
      tiles[idx] = TILES.GRASS;
      trees[idx] = 0;
      rocks[idx] = 0;
      berries[idx] = 0;
    }
  }
  const half = 2;
  for (let y = cy - half; y < cy + half; y++) {
    if (y < 0 || y >= GH) continue;
    for (let x = cx - half; x < cx + half; x++) {
      if (x < 0 || x >= GW) continue;
      const idx = y * GW + x;
      tiles[idx] = TILES.GRASS;
      trees[idx] = 0;
      rocks[idx] = 0;
      berries[idx] = 0;
    }
  }
  for (let y = cy - half - 1; y <= cy + half; y++) {
    if (y < 0 || y >= GH) continue;
    for (let x = cx - half - 1; x <= cx + half; x++) {
      if (x < 0 || x >= GW) continue;
      const idx = y * GW + x;
      tiles[idx] = TILES.GRASS;
      trees[idx] = 0;
      rocks[idx] = 0;
      berries[idx] = 0;
    }
  }
}
function upperBound(arr, value) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= value) lo = mid + 1; else hi = mid;
  }
  return lo;
}
function logGenerationStats(tiles, traces, cfg, startTime) {
  const counts = new Uint32Array(8);
  for (let idx = 0; idx < GS; idx++) {
    counts[tiles[idx]]++;
  }
  const total = GS;
  const ratioLines = [];
  const tolerance = 0.03;
  const ratioMap = {
    water: TILES.WATER,
    forest: TILES.FOREST,
    grass: TILES.GRASS,
    rock: TILES.ROCK
  };
  for (const key of Object.keys(ratioMap)) {
    const tileId = ratioMap[key];
    const ratio = counts[tileId] / total;
    const [minTarget, maxTarget] = cfg.ratiosTarget[key];
    const ok = ratio >= (minTarget - tolerance) && ratio <= (maxTarget + tolerance);
    ratioLines.push(`${key}:${(ratio * 100).toFixed(1)}% (target ${Math.round(minTarget * 100)}-${Math.round(maxTarget * 100)}%) ${ok ? '✔' : '✖'}`);
  }
  console.log('[worldgen] tile ratios', ratioLines.join(', '));

  const lengths = traces.map(t => t.length).filter(len => len > 0);
  const riverCount = traces.length;
  const minLen = lengths.length ? Math.min(...lengths) : 0;
  const medianLen = lengths.length ? calcMedian(lengths) : 0;
  const termini = traces.map(t => t.reachedLake ? 'lake' : (t.reachedEdge ? 'edge' : 'stalled'));
  const terminiSummary = termini.join(', ');
  console.log(`[worldgen] rivers: ${riverCount} (min ${minLen}, median ${medianLen}) termini -> [${terminiSummary}]`);

  const largestRegion = largestGreenRegion(tiles);
  console.log(`[worldgen] largest grass/fertile region: ${largestRegion} tiles (~${Math.sqrt(largestRegion).toFixed(1)}×)`);

  const t1 = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  console.log(`[worldgen] generation time ${(t1 - startTime).toFixed(1)} ms`);
}

function largestGreenRegion(tiles) {
  const visited = new Uint8Array(GS);
  const stack = [];
  let maxRegion = 0;
  for (let idx = 0; idx < GS; idx++) {
    if (visited[idx]) continue;
    const tile = tiles[idx];
    if (tile !== TILES.GRASS && tile !== TILES.FERTILE) continue;
    stack.length = 0;
    stack.push(idx);
    visited[idx] = 1;
    let count = 0;
    while (stack.length) {
      const cur = stack.pop();
      count++;
      const x = cur % GW;
      const y = (cur / GW) | 0;
      for (const [dx, dy] of DIR4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
        const nIdx = ny * GW + nx;
        if (visited[nIdx]) continue;
        const ntile = tiles[nIdx];
        if (ntile !== TILES.GRASS && ntile !== TILES.FERTILE) continue;
        visited[nIdx] = 1;
        stack.push(nIdx);
      }
    }
    if (count > maxRegion) maxRegion = count;
  }
  return maxRegion;
}

function calcMedian(values) {
  if (!values.length) return 0;
  const arr = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 0) {
    return Math.round((arr[mid - 1] + arr[mid]) / 2);
  }
  return arr[mid];
}
