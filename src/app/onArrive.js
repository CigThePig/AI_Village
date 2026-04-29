import {
  ANIMAL_BEHAVIORS,
  CRAFTING_RECIPES,
  GRID_W,
  HUNT_RANGE,
  HUNT_RETRY_COOLDOWN,
  ITEM,
  RESOURCE_TYPES,
  TILE,
  TILES,
  ZONES,
} from './constants.js';
import { BUILDINGS, buildingCenter, ensureBuildingData } from './world.js';
import { R, clamp } from './rng.js';
import {
  addJobExperience,
  applySkillGain,
  effectiveSkillFromExperience,
  moodThought,
} from './simulation.js';
import {
  FOOD_HUNGER_RECOVERY,
  HYDRATION_BUFF_TICKS,
  SOCIAL_BASE_TICKS,
  STORAGE_IDLE_BASE,
  restDurationTicks,
  workEffortMultiplier,
} from './villagerAI.js';

export function createOnArrive(opts) {
  const {
    state,
    pathfind,
    idx,
    finishJob,
    suppressJob,
    releaseReservedMaterials,
    spendCraftMaterials,
    cancelHaulJobsForBuilding,
    findAnimalById,
    removeAnimal,
    resolveHuntYield,
    chooseFleeTarget,
    queueAnimalLabel,
    findHuntApproachPath,
    consumeFood,
    handleVillagerFed,
    findNearestBuilding,
    agricultureBonusesAt,
    findEntryTileNear,
    getBuildingById,
    setActiveBuilding,
    noteBuildingActivity,
    buildingAt,
    dropItem,
    removeItemAtIndex,
    itemTileIndex,
    markStaticDirty,
    markEmittersDirty,
    onZoneTileSown,
    getSecondsPerTick,
    getSpeedPxPerSec,
  } = opts;

  const buildings = state.units.buildings;
  const itemsOnGround = state.units.itemsOnGround;
  const storageTotals = state.stocks.totals;
  const storageReserved = state.stocks.reserved;

  function getWorld() { return state.world; }
  function getTick() { return state.time.tick; }

  function stepAlong(v) {
    const next = v.path[0];
    if (!next) return;
    const condition = v.condition || 'normal';
    const penalty = condition === 'sick' ? 0.45
      : condition === 'starving' ? 0.7
      : condition === 'hungry' ? 0.85
      : condition === 'recovering' ? 0.95
      : 1;
    const moodSpeed = 0.75 + v.happy * 0.5;
    // Phase 10 (S4): tired villagers move slower. Multiplicative with the
    // condition penalty so a starving + low-energy villager still moves
    // slower than a starving but rested one.
    const energy = Number.isFinite(v.energy) ? v.energy : 1;
    const energyPenalty = energy < 0.30 ? 0.85
      : energy < 0.50 ? 0.95
      : 1;
    const speedMultiplier = v.speed * penalty * moodSpeed * energyPenalty;
    const stepPx = getSpeedPxPerSec() * speedMultiplier * getSecondsPerTick();
    const step = stepPx / TILE;
    const dx = next.x - v.x, dy = next.y - v.y, dist = Math.hypot(dx, dy);
    if (dist <= step) {
      v.x = next.x;
      v.y = next.y;
      v.path.shift();
      if (v.path.length === 0) onArrive(v);
    } else {
      v.x += (dx / dist) * step;
      v.y += (dy / dist) * step;
    }
  }

  function onArrive(v) {
    const world = getWorld();
    const cx = v.x | 0, cy = v.y | 0, i = idx(cx, cy);

    if (v.state === 'chop') {
      let remove = world.trees[i] <= 0;
      if (world.trees[i] > 0) {
        world.trees[i]--;
        dropItem(cx, cy, ITEM.WOOD, 1);
        if (world.trees[i] === 0) {
          world.tiles[i] = TILES.GRASS;
          markStaticDirty();
          remove = true;
        }
        v.thought = moodThought(v, 'Chopped');
      } else {
        v.thought = moodThought(v, 'Nothing to chop');
      }
      addJobExperience(v, 'chop', remove ? 2 : 1);
      v.state = 'idle';
      finishJob(v, remove);
    }
    else if (v.state === 'mine') {
      let remove = world.rocks[i] <= 0;
      if (world.rocks[i] > 0) {
        world.rocks[i]--;
        dropItem(cx, cy, ITEM.STONE, 1);
        if (world.rocks[i] === 0) {
          world.tiles[i] = TILES.GRASS;
          markStaticDirty();
          remove = true;
        }
        v.thought = moodThought(v, 'Mined');
      } else {
        v.thought = moodThought(v, 'Nothing to mine');
      }
      v.state = 'idle';
      applySkillGain(v, 'constructionSkill', 0.016, 0.88, 1);
      addJobExperience(v, 'mine', remove ? 2 : 1);
      finishJob(v, remove);
    }
    else if (v.state === 'hunt') {
      const job = v.targetJob;
      const animal = job ? findAnimalById(job.targetAid) : null;
      const lodge = job ? buildings.find(bb => bb.id === job.bid && bb.kind === 'hunterLodge') : null;
      if (!job || !animal || animal.state === 'dead') {
        v.thought = moodThought(v, 'Lost prey');
        v.state = 'idle';
        finishJob(v, true);
        return;
      }
      const dist = Math.hypot(animal.x - v.x, animal.y - v.y);
      if (dist > HUNT_RANGE + 0.2) {
        const approach = findHuntApproachPath(v, animal, { range: HUNT_RANGE });
        if (approach?.path) {
          v.path = approach.path;
          v.state = 'hunt';
          v.thought = moodThought(v, 'Stalking');
          return;
        }
        suppressJob(job, HUNT_RETRY_COOLDOWN);
        v.thought = moodThought(v, 'Prey escaped');
        v.state = 'idle';
        finishJob(v, true);
        return;
      }
      const behavior = ANIMAL_BEHAVIORS[animal.type] || {};
      const skill = effectiveSkillFromExperience(v, 'constructionSkill', 0.5, 'hunt');
      const moodFactor = clamp((v.happy - 0.5) * 0.5, -0.15, 0.2);
      const lodgeBonus = Number.isFinite(lodge?.effects?.gameYieldBonus) ? lodge.effects.gameYieldBonus * 0.2 : 0;
      const successChance = clamp(0.55 + skill * 0.25 + moodFactor + lodgeBonus, 0.25, 0.95);
      if (R() < successChance) {
        const yieldResult = resolveHuntYield({ animal, lodge });
        dropItem(animal.x | 0, animal.y | 0, ITEM.FOOD, yieldResult.meat);
        if (yieldResult.pelts > 0) {
          dropItem(animal.x | 0, animal.y | 0, ITEM.PELT, yieldResult.pelts);
        }
        queueAnimalLabel('Taken', '#ffd27f', animal.x + 0.1, animal.y - 0.1);
        removeAnimal(animal);
        v.happy = clamp(v.happy + 0.06, 0, 1);
        applySkillGain(v, 'constructionSkill', 0.014, 0.9, 1);
        addJobExperience(v, 'hunt', 2.5);
        v.thought = moodThought(v, 'Successful hunt');
      } else {
        animal.state = 'flee';
        animal.target = chooseFleeTarget(animal, v, behavior, new Map());
        animal.fleeTicks = Math.round((behavior.roamTicks?.[0] || 40) * 0.8);
        v.happy = clamp(v.happy - 0.015, 0, 1);
        applySkillGain(v, 'constructionSkill', 0.008, 0.9, 1);
        suppressJob(job, HUNT_RETRY_COOLDOWN);
        addJobExperience(v, 'hunt', 1);
        v.thought = moodThought(v, 'Missed the shot');
      }
      v.state = 'idle';
      finishJob(v, true);
    }
    else if (v.state === 'forage') {
      if (Number.isInteger(v.targetI) && world.berries[v.targetI] > 0) {
        world.berries[v.targetI]--;
        if ((v.starveStage || 0) >= 2 || v.condition === 'sick') {
          v.hunger -= FOOD_HUNGER_RECOVERY;
          if (v.hunger < 0) v.hunger = 0;
          handleVillagerFed(v, 'berries');
          v.thought = moodThought(v, 'Ate berries');
        } else {
          v.inv = { type: ITEM.FOOD, qty: 1 };
          v.thought = moodThought(v, 'Got berries');
        }
      } else {
        v.thought = moodThought(v, 'Berries gone');
      }
      addJobExperience(v, 'forage', 1);
      v.state = 'idle';
      finishJob(v, true);
    }
    else if (v.state === 'seek_food') {
      if (!v.inv) {
        const itemKey = (cy * GRID_W) + cx;
        const itemIndex = itemTileIndex.get(itemKey);
        const it = itemIndex !== undefined ? itemsOnGround[itemIndex] : null;
        if (it && it.type === ITEM.FOOD) {
          v.inv = { type: ITEM.FOOD, qty: it.qty };
          removeItemAtIndex(itemIndex);
        }
      }
      if (consumeFood(v)) {
        v.thought = moodThought(v, 'Eating');
      } else if (v.inv && v.inv.type === ITEM.FOOD) {
        v.thought = moodThought(v, 'Holding food');
      } else {
        v.thought = moodThought(v, 'No food found');
      }
      v.state = 'idle';
    }
    else if (v.state === 'sow') {
      if (world.tiles[i] !== TILES.WATER) {
        world.tiles[i] = TILES.FARMLAND;
        world.growth[i] = 1;
        world.zone[i] = ZONES.FARM;
        if (typeof onZoneTileSown === 'function') onZoneTileSown(cx, cy);
        markStaticDirty();
        v.thought = moodThought(v, 'Sowed');
      } else {
        v.thought = moodThought(v, 'Too wet to sow');
      }
      v.state = 'idle';
      applySkillGain(v, 'farmingSkill', 0.012, 0.9, 1);
      addJobExperience(v, 'sow', 1);
      finishJob(v, true);
    }
    else if (v.state === 'harvest') {
      if (world.growth[i] > 0) {
        // Phase 10 (S5): hungry/sick/tired harvesters bring back less. Floor
        // at 1 so an arrived villager always returns *something* (zero-yield
        // harvest would feel buggy and the tile is still consumed below).
        const effort = workEffortMultiplier(v);
        let yieldAmount = Math.max(1, Math.round(2 * effort));
        const { harvestBonus } = agricultureBonusesAt(cx, cy);
        if (harvestBonus > 0) {
          const whole = Math.floor(harvestBonus);
          yieldAmount += whole;
          const frac = harvestBonus - whole;
          if (frac > 0 && R() < frac) yieldAmount += 1;
        }
        dropItem(cx, cy, ITEM.FOOD, yieldAmount);
        const harvestThought = yieldAmount > 1 ? 'Bountiful harvest' : 'Harvested';
        v.thought = moodThought(v, harvestThought);
      } else {
        v.thought = moodThought(v, 'Nothing to harvest');
      }
      world.growth[i] = 0;
      v.state = 'idle';
      applySkillGain(v, 'farmingSkill', 0.018, 0.9, 1);
      addJobExperience(v, 'harvest', 2);
      finishJob(v, true);
    }
    else if (v.state === 'build') {
      const b = buildings.find(bb => bb.id === v.targetJob?.bid);
      if (!b) {
        const bid = v.targetJob?.bid;
        if (bid) { cancelHaulJobsForBuilding({ id: bid }); }
        v.thought = moodThought(v, 'Site missing');
        addJobExperience(v, 'build', 1);
        v.state = 'idle';
        finishJob(v, true);
        return;
      }
      ensureBuildingData(b);
      const def = BUILDINGS[b.kind] || {};
      const cost = def.cost || ((def.wood || 0) + (def.stone || 0));
      if (b.built >= 1) {
        v.thought = moodThought(v, 'Built');
        cancelHaulJobsForBuilding(b);
        applySkillGain(v, 'constructionSkill', 0.02, 0.9, 1);
        addJobExperience(v, 'build', 3);
        v.state = 'idle';
        finishJob(v, true);
        return;
      }
      const store = b.store || {};
      const spent = b.spent || { wood: 0, stone: 0 };
      let used = 0;
      if (def.wood) {
        const needWood = Math.max(0, (def.wood || 0) - (spent.wood || 0));
        if (needWood > 0 && (store.wood || 0) > 0) {
          const take = Math.min(needWood, store.wood);
          store.wood -= take;
          spent.wood = (spent.wood || 0) + take;
          used += take;
        }
      }
      if (def.stone) {
        const needStone = Math.max(0, (def.stone || 0) - (spent.stone || 0));
        if (needStone > 0 && (store.stone || 0) > 0) {
          const take = Math.min(needStone, store.stone);
          store.stone -= take;
          spent.stone = (spent.stone || 0) + take;
          used += take;
        }
      }
      b.progress = (spent.wood || 0) + (spent.stone || 0);
      if (b.progress < cost) {
        // Under supply-first construction the build job only exists once
        // b.store covers the cost. Reaching this branch means materials
        // drifted (e.g. a load-time race); leave the planner to re-request
        // and keep the build job alive.
        v.thought = moodThought(v, used > 0 ? 'Building' : 'Needs supplies');
        addJobExperience(v, 'build', 1);
        v.state = 'idle';
        finishJob(v, false);
        return;
      }
      // Materials are in place. Phase 7: instead of finishing in one tick,
      // transition into the 'building' transient state and accumulate
      // b.laborProgress per tick. Zero-labor kinds (campfire) keep the
      // legacy immediate-finish path so emitter initialization is unchanged.
      const laborGoal = def.buildLaborTicks | 0;
      if (laborGoal <= 0) {
        b.built = 1;
        spent.wood = def.wood || 0;
        spent.stone = def.stone || 0;
        b.progress = cost;
        b.laborProgress = 0;
        // Return any excess back to storage so over-delivered material
        // does not get trapped inside the building (audit #28).
        for (const res of ['wood', 'stone', 'food']) {
          const leftover = store[res] || 0;
          if (leftover > 0) {
            storageTotals[res] = (storageTotals[res] || 0) + leftover;
            store[res] = 0;
          }
        }
        if (b.kind === 'campfire') markEmittersDirty();
        cancelHaulJobsForBuilding(b);
        markStaticDirty();
        v.thought = moodThought(v, 'Built');
        applySkillGain(v, 'constructionSkill', 0.02, 0.9, 1);
        addJobExperience(v, 'build', 3);
        v.state = 'idle';
        finishJob(v, true);
        return;
      }
      // Phase 7: kick off (or resume) labor. Decrement j.assigned so a second
      // builder can claim the same job; pickJobFor's `assigned >= 1` skip is
      // the gate that lets multiple villagers converge on one site.
      setActiveBuilding(v, b);
      noteBuildingActivity(b, 'use');
      if (v.targetJob) {
        v.targetJob.assigned = Math.max(0, (v.targetJob.assigned || 0) - 1);
      }
      v.state = 'building';
      v.thought = moodThought(v, 'Building');
    }
    else if (v.state === 'haul_pickup') {
      const job = v.targetJob;
      const res = job?.resource;
      const qty = job?.qty || 0;
      const b = job ? buildings.find(bb => bb.id === job.bid) : null;
      if (!job || job.type !== 'haul' || !res || qty <= 0) {
        if (job && job.type === 'haul' && job.stage === 'pickup') {
          const r = job.resource;
          storageReserved[r] = Math.max(0, (storageReserved[r] || 0) - qty);
          if (b) { ensureBuildingData(b); b.pending[r] = Math.max(0, (b.pending[r] || 0) - qty); }
        }
        v.thought = moodThought(v, 'Idle');
        v.state = 'idle';
        finishJob(v, true);
        return;
      }
      ensureBuildingData(b);
      if (!b || b.built >= 1) {
        storageReserved[res] = Math.max(0, (storageReserved[res] || 0) - qty);
        if (b) { b.pending[res] = Math.max(0, (b.pending[res] || 0) - qty); }
        v.thought = moodThought(v, 'Site stocked');
        v.state = 'idle';
        finishJob(v, true);
        return;
      }
      const available = storageTotals[res] || 0;
      if (available >= qty) {
        storageTotals[res] -= qty;
        storageReserved[res] = Math.max(0, (storageReserved[res] || 0) - qty);
        v.inv = { type: res, qty };
        job.stage = 'deliver';
        v.thought = moodThought(v, 'Loaded supplies');
        let dest = job.dest || { x: b.x, y: b.y };
        const targetBuilding = job.dest ? buildingAt(dest.x, dest.y) : b;
        if (targetBuilding) {
          const entry = findEntryTileNear(targetBuilding, cx, cy) || { x: Math.round(buildingCenter(targetBuilding).x), y: Math.round(buildingCenter(targetBuilding).y) };
          dest = entry;
        }
        const p = pathfind(cx, cy, dest.x, dest.y);
        if (p) {
          v.path = p;
          v.state = 'haul_deliver';
          return;
        }
        storageTotals[res] += qty;
        v.inv = null;
        b.pending[res] = Math.max(0, (b.pending[res] || 0) - qty);
        v.thought = moodThought(v, 'Path blocked');
        v.state = 'idle';
        finishJob(v, true);
      } else {
        storageReserved[res] = Math.max(0, (storageReserved[res] || 0) - qty);
        b.pending[res] = Math.max(0, (b.pending[res] || 0) - qty);
        v.thought = moodThought(v, 'Needs supplies');
        v.state = 'idle';
        finishJob(v, true);
      }
    }
    else if (v.state === 'haul_deliver') {
      const job = v.targetJob;
      const res = job?.resource;
      const carrying = v.inv;
      const b = job ? buildings.find(bb => bb.id === job.bid) : null;
      v.thought = moodThought(v, 'Idle');
      if (job && job.type === 'haul' && carrying && carrying.type === res) {
        const qty = carrying.qty || 0;
        v.inv = null;
        if (b) { ensureBuildingData(b); }
        if (b && b.built < 1 && !job?.cancelled) {
          b.store[res] = (b.store[res] || 0) + qty;
          v.thought = moodThought(v, 'Delivered supplies');
        } else {
          storageTotals[res] = (storageTotals[res] || 0) + qty;
          v.thought = moodThought(v, 'Returned supplies');
        }
        if (b) { b.pending[res] = Math.max(0, (b.pending[res] || 0) - qty); }
        applySkillGain(v, 'constructionSkill', 0.01, 0.9, 1);
        addJobExperience(v, 'haul', 1);
      } else if (job && job.type === 'haul' && job.stage === 'pickup') {
        const qty = job.qty || 0;
        if (res) {
          storageReserved[res] = Math.max(0, (storageReserved[res] || 0) - qty);
          if (b) { ensureBuildingData(b); b.pending[res] = Math.max(0, (b.pending[res] || 0) - qty); }
        }
      }
      v.state = 'idle';
      finishJob(v, true);
    }
    else if (v.state === 'craft_bow') {
      const job = v.targetJob;
      const recipe = job?.materials || CRAFTING_RECIPES.bow;
      const lodge = job ? buildings.find(bb => bb.id === job.bid && bb.kind === 'hunterLodge') : null;
      if (!job || !lodge || lodge.built < 1) {
        releaseReservedMaterials(recipe || {});
        v.thought = moodThought(v, 'No lodge');
        v.state = 'idle';
        finishJob(v, true);
        return;
      }
      if (!spendCraftMaterials(recipe || {})) {
        v.thought = moodThought(v, 'Missing supplies');
        v.state = 'idle';
        finishJob(v, true);
        return;
      }
      const storage = findNearestBuilding(cx, cy, 'storage');
      if (storage) {
        storageTotals.bow = (storageTotals.bow || 0) + 1;
        v.thought = moodThought(v, 'Crafted bow');
      } else if (!v.inv) {
        v.inv = { type: ITEM.BOW, qty: 1 };
        v.thought = moodThought(v, 'Crafted bow');
      } else {
        dropItem(cx, cy, ITEM.BOW, 1);
        v.thought = moodThought(v, 'Dropped bow');
      }
      applySkillGain(v, 'constructionSkill', 0.012, 0.9, 1);
      addJobExperience(v, 'craft_bow', 2.5);
      v.state = 'idle';
      finishJob(v, true);
    }
    else if (v.state === 'equip_bow') {
      // tryEquipBow reserved 1 bow on intent. spendCraftMaterials closes the
      // reservation on success AND releases it on insufficient-stock failure,
      // so we only need an explicit release when we never reach that call
      // (e.g. the storage building disappeared mid-trip). Audit #12, #13.
      const storage = v.targetBuilding || findNearestBuilding(cx, cy, 'storage');
      let equipped = false;
      if (storage) {
        equipped = spendCraftMaterials({ bow: 1 });
      } else {
        releaseReservedMaterials({ bow: 1 });
      }
      if (equipped) {
        v.equippedBow = true;
        v.thought = moodThought(v, 'Equipped bow');
      } else {
        v.thought = moodThought(v, 'No bow available');
      }
      v.reservedPickup = null;
      v.state = 'idle';
      v.targetBuilding = null;
    }
    else if (v.state === 'to_storage') {
      if (v.inv) {
        if (v.inv.type === ITEM.FOOD && ((v.starveStage || 0) >= 2 || v.condition === 'sick')) {
          consumeFood(v);
          v.thought = moodThought(v, 'Ate supplies');
        } else {
          if (RESOURCE_TYPES.includes(v.inv.type)) {
            storageTotals[v.inv.type] = (storageTotals[v.inv.type] || 0) + v.inv.qty;
          }
          v.inv = null;
          v.thought = moodThought(v, 'Stored');
        }
      }
      v.state = 'idle';
    }
    else if (v.state === 'rest') {
      // Audit S3: unified with the in-state clamp via restDurationTicks.
      const baseRest = restDurationTicks(v.energy);
      const b = v.targetBuilding || getBuildingById(v.activeBuildingId) || buildingAt(cx, cy);
      if (b) setActiveBuilding(v, b);
      if (b) noteBuildingActivity(b, 'rest');
      if (v.restTimer < baseRest) v.restTimer = baseRest;
      // Audit S1: stamped by villagerTick when night-anchored sleep was the
      // trigger. Lets the resting block wake the villager at dawn.
      v.restStartedAtNight = !!v._fellAsleepAtNight;
      v._fellAsleepAtNight = false;
      v.state = 'resting';
      v.thought = moodThought(v, 'Resting');
    }
    else if (v.state === 'hydrate') {
      const b = v.targetBuilding || getBuildingById(v.activeBuildingId) || buildingAt(cx, cy);
      if (b) setActiveBuilding(v, b);
      if (b) noteBuildingActivity(b, 'hydrate');
      v.hydrationTimer = Math.max(v.hydrationTimer || 0, Math.round(HYDRATION_BUFF_TICKS * 0.25));
      v.hydration = 1;
      v.hydrationBuffTicks = Math.max(v.hydrationBuffTicks, HYDRATION_BUFF_TICKS);
      v.state = 'hydrating';
      v.thought = moodThought(v, 'Drinking');
    }
    else if (v.state === 'socialize') {
      const b = v.targetBuilding || getBuildingById(v.activeBuildingId) || buildingAt(cx, cy);
      if (b) setActiveBuilding(v, b);
      if (b) noteBuildingActivity(b, 'social');
      v.socialTimer = Math.max(v.socialTimer || 0, SOCIAL_BASE_TICKS);
      v.state = 'socializing';
      v.thought = moodThought(v, 'Gathering');
    }
    else if (v.state === 'storage_idle') {
      const b = v.targetBuilding || getBuildingById(v.activeBuildingId) || buildingAt(cx, cy);
      if (b) setActiveBuilding(v, b);
      if (b) noteBuildingActivity(b, 'use');
      v.storageIdleTimer = Math.max(v.storageIdleTimer || 0, STORAGE_IDLE_BASE);
      v.state = 'storage_linger';
      v.thought = moodThought(v, 'Tidying storage');
    }

    void getTick;
  }

  return { stepAlong, onArrive };
}
