import { LIGHTING } from './lighting.js';
import { clamp } from './rng.js';

export function createDebugKitBridge(opts) {
  const {
    state,
    ensureVillagerNumber,
    applyShadingMode,
    markStaticDirty,
    getPerfMetrics,
  } = opts;

  let debugKitInstance = null;
  let debugKitWatcherInstalled = false;

  function getWorld() { return state.world; }
  function getDayTime() { return state.time.dayTime; }
  function getVillagers() { return state.units.villagers; }

  function debugKitGetPipeline() {
    const world = getWorld();
    const pipe = world?.__debug?.pipeline;
    if (!Array.isArray(pipe) || pipe.length === 0) {
      return [];
    }
    return pipe.map((entry) => {
      if (!entry) return entry;
      return {
        name: entry.name || '',
        ok: entry.ok === true,
        extra: entry.extra === undefined ? null : entry.extra,
      };
    });
  }

  function describeCanvasContext(ctx) {
    if (!ctx || !ctx.canvas) {
      return null;
    }
    const canvas = ctx.canvas;
    let type = 'unknown';
    if (typeof ctx.getContextAttributes === 'function') {
      type = 'webgl';
    } else if (typeof ctx.getImageData === 'function') {
      type = '2d';
    }
    return {
      type,
      size: {
        width: Number.isFinite(canvas.width) ? canvas.width : null,
        height: Number.isFinite(canvas.height) ? canvas.height : null,
      },
    };
  }

  function debugKitGetLightingProbe() {
    const world = getWorld();
    const mode = LIGHTING?.mode ?? 'unknown';
    const useMultiply = LIGHTING?.useMultiplyComposite === true;
    const scale = Number.isFinite(LIGHTING?.lightmapScale) ? LIGHTING.lightmapScale : null;
    const hillshadeQ = world?.hillshadeQ || null;
    const lightmapQ = world?.lightmapQ || null;
    const statsFn = (debugKitInstance && typeof debugKitInstance.arrMinMax === 'function')
      ? debugKitInstance.arrMinMax
      : null;
    const hillshadeStats = statsFn && hillshadeQ ? statsFn(hillshadeQ) : null;
    const lightmapStats = statsFn && lightmapQ ? statsFn(lightmapQ) : null;
    const reasons = [];
    let canMultiply = useMultiply;

    if (!world) {
      reasons.push('World not initialized');
      canMultiply = false;
    } else {
      if (mode === 'off') {
        reasons.push('Lighting mode set to off');
        canMultiply = false;
      }
      if (!world.lightmapCtx) {
        reasons.push('lightmapCtx missing');
        canMultiply = false;
      }
      if (!lightmapQ) {
        reasons.push('lightmapQ not built');
        canMultiply = false;
      }
    }

    return {
      mode,
      useMultiplyComposite: useMultiply,
      lightmapScale: scale,
      contexts: {
        lightmap: describeCanvasContext(world?.lightmapCtx || null),
        albedo: describeCanvasContext(world?.staticAlbedoCtx || null),
      },
      hillshadeQ,
      lightmapQ,
      HqMin: hillshadeStats ? hillshadeStats.min : null,
      HqMax: hillshadeStats ? hillshadeStats.max : null,
      LqMin: lightmapStats ? lightmapStats.min : null,
      LqMax: lightmapStats ? lightmapStats.max : null,
      canMultiply,
      reasons,
    };
  }

  function debugKitEnterSafeMode() {
    const world = getWorld();
    try {
      if (typeof applyShadingMode === 'function') {
        applyShadingMode('off');
      } else if (LIGHTING) {
        LIGHTING.mode = 'off';
        LIGHTING.useMultiplyComposite = false;
      }
      if (world) {
        world.lightmapQ = null;
        if (world.lightmapCtx && world.lightmapCanvas) {
          try {
            world.lightmapCtx.clearRect(0, 0, world.lightmapCanvas.width, world.lightmapCanvas.height);
          } catch (_err) {
            /* ignore */
          }
        }
        if (typeof markStaticDirty === 'function') {
          markStaticDirty();
        }
      }
    } catch (err) {
      console.warn('DebugKit safe mode failed', err);
    }
  }

  function debugKitGetPerf() {
    if (typeof getPerfMetrics !== 'function') return null;
    const m = getPerfMetrics();
    if (!m) return null;
    const out = {
      ticks: m.__ticks || 0,
      buildings: Array.isArray(state?.units?.buildings) ? state.units.buildings.length : 0,
      villagers: Array.isArray(state?.units?.villagers) ? state.units.villagers.length : 0,
    };
    for (const k of Object.keys(m)) {
      if (k.startsWith('__')) continue;
      out[k] = Number.isFinite(m[k]) ? +m[k].toFixed(3) : 0;
    }
    return out;
  }

  function debugKitGetState() {
    const world = getWorld();
    const villagers = getVillagers();
    const villagerCount = Array.isArray(villagers) ? villagers.length : 0;
    let snapshotTime = null;
    if (world?.clock && Number.isFinite(world.clock.timeOfDay)) {
      snapshotTime = world.clock.timeOfDay;
    } else if (Number.isFinite(getDayTime())) {
      snapshotTime = getDayTime();
    }
    // Phase 1: shallow-copy layout for the slot overlay. The Map is converted
    // to a plain object so the debug payload is JSON-serializable.
    let layout = null;
    if (world?.layout) {
      const occ = world.layout.occupancy;
      const occupancy = {};
      if (occ && typeof occ.forEach === 'function') {
        occ.forEach((value, key) => { occupancy[key] = value; });
      }
      layout = {
        archetype: world.layout.archetype,
        origin: world.layout.origin,
        anchors: world.layout.anchors,
        slots: world.layout.slots.map((s) => ({
          id: s.id,
          family: s.family,
          footprint: s.footprint,
          capacity: s.capacity,
          kindAffinity: s.kindAffinity
        })),
        occupancy,
        features: world.layout.features
      };
    }
    const villagerDetails = Array.isArray(villagers)
      ? villagers.map((v) => ({
          id: v.id,
          number: ensureVillagerNumber(v),
          role: v.role,
          lifeStage: v.lifeStage,
          state: v.state,
          thought: v.thought,
          condition: v.condition,
          hunger: clamp(Number.isFinite(v.hunger) ? v.hunger : 0, 0, 1),
          energy: clamp(Number.isFinite(v.energy) ? v.energy : 0, 0, 1),
          hydration: clamp(Number.isFinite(v.hydration) ? v.hydration : 0, 0, 1),
          happy: clamp(Number.isFinite(v.happy) ? v.happy : 0, 0, 1),
          position: { x: v.x, y: v.y },
          targetJob: v.targetJob
            ? { type: v.targetJob.type, x: v.targetJob.x, y: v.targetJob.y, bid: v.targetJob.bid ?? null }
            : null,
          carrying: v.inv ? { type: v.inv.type, qty: v.inv.qty ?? 1 } : null,
          activeBuildingId: v.activeBuildingId ?? null,
        }))
      : [];
    // Phase 2: surface the rectangular farm plots (a small, fully JSON-safe
    // array) so the debug overlay's refresh button can show plot counts and
    // tests/tools can introspect plot geometry without poking world directly.
    const farmPlots = Array.isArray(world?.farmPlots)
      ? world.farmPlots.map((p) => ({
          id: p.id,
          slotId: p.slotId,
          x: p.x, y: p.y, w: p.w, h: p.h,
          orientation: p.orientation,
          abutsWells: !!p.abutsWells,
          abutsNeighbor: !!p.abutsNeighbor
        }))
      : [];
    return {
      frame: world?.__debug?.lastFrame ?? 0,
      timeOfDay: snapshotTime,
      villagers: villagerCount,
      lightingMode: LIGHTING?.mode ?? 'unknown',
      multiplyComposite: LIGHTING?.useMultiplyComposite === true,
      layout,
      farmPlots,
      villagerDetails,
    };
  }

  function configureDebugKitBridge(instance) {
    if (!instance || typeof instance.configure !== 'function') {
      return;
    }
    debugKitInstance = instance;
    try {
      instance.configure({
        getPipeline: debugKitGetPipeline,
        getLightingProbe: debugKitGetLightingProbe,
        onSafeMode: debugKitEnterSafeMode,
        getState: debugKitGetState,
        getPerf: debugKitGetPerf,
      });
    } catch (err) {
      console.warn('DebugKit configure failed', err);
    }
  }

  function installDebugKitWatcher() {
    if (debugKitWatcherInstalled || typeof window === 'undefined') {
      return;
    }
    debugKitWatcherInstalled = true;
    let currentKit = window.DebugKit;
    const descriptor = Object.getOwnPropertyDescriptor(window, 'DebugKit');
    const canRedefine = !descriptor || descriptor.configurable === true;
    if (canRedefine) {
      Object.defineProperty(window, 'DebugKit', {
        configurable: true,
        enumerable: true,
        get() {
          return currentKit;
        },
        set(value) {
          currentKit = value;
          if (value && typeof value.configure === 'function') {
            configureDebugKitBridge(value);
          }
        },
      });
    }
    if (currentKit && typeof currentKit.configure === 'function') {
      configureDebugKitBridge(currentKit);
    }
  }

  function ensureDebugKitConfigured() {
    if (debugKitInstance) {
      configureDebugKitBridge(debugKitInstance);
    } else if (typeof window !== 'undefined' && window.DebugKit != null) {
      configureDebugKitBridge(window.DebugKit);
    }
  }

  function attachToWindow() {
    if (typeof window === 'undefined') return;
    installDebugKitWatcher();
    if (window.DebugKit != null) {
      configureDebugKitBridge(window.DebugKit);
    }
    const prevReady = typeof window.__AIV_DEBUGKIT_READY__ === 'function'
      ? window.__AIV_DEBUGKIT_READY__
      : null;
    window.__AIV_DEBUGKIT_READY__ = function (kit) {
      try {
        configureDebugKitBridge(kit);
      } finally {
        if (prevReady && prevReady !== window.__AIV_DEBUGKIT_READY__) {
          try { prevReady(kit); } catch (err) { console.warn('DebugKit ready hook failed', err); }
        }
      }
    };
  }

  return {
    debugKitGetPipeline,
    debugKitGetLightingProbe,
    debugKitEnterSafeMode,
    debugKitGetState,
    debugKitGetPerf,
    configureDebugKitBridge,
    installDebugKitWatcher,
    ensureDebugKitConfigured,
    attachToWindow,
  };
}
