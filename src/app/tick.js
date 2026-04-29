import { DAY_LENGTH, SPEEDS } from './constants.js';
import { computeBlackboard } from '../ai/blackboard.js';

const PLANNER_INTERVAL = { zones: 90, build: 120 };

// Phase 12: per-subsystem timing surfaced via DebugKit. EMA so the displayed
// numbers don't flicker frame-to-frame.
const PERF_EMA_ALPHA = 0.05;
const PERF_KEYS = [
  'tickTotal',
  'jobs',
  'season',
  'blackboard',
  'planZones',
  'planBuildings',
  'animals',
  'nocturnal',
  'villagerTick',
  'pendingBirths'
];

function createPerfMetrics() {
  const metrics = { __ticks: 0 };
  for (const k of PERF_KEYS) metrics[k] = 0;
  return metrics;
}

function emaUpdate(metrics, key, sample) {
  const prev = metrics[key] || 0;
  metrics[key] = prev + (sample - prev) * PERF_EMA_ALPHA;
}

const _hasPerfNow = (typeof performance !== 'undefined' && typeof performance.now === 'function');
function nowMs() {
  return _hasPerfNow ? performance.now() : 0;
}

export function createTickRunner(deps) {
  const {
    state,
    policy,
    planZones,
    planBuildings,
    generateJobs,
    villagerTick,
    updateAnimals,
    updateNocturnalEntities,
    seasonTick,
    flushPendingBirths,
    processVillagerItemPickup,
    ambientAt,
    perf
  } = deps;

  const TICKS_PER_SEC = policy.routine.ticksPerSecond || 6;
  const TICK_MS = 1000 / TICKS_PER_SEC;
  const MAX_CATCHUP_STEPS = Math.max(
    1,
    Number.isFinite(policy.routine.maxCatchupTicksPerFrame)
      ? policy.routine.maxCatchupTicksPerFrame
      : 12
  );

  let last = performance.now();
  let acc = 0;
  let lastBlackboardTick = state.time.tick;
  let lastBlackboardLogTick = state.time.tick;
  let lastZonePlanTick = state.time.tick - PLANNER_INTERVAL.zones;
  let lastBuildPlanTick = state.time.tick - PLANNER_INTERVAL.build;
  const metrics = createPerfMetrics();
  state.__perf = metrics;

  function ensureBlackboardSnapshot() {
    const cadence = Number.isFinite(policy?.routine?.blackboardCadenceTicks)
      ? policy.routine.blackboardCadenceTicks
      : 30;
    const tick = state.time.tick;
    if (!state.bb || (tick - lastBlackboardTick) > cadence) {
      state.bb = computeBlackboard(state, policy);
      lastBlackboardTick = tick;
    }
    return state.bb;
  }

  function reset() {
    last = performance.now();
    acc = 0;
    lastBlackboardTick = state.time.tick;
    lastBlackboardLogTick = state.time.tick;
    lastZonePlanTick = state.time.tick - PLANNER_INTERVAL.zones;
    lastBuildPlanTick = state.time.tick - PLANNER_INTERVAL.build;
  }

  function runFrame(now) {
    if (state.time.paused) {
      last = now;
      return;
    }
    let dt = now - last;
    last = now;
    dt *= SPEEDS[state.time.speedIdx];
    acc += dt;

    let steps = Math.floor(acc / TICK_MS);
    if (steps > MAX_CATCHUP_STEPS) {
      const allowedAcc = MAX_CATCHUP_STEPS * TICK_MS;
      const droppedMs = Math.max(0, acc - allowedAcc);
      acc = allowedAcc;
      steps = MAX_CATCHUP_STEPS;
      if (perf?.log) {
        console.warn('AIV loop catch-up capped', { droppedMs, cappedSteps: MAX_CATCHUP_STEPS });
      }
    }
    if (steps > 0) acc -= steps * TICK_MS;

    const jobInterval = policy.routine.jobGenerationTickInterval || 20;
    const seasonInterval = policy.routine.seasonTickInterval || 10;
    const blackboardInterval = policy.routine.blackboardCadenceTicks || 30;
    const logConfig = policy.routine.blackboardLogging || null;
    const logInterval = logConfig && Number.isFinite(logConfig.intervalTicks)
      ? Math.max(1, logConfig.intervalTicks)
      : Math.max(1, TICKS_PER_SEC * 60);

    const villagers = state.units.villagers;

    for (let s = 0; s < steps; s++) {
      const tickStart = nowMs();
      state.time.tick++;
      state.time.dayTime = (state.time.dayTime + 1) % DAY_LENGTH;
      const tick = state.time.tick;
      const ambientNow = ambientAt(state.time.dayTime);

      let t0 = nowMs();
      if (jobInterval > 0 && tick % jobInterval === 0) generateJobs();
      emaUpdate(metrics, 'jobs', nowMs() - t0);

      t0 = nowMs();
      if (seasonInterval > 0 && tick % seasonInterval === 0) seasonTick();
      emaUpdate(metrics, 'season', nowMs() - t0);

      t0 = nowMs();
      if (blackboardInterval > 0 && (tick - lastBlackboardTick) >= blackboardInterval) {
        state.bb = computeBlackboard(state, policy);
        lastBlackboardTick = tick;
        if (logConfig && logConfig.enabled && (tick - lastBlackboardLogTick) >= logInterval) {
          console.debug('[blackboard]', state.bb);
          lastBlackboardLogTick = tick;
        }
      }
      emaUpdate(metrics, 'blackboard', nowMs() - t0);

      t0 = nowMs();
      if ((tick - lastZonePlanTick) >= PLANNER_INTERVAL.zones) {
        planZones(state.bb);
        lastZonePlanTick = tick;
      }
      emaUpdate(metrics, 'planZones', nowMs() - t0);

      t0 = nowMs();
      if ((tick - lastBuildPlanTick) >= PLANNER_INTERVAL.build) {
        planBuildings(state.bb);
        lastBuildPlanTick = tick;
      }
      emaUpdate(metrics, 'planBuildings', nowMs() - t0);

      t0 = nowMs();
      updateAnimals();
      emaUpdate(metrics, 'animals', nowMs() - t0);

      t0 = nowMs();
      updateNocturnalEntities(ambientNow);
      emaUpdate(metrics, 'nocturnal', nowMs() - t0);

      t0 = nowMs();
      for (const v of villagers) {
        processVillagerItemPickup(v);
        villagerTick(v);
      }
      emaUpdate(metrics, 'villagerTick', nowMs() - t0);

      t0 = nowMs();
      flushPendingBirths();
      emaUpdate(metrics, 'pendingBirths', nowMs() - t0);

      emaUpdate(metrics, 'tickTotal', nowMs() - tickStart);
      metrics.__ticks++;
    }
  }

  function getMetrics() {
    return metrics;
  }

  return { runFrame, reset, ensureBlackboardSnapshot, getMetrics };
}
