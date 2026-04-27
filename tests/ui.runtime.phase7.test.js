import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// Phase 7 covers UI/runtime robustness. ui.js → canvas.js touches
// `document` and `window` at module load, and save.js's storage
// import inspects `globalThis.localStorage`. Provide minimal stubs
// before any dynamic import. Tests share these modules; per-test
// state is isolated by mutating `_stubElements` and creating fresh
// systems via `createUISystem` / `createSaveSystem`.

const _stubElements = {};
const _localStorageData = {};

function makeFakeEl(extra = {}) {
  const attrs = {};
  const listeners = {};
  return {
    listeners,
    textContent: '',
    style: { cssText: '', display: '', cursor: '', touchAction: '' },
    dataset: {},
    classList: {
      toggle() {},
      add() {},
      remove() {},
    },
    setAttribute(k, v) { attrs[k] = v; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeEventListener(ev, fn) {
      if (!listeners[ev]) return;
      const i = listeners[ev].indexOf(fn);
      if (i >= 0) listeners[ev].splice(i, 1);
    },
    appendChild() {},
    removeChild() {},
    replaceChildren() {},
    remove() {},
    closest() { return null; },
    setPointerCapture() {},
    getContext: () => ({ imageSmoothingEnabled: true }),
    getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }),
    width: 0,
    height: 0,
    disabled: false,
    title: '',
    id: '',
    ...extra,
  };
}

function ensureBrowserStubs() {
  if (!globalThis.localStorage) {
    globalThis.localStorage = {
      getItem(k) { return Object.prototype.hasOwnProperty.call(_localStorageData, k) ? _localStorageData[k] : null; },
      setItem(k, v) { _localStorageData[k] = String(v); },
      removeItem(k) { delete _localStorageData[k]; },
    };
  }
  if (!globalThis.document) {
    globalThis.document = {
      body: makeFakeEl(),
      documentElement: makeFakeEl(),
      readyState: 'complete',
      addEventListener() {},
      removeEventListener() {},
      createElement: () => makeFakeEl(),
      querySelectorAll: () => [],
      getElementById(id) {
        if (Object.prototype.hasOwnProperty.call(_stubElements, id)) return _stubElements[id];
        // canvas.js requires #game to be non-null at module load.
        return makeFakeEl({ id });
      },
    };
  }
  if (!globalThis.window) {
    globalThis.window = {
      devicePixelRatio: 1,
      addEventListener() {},
      removeEventListener() {},
      __AIV_BOOT__: false,
    };
  }
  if (!globalThis.AIV_TERRAIN) {
    globalThis.AIV_TERRAIN = {
      generateTerrain: () => ({}),
      makeHillshade: () => new Uint8ClampedArray(0),
    };
  }
  if (!globalThis.AIV_CONFIG) {
    globalThis.AIV_CONFIG = {
      WORLDGEN_DEFAULTS: {},
      SHADING_DEFAULTS: { ambient: 0.5, intensity: 0.5, slopeScale: 1 },
    };
  }
}
ensureBrowserStubs();

const { createUISystem } = await import('../src/app/ui.js');
const { createSaveSystem } = await import('../src/app/save.js');
const { SPEEDS, SAVE_KEY, SAVE_VERSION } = await import('../src/app/constants.js');

function makeUI({ overrides = {}, time = { paused: false, speedIdx: 1 } } = {}) {
  // Reset element overrides per call so each createUISystem caches fresh refs.
  for (const k of Object.keys(_stubElements)) delete _stubElements[k];
  Object.assign(_stubElements, overrides);
  const policy = { sliders: { food: 0.7, build: 0.5, explore: 0.3 } };
  return {
    sys: createUISystem({
      policy,
      time,
      saveGame: () => {},
      newWorld: () => {},
    }),
    time,
    refs: overrides,
  };
}

test('syncTimeButtons reflects current time state on btnPause and btnSpeed', () => {
  const btnPause = makeFakeEl();
  const btnSpeed = makeFakeEl();
  const time = { paused: false, speedIdx: 1 };
  const { sys } = makeUI({ overrides: { btnPause, btnSpeed }, time });

  sys.syncTimeButtons();
  assert.equal(btnPause.textContent, '⏸');
  assert.equal(btnSpeed.textContent, SPEEDS[1] + '×');

  time.paused = true;
  time.speedIdx = 2;
  sys.syncTimeButtons();
  assert.equal(btnPause.textContent, '▶️');
  assert.equal(btnSpeed.textContent, SPEEDS[2] + '×');
});

test('syncTimeButtons is null-safe when time buttons are missing', () => {
  const { sys } = makeUI({ overrides: { btnPause: null, btnSpeed: null } });
  assert.doesNotThrow(() => sys.syncTimeButtons());
});

test('bindUIListeners and unbindUIListeners do not throw when refs are null', () => {
  const { sys } = makeUI({
    overrides: {
      btnPause: null, btnSpeed: null, btnPrior: null,
      btnSave: null, btnNew: null, btnHelpClose: null,
      sheetPrior: null, prioFood: null, prioBuild: null, prioExplore: null,
    },
  });
  assert.doesNotThrow(() => sys.bindUIListeners());
  assert.doesNotThrow(() => sys.unbindUIListeners());
  // Idempotent: a second call should also not throw.
  assert.doesNotThrow(() => sys.bindUIListeners());
});

test('onPriorClick (registered via bindUIListeners) is null-safe when sheetPrior is missing', () => {
  const btnPrior = makeFakeEl();
  // Provide btnPrior so bindUIListeners can attach the click handler,
  // but leave sheetPrior unset (null) so the handler must guard.
  const { sys } = makeUI({ overrides: { btnPrior, sheetPrior: null } });
  sys.bindUIListeners();
  const handlers = btnPrior.listeners.click || [];
  assert.ok(handlers.length >= 1, 'onPriorClick should be registered on btnPrior');
  assert.doesNotThrow(() => handlers[0]({ target: btnPrior }));
});

test('onPauseClick mutates time and updates btnPause via syncTimeButtons', () => {
  const btnPause = makeFakeEl();
  const btnSpeed = makeFakeEl();
  const time = { paused: false, speedIdx: 1 };
  const { sys } = makeUI({ overrides: { btnPause, btnSpeed }, time });
  sys.bindUIListeners();
  const handler = btnPause.listeners.click[0];
  handler({});
  assert.equal(time.paused, true);
  assert.equal(btnPause.textContent, '▶️');
  handler({});
  assert.equal(time.paused, false);
  assert.equal(btnPause.textContent, '⏸');
});

test('loadGame routes through generateWorldBase + resetVolatileState (not newWorld) and calls syncTimeButtons', () => {
  // Pre-populate Storage with a minimal valid save under SAVE_KEY.
  const minimalSave = {
    saveVersion: SAVE_VERSION,
    seed: 12345,
    tiles: [], zone: [], trees: [], rocks: [], berries: [], growth: [],
    season: 0, tSeason: 0,
    buildings: [],
    storageTotals: {},
    storageReserved: {},
    villagers: [],
    animals: [],
  };
  globalThis.localStorage.setItem(SAVE_KEY, JSON.stringify(minimalSave));

  const calls = { generateWorldBase: [], resetVolatileState: 0, syncTimeButtons: 0 };
  // Fresh world object the save layers can apply onto.
  const fakeWorld = {
    tiles: new Uint8Array(0),
    zone: new Uint8Array(0),
    trees: new Uint8Array(0),
    rocks: new Uint8Array(0),
    berries: new Uint8Array(0),
    growth: new Uint8Array(0),
    season: 0, tSeason: 0,
  };
  const buildings = [];
  const villagers = [];
  const animals = [];
  const storageTotals = {};
  const storageReserved = {};
  const toastShown = [];

  const sys = createSaveSystem({
    getWorld: () => fakeWorld,
    getBuildings: () => buildings,
    getVillagers: () => villagers,
    getAnimals: () => animals,
    getStorageTotals: () => storageTotals,
    getStorageReserved: () => storageReserved,
    getTick: () => 0,
    starveThresh: { hungry: 0.4, starving: 0.6, sick: 0.8 },
    childhoodTicks: 100,
    ensureVillagerNumber: (v, n) => { v.displayNumber = n || 1; return v.displayNumber; },
    normalizeExperienceLedger: () => null,
    normalizeArraySource: (a) => Array.isArray(a) ? a : [],
    applyArrayScaled: () => {},
    generateWorldBase: (seed) => { calls.generateWorldBase.push(seed); },
    resetVolatileState: () => { calls.resetVolatileState++; },
    syncTimeButtons: () => { calls.syncTimeButtons++; },
    getFootprint: () => ({ w: 1, h: 1 }),
    ensureBuildingData: () => {},
    reindexAllBuildings: () => {},
    markEmittersDirty: () => {},
    refreshWaterRowMaskFromTiles: () => {},
    refreshZoneRowMask: () => {},
    markZoneOverlayDirty: () => {},
    markStaticDirty: () => {},
    toast: { show: (msg) => toastShown.push(msg) },
  });

  const ok = sys.loadGame();
  assert.equal(ok, true, 'loadGame should return true');
  assert.deepEqual(calls.generateWorldBase, [12345], 'generateWorldBase called once with saved seed');
  assert.equal(calls.resetVolatileState, 1, 'resetVolatileState called exactly once');
  assert.equal(calls.syncTimeButtons, 1, 'syncTimeButtons called exactly once');
  // The misleading new-world toasts must not fire on load.
  assert.ok(!toastShown.includes('New pixel map created.'));
  assert.ok(toastShown.includes('Loaded.'));
});
