import { makeNoise2D, mulberry32 } from './noise.js';
import { SHADING_DEFAULTS } from './config.js';

const TILES = {
  GRASS: 0,
  FOREST: 1,
  ROCK: 2,
  WATER: 3,
  FERTILE: 4,
  FARMLAND: 5,
  SAND: 6,
  SNOW: 7,
  MEADOW: 8,
  MARSH: 9
};

const DIR4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIR8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

let GW = 0;
let GH = 0;
let GS = 0;
let baseSeed = 0;
let RNG_RIVER = null;
let RNG_RESOURCE = null;
let heightField = null;
let moistureField = null;
let riverMeta = [];
let riverConfig = null;

const FOREST_SPACING = 9;
const FOREST_RADIUS = 6;

function idx(x, y) {
  return y * GW + x;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function isEdgeTile(x, y, w, h) {
  return x === 0 || y === 0 || x === w - 1 || y === h - 1;
}

function hash3(x, y, z) {
  let n = (x * 374761393 + y * 668265263 + z * 2147483647 + baseSeed) >>> 0;
  n = (n ^ (n >>> 13)) >>> 0;
  n = (n * 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

export function generateTerrain(seed, cfg, dims) {
  baseSeed = seed >>> 0;
  GW = dims.w | 0;
  GH = dims.h | 0;
  GS = GW * GH;
  RNG_RIVER = mulberry32((baseSeed ^ 0xA341316C) >>> 0);
  RNG_RESOURCE = mulberry32((baseSeed ^ 0xAD90777D) >>> 0);
  riverConfig = cfg.rivers;
  riverMeta = [];

  const tiles = new Uint8Array(GS);
  const trees = new Uint8Array(GS);
  const rocks = new Uint8Array(GS);
  const berries = new Uint8Array(GS);

  const now = typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now();
  const t0 = now();

  const { height, moisture } = makeHeightMoisture(baseSeed, GW, GH, cfg);
  heightField = height;
  moistureField = moisture;

  const lakeMask = floodFillBasins(height, cfg.water.level, cfg.water.minLakeSize, cfg.water.maxLakeSize, GW, GH);
  boostMoistureRing(moisture, lakeMask, GW, GH, 0.07);

  const slope = computeSlope(height, GW, GH);
  const { dir, accum } = flowDirAndAccum(height, GW, GH);
  const riverLines = extractRivers(dir, accum, lakeMask, cfg.rivers, GW, GH);

  for (let i = 0; i < GS; i++) {
    if (lakeMask[i]) {
      tiles[i] = TILES.WATER;
    }
  }

  const riverResult = rasterizeRivers(riverLines, accum, tiles, cfg.rivers, GW, GH);

  const waterMask = new Uint8Array(GS);
  for (let i = 0; i < GS; i++) {
    if (riverResult.riverMask[i] || tiles[i] === TILES.WATER) {
      tiles[i] = TILES.WATER;
      waterMask[i] = 1;
    }
  }
  const shorelineMask = computeShorelineMask(waterMask, GW, GH);

  const masks = {
    water: waterMask,
    shoreline: shorelineMask,
    lake: lakeMask,
    river: riverResult.riverMask
  };

  assignBaseBiomes(tiles, height, moisture, slope, masks, cfg, GW, GH);

  const forestMaskFn = (x, y) => {
    const t = tiles[idx(x, y)];
    return t !== TILES.WATER && t !== TILES.ROCK && t !== TILES.SAND && t !== TILES.SNOW;
  };
  const centers = poissonCenters(forestMaskFn, FOREST_SPACING, baseSeed ^ 0x51633E2D);
  const forestIntensity = growForestBlobs(tiles, moisture, centers, { radius: FOREST_RADIUS }, GW, GH);

  const fertileStats = shapeFertilePatches(tiles, cfg.fertile, GW, GH);

  placeTrees(trees, tiles, forestIntensity, GW, GH);
  const stoneDeposits = ensureRockRatioAndPlaceDeposits(tiles, slope, rocks, cfg.rock, GW, GH);
  const berryTiles = placeBerryClusters(tiles, berries, cfg.fertile, GW, GH);

  clearSpawnArea(tiles, trees, rocks, berries, Math.floor(GW / 2), Math.floor(GH / 2), 4);

  const aux = { height, moisture };

  const duration = now() - t0;

  logGenerationStats({
    tiles,
    rocks,
    berries,
    masks,
    stoneDeposits,
    berryTiles,
    fertileStats,
    duration,
    config: cfg
  });

  return { tiles, trees, rocks, berries, aux };
}
export function makeHeightMoisture(seed, w, h, cfg) {
  const size = w * h;
  const height = new Float32Array(size);
  const moisture = new Float32Array(size);

  const noiseH = makeNoise2D(seed ^ 0x9E3779B9);
  const noiseM = makeNoise2D(seed ^ 0x243F6A88);
  const warpNoise = makeNoise2D(seed ^ 0xB7E15163);

  let minH = Infinity, maxH = -Infinity;
  let minM = Infinity, maxM = -Infinity;
  const octavesH = 5;
  const gainH = 0.52;
  const lacunarityH = 2.05;
  const octavesM = 4;
  const gainM = 0.55;
  const lacunarityM = 2.08;
  const warpAmp = 6.5;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const hVal = noiseH.fbm2D(x, y, cfg.heightScale, octavesH, lacunarityH, gainH);
      height[i] = hVal;
      if (hVal < minH) minH = hVal;
      if (hVal > maxH) maxH = hVal;

      const warpX = warpNoise.noise2D(x * cfg.warpScale, y * cfg.warpScale) * warpAmp;
      const warpY = warpNoise.noise2D((x + 37.2) * cfg.warpScale, (y - 19.8) * cfg.warpScale) * warpAmp;
      const mVal = noiseM.fbm2D(x + warpX, y + warpY, cfg.moistureScale, octavesM, lacunarityM, gainM);
      moisture[i] = mVal;
      if (mVal < minM) minM = mVal;
      if (mVal > maxM) maxM = mVal;
    }
  }

  const invRangeH = 1 / (maxH - minH || 1);
  const invRangeM = 1 / (maxM - minM || 1);

  let fallMin = Infinity, fallMax = -Infinity;
  for (let y = 0; y < h; y++) {
    const fy = h > 1 ? (y / (h - 1)) * 2 - 1 : 0;
    for (let x = 0; x < w; x++) {
      const fx = w > 1 ? (x / (w - 1)) * 2 - 1 : 0;
      const i = y * w + x;
      const radial = Math.sqrt(fx * fx + fy * fy);
      const falloff = clamp(1 - Math.pow(radial, 1.8) * 0.55, 0, 1);
      let hVal = (height[i] - minH) * invRangeH;
      hVal = clamp(hVal * falloff + 0.06 * (1 - falloff), 0, 1);
      height[i] = hVal;
      if (hVal < fallMin) fallMin = hVal;
      if (hVal > fallMax) fallMax = hVal;

      let mVal = (moisture[i] - minM) * invRangeM;
      moisture[i] = clamp(mVal * 0.92 + 0.04, 0, 1);
    }
  }

  const invFall = 1 / (fallMax - fallMin || 1);
  for (let i = 0; i < size; i++) {
    height[i] = clamp((height[i] - fallMin) * invFall, 0, 1);
  }

  return { height, moisture };
}

export function floodFillBasins(height, threshold, minSize, maxSize, w, h) {
  const size = w * h;
  const mask = new Uint8Array(size);
  const visited = new Uint8Array(size);
  const stack = new Int32Array(size);

  for (let i = 0; i < size; i++) {
    if (visited[i] || height[i] >= threshold) continue;
    let top = 0;
    stack[top++] = i;
    visited[i] = 1;
    const region = [];
    while (top > 0) {
      const idx = stack[--top];
      region.push(idx);
      const x = idx % w;
      const y = (idx / w) | 0;
      for (const [dx, dy] of DIR4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nIdx = ny * w + nx;
        if (visited[nIdx] || height[nIdx] >= threshold) continue;
        visited[nIdx] = 1;
        stack[top++] = nIdx;
      }
    }
    if (region.length >= minSize && region.length <= maxSize) {
      for (const idx of region) mask[idx] = 1;
    }
  }
  return mask;
}

export function computeSlope(height, w, h) {
  const size = w * h;
  const slope = new Float32Array(size);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const center = height[i];
      const hx1 = x < w - 1 ? height[i + 1] : center;
      const hx0 = x > 0 ? height[i - 1] : center;
      const hy1 = y < h - 1 ? height[i + w] : center;
      const hy0 = y > 0 ? height[i - w] : center;
      const dx = (hx1 - hx0) * 0.5;
      const dy = (hy1 - hy0) * 0.5;
      let grad = Math.hypot(dx, dy);
      const diag1 = x < w - 1 && y < h - 1 ? Math.abs(center - height[i + w + 1]) : 0;
      const diag2 = x > 0 && y < h - 1 ? Math.abs(center - height[i + w - 1]) : 0;
      const diag3 = x < w - 1 && y > 0 ? Math.abs(center - height[i - w + 1]) : 0;
      const diag4 = x > 0 && y > 0 ? Math.abs(center - height[i - w - 1]) : 0;
      grad = Math.max(grad, diag1 * 0.707, diag2 * 0.707, diag3 * 0.707, diag4 * 0.707);
      slope[i] = grad;
    }
  }
  return slope;
}

export function flowDirAndAccum(height, w, h) {
  const size = w * h;
  const dir = new Uint8Array(size);
  dir.fill(255);
  const accum = new Float32Array(size);
  const order = new Array(size);
  for (let i = 0; i < size; i++) {
    order[i] = i;
    accum[i] = 1;
  }
  const meander = riverConfig ? riverConfig.meanderJitter : 0;
  order.sort((a, b) => height[b] - height[a]);

  for (let i = 0; i < size; i++) {
    const index = i;
    const x = index % w;
    const y = (index / w) | 0;
    const here = height[index];
    let bestDrop = 0;
    let bestDir = 255;
    let bestScore = -Infinity;
    for (let d = 0; d < DIR8.length; d++) {
      const [dx, dy] = DIR8[d];
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nIdx = ny * w + nx;
      const drop = here - height[nIdx];
      if (drop <= 0) continue;
      if (drop > bestDrop + 1e-6) {
        bestDrop = drop;
        bestDir = d;
        bestScore = drop;
      } else if (Math.abs(drop - bestDrop) <= 1e-5 && drop > 0) {
        const jitter = (hash3(x, y, d) - 0.5) * meander * 0.05;
        const score = drop + jitter;
        if (score > bestScore) {
          bestDir = d;
          bestScore = score;
        }
      }
    }
    dir[index] = bestDir;
  }

  for (const i of order) {
    const d = dir[i];
    if (d === 255) continue;
    const x = i % w;
    const y = (i / w) | 0;
    const [dx, dy] = DIR8[d];
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
    const nIdx = ny * w + nx;
    accum[nIdx] += accum[i];
  }
  return { dir, accum };
}

function chooseDownstream(startIdx, x, y, visited, cfg, w, h) {
  const current = heightField[startIdx];
  const meander = cfg.meanderJitter || 0;
  let bestIdx = -1;
  let bestScore = -Infinity;
  for (let d = 0; d < DIR8.length; d++) {
    const [dx, dy] = DIR8[d];
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
    const nIdx = ny * w + nx;
    if (visited[nIdx]) continue;
    const drop = current - heightField[nIdx];
    if (drop < -0.002) continue;
    let score = drop > 0 ? drop : -1e-4;
    if (Math.abs(drop) <= 0.0002) {
      score += (hash3(nx, ny, d) - 0.5) * meander;
    } else if (meander > 0) {
      score += (hash3(nx, ny, d) - 0.5) * meander * 0.15;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = nIdx;
    }
  }
  return bestIdx;
}
export function extractRivers(dir, accum, lakeMask, cfg, w, h) {
  const size = w * h;
  const order = new Array(size);
  for (let i = 0; i < size; i++) order[i] = i;
  order.sort((a, b) => heightField[b] - heightField[a]);

  const sources = [];
  const spacingSq = cfg.sourceSpacing * cfg.sourceSpacing;
  for (const i of order) {
    if (heightField[i] < cfg.sourceMin) break;
    if (lakeMask[i]) continue;
    const x = i % w;
    const y = (i / w) | 0;
    let isPeak = true;
    for (const [dx, dy] of DIR8) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nIdx = ny * w + nx;
      if (heightField[nIdx] + 1e-4 >= heightField[i]) {
        isPeak = false;
        break;
      }
    }
    if (!isPeak) continue;
    let ok = true;
    for (const s of sources) {
      const sx = s % w;
      const sy = (s / w) | 0;
      const dx = sx - x;
      const dy = sy - y;
      if (dx * dx + dy * dy < spacingSq) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    sources.push(i);
    if (sources.length >= cfg.count * 4) break;
  }

  const networkMask = new Uint8Array(size);
  const exitKind = new Uint8Array(size);
  const polylines = [];

  for (const source of sources) {
    if (polylines.length >= cfg.count) break;
    const trace = traceRiver(source, dir, accum, lakeMask, cfg, w, h, networkMask, exitKind);
    if (!trace) continue;
    let points = trace.coords;
    if (cfg.smoothIterations > 0) {
      points = smoothChaikin(points, cfg.smoothIterations);
    }
    polylines.push(points);
    for (const idx of trace.indices) {
      networkMask[idx] = 1;
      exitKind[idx] = trace.exit === 'lake' ? 2 : 1;
    }
    riverMeta.push({ length: trace.indices.length, exit: trace.exit });
  }

  return polylines;
}

function traceRiver(source, dir, accum, lakeMask, cfg, w, h, networkMask, exitKind) {
  const visited = new Uint8Array(w * h);
  let idx = source;
  let exit = null;
  const pathIdx = [];
  const pathCoords = [];
  const threshold = cfg.accumThreshold;

  for (let steps = 0; steps < w * h; steps++) {
    const x = idx % w;
    const y = (idx / w) | 0;
    pathIdx.push(idx);
    pathCoords.push([x, y]);

    if (lakeMask[idx]) {
      exit = 'lake';
      break;
    }
    if (networkMask[idx] && pathIdx.length > 1) {
      exit = exitKind[idx] === 2 ? 'lake' : 'edge';
      break;
    }
    if (isEdgeTile(x, y, w, h)) {
      exit = 'edge';
      break;
    }

    let d = dir[idx];
    let nextIdx = -1;
    if (d !== 255) {
      const [dx, dy] = DIR8[d];
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h) {
        nextIdx = ny * w + nx;
        const drop = heightField[idx] - heightField[nextIdx];
        if (drop < 1e-4) {
          const alt = chooseDownstream(idx, x, y, visited, cfg, w, h);
          if (alt !== -1) nextIdx = alt;
        }
      }
    } else {
      nextIdx = chooseDownstream(idx, x, y, visited, cfg, w, h);
    }

    if (nextIdx === -1) {
      exit = isEdgeTile(x, y, w, h) ? 'edge' : (lakeMask[idx] ? 'lake' : exit);
      break;
    }

    if (visited[nextIdx]) {
      exit = exit || (lakeMask[nextIdx] ? 'lake' : 'edge');
      break;
    }

    visited[nextIdx] = 1;
    idx = nextIdx;
  }

  if (!exit) {
    exit = lakeMask[idx] ? 'lake' : 'edge';
  }

  let start = -1;
  for (let i = 0; i < pathIdx.length; i++) {
    if (accum[pathIdx[i]] >= threshold) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  const trimmedIdx = pathIdx.slice(start);
  const trimmedCoords = pathCoords.slice(start);
  const lastIdx = trimmedIdx[trimmedIdx.length - 1];
  const lx = lastIdx % w;
  const ly = (lastIdx / w) | 0;
  if (lakeMask[lastIdx]) exit = 'lake';
  else if (exitKind[lastIdx]) exit = exitKind[lastIdx] === 2 ? 'lake' : 'edge';
  else if (isEdgeTile(lx, ly, w, h)) exit = 'edge';

  return { indices: trimmedIdx, coords: trimmedCoords, exit };
}

export function smoothChaikin(points, iterations) {
  let pts = points.map(p => [p[0], p[1]]);
  for (let iter = 0; iter < iterations; iter++) {
    if (pts.length < 2) break;
    const next = [];
    next.push(pts[0]);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      const q = [p0[0] * 0.75 + p1[0] * 0.25, p0[1] * 0.75 + p1[1] * 0.25];
      const r = [p0[0] * 0.25 + p1[0] * 0.75, p0[1] * 0.25 + p1[1] * 0.75];
      next.push(q, r);
    }
    next.push(pts[pts.length - 1]);
    pts = next;
  }
  return pts;
}

export function rasterizeRivers(polylines, accum, tiles, cfg, w, h) {
  const riverMask = new Uint8Array(w * h);
  const widthCache = new Uint8Array(w * h);

  const paint = (x, y, idx) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const centerIdx = y * w + x;
    const width = getWidth(centerIdx, accum, cfg, widthCache);
    const radius = Math.max(0, (width - 1) * 0.5);
    const ceilR = Math.ceil(radius);
    for (let oy = -ceilR; oy <= ceilR; oy++) {
      for (let ox = -ceilR; ox <= ceilR; ox++) {
        const tx = x + ox;
        const ty = y + oy;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        const dist = Math.hypot(ox, oy);
        if (dist <= radius + 0.3) {
          const tIdx = ty * w + tx;
          tiles[tIdx] = TILES.WATER;
          riverMask[tIdx] = 1;
        }
      }
    }
    tiles[centerIdx] = TILES.WATER;
    riverMask[centerIdx] = 1;
  };

  for (const poly of polylines) {
    if (!poly || poly.length === 0) continue;
    let prev = poly[0];
    paint(Math.round(prev[0]), Math.round(prev[1]), idx(Math.round(prev[0]), Math.round(prev[1])));
    for (let i = 1; i < poly.length; i++) {
      const cur = poly[i];
      const dx = cur[0] - prev[0];
      const dy = cur[1] - prev[1];
      const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) * 2));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const sx = prev[0] + dx * t;
        const sy = prev[1] + dy * t;
        paint(Math.round(sx), Math.round(sy), idx(Math.round(sx), Math.round(sy)));
      }
      prev = cur;
    }
  }

  return { riverMask };
}
export function assignBaseBiomes(tiles, height, moisture, slope, masks, cfg, w, h) {
  const size = w * h;
  const shoreline = masks.shoreline;

  for (let i = 0; i < size; i++) {
    if (tiles[i] !== TILES.WATER) tiles[i] = TILES.GRASS;
  }

  const SNOW_HEIGHT = 0.82;
  let hRock = 0.7;
  let sRock = 0.07;
  let rockRatio = 0;

  for (let i = 0; i < size; i++) {
    if (tiles[i] !== TILES.WATER && height[i] >= SNOW_HEIGHT) tiles[i] = TILES.SNOW;
  }

  for (let iter = 0; iter < 3; iter++) {
    for (let i = 0; i < size; i++) {
      if (tiles[i] !== TILES.WATER && tiles[i] !== TILES.SNOW) tiles[i] = TILES.GRASS;
    }
    let rockCount = 0;
    for (let i = 0; i < size; i++) {
      if (tiles[i] === TILES.WATER || tiles[i] === TILES.SNOW) continue;
      if (height[i] >= hRock || slope[i] >= sRock) {
        tiles[i] = TILES.ROCK;
        rockCount++;
      }
    }
    rockRatio = rockCount / size;
    if (rockRatio < cfg.rock.targetRatio - 0.02) {
      hRock = Math.max(0.4, hRock - 0.02);
      sRock = Math.max(0.01, sRock - 0.01);
    } else if (rockRatio > cfg.rock.targetRatio + 0.02) {
      hRock = Math.min(0.9, hRock + 0.02);
      sRock = Math.min(0.2, sRock + 0.01);
    } else {
      break;
    }
  }

  for (let i = 0; i < size; i++) {
    if (tiles[i] === TILES.GRASS && shoreline[i] && moisture[i] < 0.35) {
      tiles[i] = TILES.SAND;
    }
  }

  for (let i = 0; i < size; i++) {
    if (tiles[i] === TILES.GRASS && shoreline[i] && moisture[i] >= 0.65) {
      tiles[i] = TILES.MARSH;
    }
  }

  for (let i = 0; i < size; i++) {
    if (tiles[i] === TILES.GRASS && !shoreline[i]) {
      if (slope[i] < 0.03 && moisture[i] >= 0.45 && moisture[i] <= 0.65) {
        tiles[i] = TILES.MEADOW;
      }
    }
  }

  for (let i = 0; i < size; i++) {
    if ((tiles[i] === TILES.GRASS || tiles[i] === TILES.MEADOW) && !shoreline[i] && moisture[i] > 0.63) {
      tiles[i] = TILES.FERTILE;
    }
  }
}

export function shapeFertilePatches(tiles, cfg, w, h) {
  const size = w * h;
  const visited = new Uint8Array(size);
  const queue = new Int32Array(size);
  const regionMask = new Uint8Array(size);
  const stats = { count: 0, total: 0, max: 0, avg: 0 };

  for (let i = 0; i < size; i++) {
    if (visited[i] || tiles[i] !== TILES.FERTILE) continue;
    let head = 0, tail = 0;
    queue[tail++] = i;
    visited[i] = 1;
    const region = [];
    while (head < tail) {
      const idx = queue[head++];
      region.push(idx);
      const x = idx % w;
      const y = (idx / w) | 0;
      for (const [dx, dy] of DIR4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nIdx = ny * w + nx;
        if (visited[nIdx] || tiles[nIdx] !== TILES.FERTILE) continue;
        visited[nIdx] = 1;
        queue[tail++] = nIdx;
      }
    }

    for (const idx of region) regionMask[idx] = 1;
    let area = region.length;

    if (area < cfg.areaMin) {
      for (const idx of region) {
        tiles[idx] = TILES.GRASS;
        regionMask[idx] = 0;
      }
      continue;
    }

    while (area > cfg.areaMax) {
      const erode = [];
      for (const idx of region) {
        if (!regionMask[idx]) continue;
        const x = idx % w;
        const y = (idx / w) | 0;
        let edge = false;
        for (const [dx, dy] of DIR4) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) { edge = true; break; }
          const nIdx = ny * w + nx;
          if (!regionMask[nIdx]) { edge = true; break; }
        }
        if (edge) erode.push(idx);
      }
      if (!erode.length) break;
      for (const idx of erode) {
        tiles[idx] = TILES.GRASS;
        if (regionMask[idx]) {
          regionMask[idx] = 0;
          area--;
        }
      }
    }

    for (let pass = 0; pass < (cfg.edgeFeather | 0); pass++) {
      const soften = [];
      for (const idx of region) {
        if (!regionMask[idx]) continue;
        const x = idx % w;
        const y = (idx / w) | 0;
        let neighbors = 0;
        for (const [dx, dy] of DIR8) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nIdx = ny * w + nx;
          if (regionMask[nIdx]) neighbors++;
        }
        if (neighbors <= 4) soften.push(idx);
      }
      if (!soften.length) break;
      for (const idx of soften) {
        tiles[idx] = TILES.GRASS;
        if (regionMask[idx]) {
          regionMask[idx] = 0;
          area--;
        }
      }
    }

    if (area > 0) {
      stats.count++;
      stats.total += area;
      if (area > stats.max) stats.max = area;
    }

    for (const idx of region) regionMask[idx] = 0;
  }

  if (stats.count > 0) stats.avg = stats.total / stats.count;
  return stats;
}
export function poissonCenters(maskFn, spacing, seed) {
  const result = [];
  const indices = new Array(GS);
  for (let i = 0; i < GS; i++) indices[i] = i;
  const rng = mulberry32(seed >>> 0);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = indices[i];
    indices[i] = indices[j];
    indices[j] = tmp;
  }
  const spacingSq = spacing * spacing;
  for (const idx of indices) {
    const x = idx % GW;
    const y = (idx / GW) | 0;
    if (!maskFn(x, y)) continue;
    let ok = true;
    for (const [cx, cy] of result) {
      const dx = cx - x;
      const dy = cy - y;
      if (dx * dx + dy * dy < spacingSq) {
        ok = false;
        break;
      }
    }
    if (ok) result.push([x, y]);
  }
  return result;
}

export function growForestBlobs(tiles, moisture, centers, cfg, w, h) {
  const size = w * h;
  const intensity = new Float32Array(size);
  const radius = cfg.radius || 6;
  const radiusSq = radius * radius;
  const sigma = radius * 0.6;
  const denom = 2 * sigma * sigma;

  for (const [cx, cy] of centers) {
    const minX = Math.max(0, cx - radius);
    const maxX = Math.min(w - 1, cx + radius);
    const minY = Math.max(0, cy - radius);
    const maxY = Math.min(h - 1, cy + radius);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const distSq = dx * dx + dy * dy;
        if (distSq > radiusSq) continue;
        const idx = y * w + x;
        if (tiles[idx] === TILES.WATER || tiles[idx] === TILES.ROCK || tiles[idx] === TILES.SAND || tiles[idx] === TILES.SNOW) continue;
        if (moisture[idx] <= 0.55) continue;
        const weight = Math.exp(-distSq / denom);
        if (weight > intensity[idx]) intensity[idx] = weight;
      }
    }
  }

  for (let i = 0; i < size; i++) {
    if (intensity[i] > 0.12 && tiles[i] !== TILES.WATER && tiles[i] !== TILES.ROCK && tiles[i] !== TILES.SAND && tiles[i] !== TILES.SNOW) {
      tiles[i] = TILES.FOREST;
    }
  }

  return intensity;
}
export function placeTrees(trees, tiles, intensity, w, h) {
  const size = w * h;
  const edgeStrength = new Float32Array(size);

  for (let i = 0; i < size; i++) {
    if (tiles[i] !== TILES.FOREST) continue;
    const strength = clamp(intensity[i], 0, 1);
    let count = strength > 0.75 ? 2 : 1;
    if (strength > 0.55 && RNG_RESOURCE() < strength) count = Math.min(2, count + 1);
    trees[i] = count;
    const x = i % w;
    const y = (i / w) | 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nIdx = ny * w + nx;
        const dist = Math.hypot(dx, dy);
        const falloff = Math.max(0, strength - dist * 0.25);
        if (falloff > edgeStrength[nIdx]) edgeStrength[nIdx] = falloff;
      }
    }
  }

  for (let i = 0; i < size; i++) {
    if (trees[i] > 0) continue;
    const tile = tiles[i];
    if (tile !== TILES.GRASS && tile !== TILES.MEADOW) continue;
    const strength = edgeStrength[i];
    if (strength <= 0.18) continue;
    if (RNG_RESOURCE() < strength * 0.35) {
      trees[i] = 1;
    }
  }
}

export function ensureRockRatioAndPlaceDeposits(tiles, slope, rocks, cfg, w, h) {
  const size = w * h;
  const rockTiles = [];
  for (let i = 0; i < size; i++) {
    if (tiles[i] === TILES.ROCK) rockTiles.push(i);
    rocks[i] = 0;
  }
  let placed = 0;

  for (const idx of rockTiles) {
    if (RNG_RESOURCE() < cfg.pOnRock) {
      const amount = 2 + (RNG_RESOURCE() < 0.45 ? 1 : 0);
      rocks[idx] = amount;
      placed++;
      if (RNG_RESOURCE() < cfg.blobChance) {
        const x = idx % w;
        const y = (idx / w) | 0;
        for (const [dx, dy] of DIR4) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nIdx = ny * w + nx;
          if (tiles[nIdx] === TILES.ROCK && rocks[nIdx] === 0) {
            rocks[nIdx] = Math.max(1, amount - 1);
            placed++;
            break;
          }
        }
      }
    }
  }

  if (placed < cfg.ensureMinDeposits && rockTiles.length > 0) {
    const sorted = rockTiles.slice().sort((a, b) => slope[b] - slope[a]);
    const guard = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      if (rocks[i] > 0) markGuard(guard, i, w, h, 2);
    }
    for (const idx of sorted) {
      if (placed >= cfg.ensureMinDeposits) break;
      if (rocks[idx] > 0) continue;
      if (guard[idx]) continue;
      const amount = 2 + (RNG_RESOURCE() < 0.5 ? 1 : 0);
      rocks[idx] = amount;
      placed++;
      markGuard(guard, idx, w, h, 2);
    }
  }

  return placed;
}

export function placeBerryClusters(tiles, berries, fertileCfg, w, h) {
  const size = w * h;
  berries.fill(0);
  const radius = fertileCfg.clusterRadius | 0;
  const radiusSq = radius * radius;
  const baseP = fertileCfg.berryBaseP;
  const targetCenters = Math.max(1, Math.round((size / 1000) * fertileCfg.clusterCentersPer1k));
  const candidates = [];
  const rngScores = [];

  for (let i = 0; i < size; i++) {
    const t = tiles[i];
    if (t === TILES.FERTILE) {
      candidates.push(i);
      rngScores.push(2);
    } else if ((t === TILES.GRASS || t === TILES.MEADOW) && hasNearbyFertile(tiles, i, w, h)) {
      candidates.push(i);
      rngScores.push(1);
    }
  }

  if (!candidates.length) return 0;

  const order = candidates.map((idx, i) => {
    const x = idx % w;
    const y = (idx / w) | 0;
    let local = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const distSq = dx * dx + dy * dy;
        if (distSq > radiusSq) continue;
        const nIdx = ny * w + nx;
        if (tiles[nIdx] === TILES.FERTILE) local++;
      }
    }
    const jitter = RNG_RESOURCE() * 0.1;
    return { idx, score: rngScores[i] + local * 0.12 + jitter };
  });

  order.sort((a, b) => b.score - a.score);
  const centers = [];
  const spacingSq = radiusSq * 0.6;
  for (const entry of order) {
    const x = entry.idx % w;
    const y = (entry.idx / w) | 0;
    let ok = true;
    for (const c of centers) {
      const dx = c.x - x;
      const dy = c.y - y;
      if (dx * dx + dy * dy < spacingSq) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    centers.push({ x, y, idx: entry.idx });
    if (centers.length >= targetCenters) break;
  }
  if (!centers.length) {
    const first = order[0];
    centers.push({ x: first.idx % w, y: (first.idx / w) | 0, idx: first.idx });
  }

  for (const center of centers) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = center.x + dx;
        const y = center.y + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const distSq = dx * dx + dy * dy;
        if (distSq > radiusSq) continue;
        const tileIdx = y * w + x;
        if (!isBerryTile(tiles[tileIdx])) continue;
        const r = Math.sqrt(distSq);
        const prob = baseP * Math.exp(-(r * r) / (2 * radiusSq));
        if (RNG_RESOURCE() < prob) {
          berries[tileIdx] = Math.max(berries[tileIdx], 1 + (tiles[tileIdx] === TILES.FERTILE && RNG_RESOURCE() < 0.35 ? 1 : 0));
        }
      }
    }
  }

  let berryTiles = 0;
  for (let i = 0; i < size; i++) {
    if (berries[i] > 0) berryTiles++;
  }
  return berryTiles;
}

export function clearSpawnArea(tiles, trees, rocks, berries, cx, cy, r) {
  const radiusSq = r * r;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= GW || y >= GH) continue;
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
  for (let y = cy - 1; y <= cy + 2; y++) {
    for (let x = cx - 1; x <= cx + 2; x++) {
      if (x < 0 || y < 0 || x >= GW || y >= GH) continue;
      const idx = y * GW + x;
      tiles[idx] = TILES.GRASS;
      trees[idx] = 0;
      rocks[idx] = 0;
      berries[idx] = 0;
    }
  }
}
function boostMoistureRing(moisture, mask, w, h, amount) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!mask[idx]) continue;
      for (const [dx, dy] of DIR8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nIdx = ny * w + nx;
        if (mask[nIdx]) continue;
        moisture[nIdx] = Math.min(1, moisture[nIdx] + amount);
      }
    }
  }
}

function computeShorelineMask(waterMask, w, h) {
  const shoreline = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!waterMask[idx]) continue;
      for (const [dx, dy] of DIR8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nIdx = ny * w + nx;
        if (!waterMask[nIdx]) shoreline[nIdx] = 1;
      }
    }
  }
  return shoreline;
}

function getWidth(idx, accum, cfg, cache) {
  if (idx < 0 || idx >= cache.length) return 1;
  let w = cache[idx];
  if (!w) {
    const flow = Math.max(1, accum[idx]);
    w = 1 + Math.floor(cfg.widenK * Math.log1p(flow));
    w = clamp(w, 1, cfg.maxWidth | 0);
    cache[idx] = w;
  }
  return w;
}

function markGuard(mask, idx, w, h, radius) {
  const x0 = idx % w;
  const y0 = (idx / w) | 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = x0 + dx;
      const ny = y0 + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nIdx = ny * w + nx;
      mask[nIdx] = 1;
    }
  }
}

function hasNearbyFertile(tiles, idx, w, h) {
  const x = idx % w;
  const y = (idx / w) | 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nIdx = ny * w + nx;
      if (tiles[nIdx] === TILES.FERTILE) return true;
    }
  }
  return false;
}

function isBerryTile(tile) {
  return tile === TILES.FERTILE || tile === TILES.GRASS || tile === TILES.MEADOW;
}

function largestClearingArea(tiles, w, h) {
  const size = w * h;
  const visited = new Uint8Array(size);
  const stack = new Int32Array(size);
  let best = 0;
  for (let i = 0; i < size; i++) {
    if (visited[i]) continue;
    const tile = tiles[i];
    if (tile !== TILES.GRASS && tile !== TILES.MEADOW) continue;
    let top = 0;
    stack[top++] = i;
    visited[i] = 1;
    let area = 0;
    while (top > 0) {
      const idx = stack[--top];
      area++;
      const x = idx % w;
      const y = (idx / w) | 0;
      for (const [dx, dy] of DIR4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nIdx = ny * w + nx;
        if (visited[nIdx]) continue;
        const t = tiles[nIdx];
        if (t !== TILES.GRASS && t !== TILES.MEADOW) continue;
        visited[nIdx] = 1;
        stack[top++] = nIdx;
      }
    }
    if (area > best) best = area;
  }
  return best;
}

function countOnes(mask) {
  let total = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) total++;
  return total;
}

export function makeHillshade(height, w, h, cfg = SHADING_DEFAULTS) {
  const size = w * h;
  const shade = new Float32Array(size);
  if (!height || height.length !== size || size === 0) {
    return shade;
  }

  const ambient = clamp(typeof cfg?.ambient === 'number' ? cfg.ambient : SHADING_DEFAULTS.ambient, 0, 1);
  const intensity = clamp(typeof cfg?.intensity === 'number' ? cfg.intensity : SHADING_DEFAULTS.intensity, 0, 1);
  shade.fill(ambient);

  if (w < 3 || h < 3) {
    return shade;
  }

  let lx = -0.75;
  let ly = -0.65;
  let lz = 0.45;
  const ln = Math.hypot(lx, ly, lz) || 1;
  lx /= ln;
  ly /= ln;
  lz /= ln;

  const normalZ = 4;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const north = i - w;
      const south = i + w;
      const h00 = height[north - 1];
      const h01 = height[north];
      const h02 = height[north + 1];
      const h10 = height[i - 1];
      const h12 = height[i + 1];
      const h20 = height[south - 1];
      const h21 = height[south];
      const h22 = height[south + 1];

      const gx = (h02 + 2 * h12 + h22) - (h00 + 2 * h10 + h20);
      const gy = (h20 + 2 * h21 + h22) - (h00 + 2 * h01 + h02);

      let nx = -gx;
      let ny = -gy;
      let nz = normalZ;
      const invLen = 1 / Math.hypot(nx, ny, nz);
      nx *= invLen;
      ny *= invLen;
      nz *= invLen;

      let lambert = nx * lx + ny * ly + nz * lz;
      if (lambert < -1) lambert = -1;
      else if (lambert > 1) lambert = 1;
      const lit = clamp(ambient + intensity * lambert, 0, 1);
      shade[i] = lit;
    }
  }

  if (h > 1) {
    for (let x = 0; x < w; x++) {
      shade[x] = shade[w + x];
      const lastRow = (h - 1) * w;
      shade[lastRow + x] = shade[lastRow - w + x];
    }
  }

  if (w > 1) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      shade[row] = shade[row + 1];
      shade[row + w - 1] = shade[row + w - 2];
    }
  }

  return shade;
}

function logGenerationStats(ctx) {
  const { tiles, rocks, berries, masks, stoneDeposits, berryTiles, fertileStats, duration, config } = ctx;
  const size = tiles.length;
  const counts = new Array(10).fill(0);
  for (let i = 0; i < size; i++) counts[tiles[i]]++;
  const pct = (type) => Number(((counts[type] / size) * 100).toFixed(2));
  const rockRatio = counts[TILES.ROCK] / size;
  const lengths = riverMeta.map(r => r.length).sort((a, b) => a - b);
  const minLen = lengths.length ? lengths[0] : 0;
  const medianLen = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0;
  const riversReach = riverMeta.every(r => r.exit === 'edge' || r.exit === 'lake');
  const largestClearing = largestClearingArea(tiles, GW, GH);
  const berriesPer1k = size > 0 ? (berryTiles / (size / 1000)) : 0;

  console.log('[worldgen]', {
    coverage: {
      water: pct(TILES.WATER),
      rock: pct(TILES.ROCK),
      forest: pct(TILES.FOREST),
      fertile: pct(TILES.FERTILE),
      meadow: pct(TILES.MEADOW),
      marsh: pct(TILES.MARSH),
      grass: pct(TILES.GRASS)
    },
    rockRatioWithinTolerance: Math.abs(rockRatio - config.rock.targetRatio) <= 0.02,
    stoneDeposits,
    rivers: {
      count: riverMeta.length,
      minLength: minLen,
      medianLength: medianLen,
      reachEdgeOrLake: riversReach
    },
    largestClearing: {
      tiles: largestClearing,
      meets18x18: largestClearing >= 18 * 18
    },
    fertilePatches: {
      count: fertileStats.count,
      avgSize: Number(fertileStats.avg.toFixed(2)),
      maxSize: fertileStats.max
    },
    berriesPer1k: Number(berriesPer1k.toFixed(2)),
    generationMs: Number(duration.toFixed(2))
  });
}
