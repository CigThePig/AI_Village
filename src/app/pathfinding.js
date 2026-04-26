import { DIR4, GRID_H, GRID_SIZE, GRID_W, WALKABLE } from './constants.js';
import { clamp } from './rng.js';

export function createPathfinder(deps) {
  const idx = deps.idx;
  const tileOccupiedByBuilding = deps.tileOccupiedByBuilding;
  const getWorld = deps.getWorld;
  const getTick = deps.getTick;
  const perf = deps.perf || { log: false };

  const PF = {
    qx: new Int16Array(GRID_SIZE),
    qy: new Int16Array(GRID_SIZE),
    came: new Int32Array(GRID_SIZE)
  };

  function passable(x, y) {
    const i = idx(x, y);
    if (i < 0) return false;
    if (tileOccupiedByBuilding(x, y)) return false;
    return WALKABLE.has(getWorld().tiles[i]);
  }

  function pathfind(sx, sy, tx, ty, limit = 400) {
    sx = Math.round(clamp(sx, 0, GRID_W - 1));
    sy = Math.round(clamp(sy, 0, GRID_H - 1));
    tx = Math.round(clamp(tx, 0, GRID_W - 1));
    ty = Math.round(clamp(ty, 0, GRID_H - 1));
    const tStart = perf.log ? performance.now() : 0;
    if (sx === tx && sy === ty) {
      if (perf.log && (getTick() % 60) === 0) console.log(`pathfind 0.00ms`);
      return [{ x: tx, y: ty }];
    }
    const Wm = GRID_W, Hm = GRID_H;
    const qx = PF.qx, qy = PF.qy, came = PF.came;
    came.fill(-1);
    let qs = 0, qe = 0;
    qx[qe] = sx; qy[qe] = sy; qe++;
    came[sy * Wm + sx] = sx + sy * Wm;
    let found = false, steps = 0;
    while (qs < qe && steps < limit) {
      const x = qx[qs], y = qy[qs]; qs++; steps++;
      for (const d of DIR4) {
        const nx = x + d[0], ny = y + d[1];
        if (nx < 0 || ny < 0 || nx >= Wm || ny >= Hm) continue;
        const ni = ny * Wm + nx;
        if (came[ni] !== -1) continue;
        if (!passable(nx, ny)) continue;
        came[ni] = y * Wm + x;
        qx[qe] = nx; qy[qe] = ny; qe++;
        if (nx === tx && ny === ty) { found = true; qs = qe; break; }
      }
    }
    if (!found) {
      if (perf.log && (getTick() % 60) === 0) {
        const tEnd = performance.now();
        console.log(`pathfind ${(tEnd - tStart).toFixed(2)}ms`);
      }
      return null;
    }
    const path = [];
    let cx = tx, cy = ty, ci = cy * Wm + cx;
    while (!(cx === sx && cy === sy)) {
      path.push({ x: cx + 0.0001, y: cy + 0.0001 });
      const pi = came[ci];
      if (pi === -1 || !Number.isFinite(pi)) {
        return null;
      }
      cy = (pi / Wm) | 0; cx = pi % Wm; ci = cy * Wm + cx;
    }
    path.reverse();
    if (perf.log && (getTick() % 60) === 0) {
      const tEnd = performance.now();
      console.log(`pathfind ${(tEnd - tStart).toFixed(2)}ms`);
    }
    return path;
  }

  return { passable, pathfind, PF };
}
