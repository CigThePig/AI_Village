import { ITEM } from './constants.js';
import {
  buildingCenter,
  buildingResourceNeed,
  ensureBuildingData,
} from './world.js';

export function createMaterials(opts) {
  const {
    state,
    policy,
    addJob,
    noteJobRemoved,
    findNearestBuilding,
    detachVillagersFromJob,
  } = opts;

  const buildings = state.units.buildings;
  const jobs = state.units.jobs;
  const storageTotals = state.stocks.totals;
  const storageReserved = state.stocks.reserved;

  function availableToReserve(resource) {
    return (storageTotals[resource] || 0) - (storageReserved[resource] || 0);
  }

  function canReserveMaterials(cost = {}) {
    for (const [key, qty] of Object.entries(cost)) {
      if (qty > 0 && availableToReserve(key) < qty) return false;
    }
    return true;
  }

  function reserveMaterials(cost = {}) {
    if (!canReserveMaterials(cost)) return false;
    for (const [key, qty] of Object.entries(cost)) {
      if (qty > 0) {
        storageReserved[key] = (storageReserved[key] || 0) + qty;
      }
    }
    return true;
  }

  function releaseReservedMaterials(cost = {}) {
    for (const [key, qty] of Object.entries(cost)) {
      if (qty > 0) {
        storageReserved[key] = Math.max(0, (storageReserved[key] || 0) - qty);
      }
    }
  }

  function spendCraftMaterials(cost = {}) {
    for (const [key, qty] of Object.entries(cost)) {
      if (qty > 0 && (storageTotals[key] || 0) < qty) {
        releaseReservedMaterials(cost);
        return false;
      }
    }
    for (const [key, qty] of Object.entries(cost)) {
      if (qty > 0) {
        storageTotals[key] = Math.max(0, (storageTotals[key] || 0) - qty);
        releaseReservedMaterials({ [key]: qty });
      }
    }
    return true;
  }

  function countBuildingsByKind(kind) {
    let built = 0, planned = 0;
    for (const b of buildings) {
      if (!b || b.kind !== kind) continue;
      if (b.built >= 1) built++;
      else planned++;
    }
    return { built, planned, total: built + planned };
  }

  function scheduleHaul(b, resource, amount) {
    if (!b || amount <= 0) return;
    ensureBuildingData(b);
    const available = availableToReserve(resource);
    if (available <= 0) return;
    const qty = Math.min(Math.ceil(amount), available);
    if (qty <= 0) return;
    const center = buildingCenter(b);
    const storageBuilding = findNearestBuilding(center.x, center.y, 'storage');
    if (!storageBuilding) return;
    const job = addJob({
      type: 'haul',
      bid: b.id,
      resource,
      qty,
      prio: 0.6 + (policy.sliders.build || 0) * 0.5,
      x: storageBuilding.x,
      y: storageBuilding.y,
    });
    if (!job) return;
    job.src = { x: storageBuilding.x, y: storageBuilding.y };
    job.dest = { x: b.x, y: b.y };
    job.stage = 'pickup';
    storageReserved[resource] = (storageReserved[resource] || 0) + qty;
    b.pending[resource] = (b.pending[resource] || 0) + qty;
  }

  function requestBuildHauls(b) {
    if (!b || b.built >= 1) return;
    ensureBuildingData(b);
    const store = b.store || {};
    const pending = b.pending || {};
    const woodNeed = buildingResourceNeed(b, 'wood');
    const stoneNeed = buildingResourceNeed(b, 'stone');
    const woodShort = Math.max(0, woodNeed - ((store.wood || 0) + (pending.wood || 0)));
    const stoneShort = Math.max(0, stoneNeed - ((store.stone || 0) + (pending.stone || 0)));
    if (woodShort > 0) scheduleHaul(b, ITEM.WOOD, woodShort);
    if (stoneShort > 0) scheduleHaul(b, ITEM.STONE, stoneShort);
  }

  function cancelHaulJobsForBuilding(b) {
    if (!b || !b.id) return;
    ensureBuildingData(b);
    for (let i = jobs.length - 1; i >= 0; i--) {
      const job = jobs[i];
      if (job.type === 'haul' && job.bid === b.id) {
        if (job.stage === 'deliver') {
          job.cancelled = true;
          continue;
        }
        const res = job.resource;
        const qty = job.qty || 0;
        storageReserved[res] = Math.max(0, (storageReserved[res] || 0) - qty);
        b.pending[res] = Math.max(0, (b.pending[res] || 0) - qty);
        detachVillagersFromJob(job);
        noteJobRemoved(job);
        jobs.splice(i, 1);
      }
    }
  }

  return {
    availableToReserve,
    canReserveMaterials,
    reserveMaterials,
    releaseReservedMaterials,
    spendCraftMaterials,
    countBuildingsByKind,
    scheduleHaul,
    requestBuildHauls,
    cancelHaulJobsForBuilding,
  };
}
