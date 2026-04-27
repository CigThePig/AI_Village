import { GRID_W } from './constants.js';
import { uid } from './rng.js';

export function createJobsSystem(opts) {
  const {
    state,
    policy,
  } = opts;

  const jobs = state.units.jobs;
  const villagers = state.units.villagers;

  const jobSuppression = new Map();
  const activeZoneJobs = { sow: new Set(), chop: new Set(), mine: new Set() };

  function clearActiveZoneJobs() {
    activeZoneJobs.sow.clear();
    activeZoneJobs.chop.clear();
    activeZoneJobs.mine.clear();
  }

  function noteJobAssignmentChanged(j) {
    if (!j) return;
    const set = activeZoneJobs[j.type];
    if (!set) return;
    const key = j.y * GRID_W + j.x;
    if ((j.assigned || 0) > 0) set.add(key);
    else set.delete(key);
  }

  function noteJobRemoved(j) {
    if (!j) return;
    const set = activeZoneJobs[j.type];
    if (!set) return;
    set.delete(j.y * GRID_W + j.x);
  }

  function getJobCreationConfig() {
    return policy?.style?.jobCreation || {};
  }

  function jobKey(job) {
    if (!job || !job.type) return null;
    const base = `${job.type}:${Number.isFinite(job.x) ? job.x : '?'},${Number.isFinite(job.y) ? job.y : '?'}`;
    if (job.bid !== undefined) {
      return `${base}:b${job.bid}`;
    }
    return base;
  }

  function isJobSuppressed(job) {
    const key = jobKey(job);
    if (!key) return false;
    const until = jobSuppression.get(key);
    if (until === undefined) return false;
    if (until <= state.time.tick) {
      jobSuppression.delete(key);
      return false;
    }
    return true;
  }

  function suppressJob(job, duration = 0) {
    const key = jobKey(job);
    if (!key || duration <= 0) return;
    jobSuppression.set(key, state.time.tick + duration);
  }

  function hasSimilarJob(job) {
    return jobs.some(j => j && j.type === job.type && j.x === job.x && j.y === job.y && (j.bid || null) === (job.bid || null));
  }

  function violatesSpacing(x, y, type, cfg) {
    const spacing = cfg?.minSpacing?.[type];
    if (!Number.isFinite(spacing) || spacing <= 0) return false;
    for (const j of jobs) {
      if (!j || j.type !== type) continue;
      const dist = Math.abs((j.x || 0) - x) + Math.abs((j.y || 0) - y);
      if (dist <= spacing) return true;
    }
    return false;
  }

  function addJob(job) {
    if (!job || !job.type) return null;
    if (hasSimilarJob(job) || isJobSuppressed(job)) return null;
    job.id = uid();
    job.assigned = 0;
    jobs.push(job);
    return job;
  }

  function finishJob(v, remove = false) {
    const job = v.targetJob;
    if (job) {
      job.assigned = Math.max(0, (job.assigned || 0) - 1);
      noteJobAssignmentChanged(job);
      if (remove) {
        const ji = jobs.indexOf(job);
        if (ji !== -1) {
          noteJobRemoved(job);
          jobs.splice(ji, 1);
        }
      }
    }
    v.targetJob = null;
  }

  function detachVillagersFromJob(job) {
    for (const villager of villagers) {
      if (villager.targetJob === job) {
        villager.targetJob = null;
        if (villager.path) villager.path.length = 0;
        villager.state = 'idle';
      }
    }
  }

  return {
    activeZoneJobs,
    clearActiveZoneJobs,
    noteJobAssignmentChanged,
    noteJobRemoved,
    getJobCreationConfig,
    jobKey,
    isJobSuppressed,
    suppressJob,
    hasSimilarJob,
    violatesSpacing,
    addJob,
    finishJob,
    detachVillagersFromJob,
  };
}
