import { DIR4, GRID_H, GRID_SIZE, GRID_W, WALKABLE } from './constants.js';
import { clamp } from './rng.js';

export function createPathfinder(deps) {
  const idx = deps.idx;
  const tileOccupiedByBuilding = deps.tileOccupiedByBuilding;
  const getWorld = deps.getWorld;
  const getTick = deps.getTick;
  const perf = deps.perf || { log: false };

  // Phase 12: A* uses gScore + heap; BFS region search reuses qx/qy.
  // `touched` lets us reset only the cells we wrote, avoiding 36k-entry
  // .fill()s per call.
  const PF = {
    qx: new Int16Array(GRID_SIZE),
    qy: new Int16Array(GRID_SIZE),
    came: new Int32Array(GRID_SIZE),
    gScore: new Int32Array(GRID_SIZE),
    heapNode: new Int32Array(GRID_SIZE + 1),
    heapF: new Int32Array(GRID_SIZE + 1),
    touched: new Int32Array(GRID_SIZE),
  };

  function passable(x, y) {
    const i = idx(x, y);
    if (i < 0) return false;
    if (tileOccupiedByBuilding(x, y)) return false;
    return WALKABLE.has(getWorld().tiles[i]);
  }

  function logTime(tStart) {
    if (!perf.log) return;
    if ((getTick() % 60) !== 0) return;
    const tEnd = performance.now();
    console.log(`pathfind ${(tEnd - tStart).toFixed(2)}ms`);
  }

  function resetTouched(touchedCount) {
    const touched = PF.touched;
    const came = PF.came;
    const gScore = PF.gScore;
    for (let t = 0; t < touchedCount; t++) {
      const ti = touched[t];
      came[ti] = -1;
      gScore[ti] = -1;
    }
  }

  // Binary min-heap on parallel Int32Arrays of (f, node). Lower f wins; ties
  // are left to insertion order (good enough for grid pathfinding correctness).
  function heapPush(size, fScore, node) {
    let i = ++size;
    PF.heapF[i] = fScore;
    PF.heapNode[i] = node;
    while (i > 1) {
      const parent = i >> 1;
      if (PF.heapF[parent] <= PF.heapF[i]) break;
      const tmpF = PF.heapF[parent], tmpN = PF.heapNode[parent];
      PF.heapF[parent] = PF.heapF[i]; PF.heapNode[parent] = PF.heapNode[i];
      PF.heapF[i] = tmpF; PF.heapNode[i] = tmpN;
      i = parent;
    }
    return size;
  }

  function heapPop(size) {
    const top = PF.heapNode[1];
    PF.heapF[1] = PF.heapF[size];
    PF.heapNode[1] = PF.heapNode[size];
    size--;
    let i = 1;
    while (true) {
      const l = i << 1;
      const r = l + 1;
      let smallest = i;
      if (l <= size && PF.heapF[l] < PF.heapF[smallest]) smallest = l;
      if (r <= size && PF.heapF[r] < PF.heapF[smallest]) smallest = r;
      if (smallest === i) break;
      const tmpF = PF.heapF[i], tmpN = PF.heapNode[i];
      PF.heapF[i] = PF.heapF[smallest]; PF.heapNode[i] = PF.heapNode[smallest];
      PF.heapF[smallest] = tmpF; PF.heapNode[smallest] = tmpN;
      i = smallest;
    }
    return { node: top, size };
  }

  function reconstructPath(sx, sy, tx, ty) {
    const Wm = GRID_W;
    const came = PF.came;
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
    return path;
  }

  // Phase 12 (S12): A* with Manhattan heuristic. Path length is identical to
  // the previous BFS (4-connected uniform cost; Manhattan is admissible &
  // consistent), but expansions on long open paths drop ~5–10×.
  function pathfind(sx, sy, tx, ty, limit = 400) {
    sx = Math.round(clamp(sx, 0, GRID_W - 1));
    sy = Math.round(clamp(sy, 0, GRID_H - 1));
    tx = Math.round(clamp(tx, 0, GRID_W - 1));
    ty = Math.round(clamp(ty, 0, GRID_H - 1));
    const tStart = perf.log ? performance.now() : 0;
    if (sx === tx && sy === ty) {
      logTime(tStart);
      return [{ x: tx, y: ty }];
    }
    const Wm = GRID_W, Hm = GRID_H;
    const came = PF.came, gScore = PF.gScore, touched = PF.touched;
    let touchedCount = 0;

    const startI = sy * Wm + sx;
    came[startI] = startI;
    gScore[startI] = 0;
    touched[touchedCount++] = startI;

    let heapSize = 0;
    const startH = Math.abs(sx - tx) + Math.abs(sy - ty);
    heapSize = heapPush(heapSize, startH, startI);

    let found = false;
    let expansions = 0;
    while (heapSize > 0 && expansions < limit) {
      const popped = heapPop(heapSize);
      heapSize = popped.size;
      const ci = popped.node;
      const cx = ci % Wm;
      const cy = (ci / Wm) | 0;
      expansions++;
      if (cx === tx && cy === ty) { found = true; break; }
      const cg = gScore[ci];
      for (const d of DIR4) {
        const nx = cx + d[0], ny = cy + d[1];
        if (nx < 0 || ny < 0 || nx >= Wm || ny >= Hm) continue;
        const ni = ny * Wm + nx;
        if (came[ni] !== -1) continue;
        if (!passable(nx, ny)) continue;
        came[ni] = ci;
        gScore[ni] = cg + 1;
        touched[touchedCount++] = ni;
        const f = (cg + 1) + Math.abs(nx - tx) + Math.abs(ny - ty);
        heapSize = heapPush(heapSize, f, ni);
      }
    }

    if (!found) {
      resetTouched(touchedCount);
      logTime(tStart);
      return null;
    }
    const path = reconstructPath(sx, sy, tx, ty);
    resetTouched(touchedCount);
    logTime(tStart);
    return path;
  }

  // Phase 12 (B23): single search that terminates on the first walkable tile
  // matching `isTarget`. Replaces findHuntApproachPath's 9×9 pathfind loop.
  // If a `heuristic(x,y)` is provided, runs A* with that as the f-score
  // heuristic (admissible heuristic guarantees first-hit is optimal in step
  // count); otherwise falls back to BFS, which is also optimal but expands
  // radially.
  function pathfindToRegion(sx, sy, isTarget, limit = 400, heuristic = null) {
    sx = Math.round(clamp(sx, 0, GRID_W - 1));
    sy = Math.round(clamp(sy, 0, GRID_H - 1));
    const tStart = perf.log ? performance.now() : 0;
    if (typeof isTarget !== 'function') return null;
    const Wm = GRID_W, Hm = GRID_H;
    const came = PF.came, gScore = PF.gScore, touched = PF.touched;
    let touchedCount = 0;
    const startI = sy * Wm + sx;
    came[startI] = startI;
    gScore[startI] = 0;
    touched[touchedCount++] = startI;

    let foundX = -1, foundY = -1;
    if (isTarget(sx, sy)) { foundX = sx; foundY = sy; }

    if (foundX < 0) {
      const useAStar = typeof heuristic === 'function';
      if (useAStar) {
        let heapSize = 0;
        heapSize = heapPush(heapSize, heuristic(sx, sy) | 0, startI);
        let expansions = 0;
        while (heapSize > 0 && expansions < limit && foundX < 0) {
          const popped = heapPop(heapSize);
          heapSize = popped.size;
          const ci = popped.node;
          const cx = ci % Wm;
          const cy = (ci / Wm) | 0;
          expansions++;
          if (isTarget(cx, cy)) { foundX = cx; foundY = cy; break; }
          const cg = gScore[ci];
          for (const d of DIR4) {
            const nx = cx + d[0], ny = cy + d[1];
            if (nx < 0 || ny < 0 || nx >= Wm || ny >= Hm) continue;
            const ni = ny * Wm + nx;
            if (came[ni] !== -1) continue;
            if (!passable(nx, ny)) continue;
            came[ni] = ci;
            gScore[ni] = cg + 1;
            touched[touchedCount++] = ni;
            const f = (cg + 1) + (heuristic(nx, ny) | 0);
            heapSize = heapPush(heapSize, f, ni);
          }
        }
      } else {
        const qx = PF.qx, qy = PF.qy;
        let qs = 0, qe = 0;
        qx[qe] = sx; qy[qe] = sy; qe++;
        let steps = 0;
        while (foundX < 0 && qs < qe && steps < limit) {
          const x = qx[qs], y = qy[qs]; qs++; steps++;
          for (const d of DIR4) {
            const nx = x + d[0], ny = y + d[1];
            if (nx < 0 || ny < 0 || nx >= Wm || ny >= Hm) continue;
            const ni = ny * Wm + nx;
            if (came[ni] !== -1) continue;
            if (!passable(nx, ny)) continue;
            came[ni] = y * Wm + x;
            touched[touchedCount++] = ni;
            if (isTarget(nx, ny)) { foundX = nx; foundY = ny; break; }
            qx[qe] = nx; qy[qe] = ny; qe++;
          }
        }
      }
    }

    if (foundX < 0) {
      resetTouched(touchedCount);
      logTime(tStart);
      return null;
    }
    const path = reconstructPath(sx, sy, foundX, foundY);
    resetTouched(touchedCount);
    logTime(tStart);
    if (!path) return null;
    return { path, dest: { x: foundX, y: foundY } };
  }

  // Initialize sentinels once. resetTouched maintains them per-call.
  PF.came.fill(-1);
  PF.gScore.fill(-1);

  return { passable, pathfind, pathfindToRegion, PF };
}
