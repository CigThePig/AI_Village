import { DAY_LENGTH, SPEEDS } from './constants.js';
import { computeBlackboard } from '../ai/blackboard.js';

const PLANNER_INTERVAL = { zones: 90, build: 120 };

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
      state.time.tick++;
      state.time.dayTime = (state.time.dayTime + 1) % DAY_LENGTH;
      const tick = state.time.tick;
      const ambientNow = ambientAt(state.time.dayTime);

      if (jobInterval > 0 && tick % jobInterval === 0) generateJobs();
      if (seasonInterval > 0 && tick % seasonInterval === 0) seasonTick();
      if (blackboardInterval > 0 && (tick - lastBlackboardTick) >= blackboardInterval) {
        state.bb = computeBlackboard(state, policy);
        lastBlackboardTick = tick;
        if (logConfig && logConfig.enabled && (tick - lastBlackboardLogTick) >= logInterval) {
          console.debug('[blackboard]', state.bb);
          lastBlackboardLogTick = tick;
        }
      }
      if ((tick - lastZonePlanTick) >= PLANNER_INTERVAL.zones) {
        planZones(state.bb);
        lastZonePlanTick = tick;
      }
      if ((tick - lastBuildPlanTick) >= PLANNER_INTERVAL.build) {
        planBuildings(state.bb);
        lastBuildPlanTick = tick;
      }

      updateAnimals();
      updateNocturnalEntities(ambientNow);

      for (const v of villagers) {
        processVillagerItemPickup(v);
        villagerTick(v);
      }
      flushPendingBirths();
    }
  }

  return { runFrame, reset, ensureBlackboardSnapshot };
}
