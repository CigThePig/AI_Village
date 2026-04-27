import { RESOURCE_TYPES } from './app/constants.js';

export function createInitialState({ seed, cfg } = {}) {
  const baseSeed = Number.isFinite(seed) ? seed >>> 0 : (Date.now() | 0);
  const config = cfg && typeof cfg === 'object' ? cfg : {};

  const unitsConfig = config.units && typeof config.units === 'object' ? config.units : {};
  const stocksConfig = config.stocks && typeof config.stocks === 'object' ? config.stocks : {};
  const queueConfig = config.queue && typeof config.queue === 'object' ? config.queue : {};
  const populationConfig = config.population && typeof config.population === 'object' ? config.population : {};

  const units = {
    buildings: Array.isArray(unitsConfig.buildings) ? unitsConfig.buildings.slice() : [],
    villagers: Array.isArray(unitsConfig.villagers) ? unitsConfig.villagers.slice() : [],
    jobs: Array.isArray(unitsConfig.jobs) ? unitsConfig.jobs.slice() : [],
    itemsOnGround: Array.isArray(unitsConfig.itemsOnGround) ? unitsConfig.itemsOnGround.slice() : [],
    animals: Array.isArray(unitsConfig.animals) ? unitsConfig.animals.slice() : []
  };

  const timeDefaults = {
    tick: 0,
    paused: false,
    speedIdx: 1,
    dayTime: 0
  };
  const time = Object.assign({}, timeDefaults, config.time && typeof config.time === 'object' ? config.time : {});

  const rng = {
    seed: baseSeed,
    generator: typeof (config.rng && config.rng.generator) === 'function' ? config.rng.generator : Math.random
  };

  const baseTotals = Object.fromEntries(RESOURCE_TYPES.map(r => [r, 0]));
  const baseReserved = Object.fromEntries(RESOURCE_TYPES.map(r => [r, 0]));
  const stocks = {
    totals: Object.assign(baseTotals, { food: 24 }, stocksConfig.totals),
    reserved: Object.assign(baseReserved, stocksConfig.reserved)
  };

  const queue = {
    villagerLabels: Array.isArray(queueConfig.villagerLabels) ? queueConfig.villagerLabels.slice() : []
  };

  const population = {
    priorities: Object.assign({ food: 0.7, build: 0.5, explore: 0.3 }, populationConfig.priorities)
  };

  const initialWorld = config.world && typeof config.world === 'object' ? config.world : null;

  return {
    world: initialWorld,
    units,
    time,
    rng,
    stocks,
    queue,
    population,
    bb: null
  };
}
