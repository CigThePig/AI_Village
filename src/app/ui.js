import { SPEEDS, pxToTileX, pxToTileY } from './constants.js';
import { LIGHTING } from './lighting.js';
import { Storage } from './storage.js';
import { clamp } from './rng.js';
import { MAX_Z, MIN_Z, cam, canvas, clampCam } from './canvas.js';

export function createUISystem(deps) {
  const {
    policy,
    time,
    saveGame,
    newWorld
  } = deps;

  const el = (id) => document.getElementById(id);

  function safeOn(node, event, fn, opts) {
    if (node && typeof node.addEventListener === 'function') node.addEventListener(event, fn, opts);
  }
  function safeOff(node, event, fn, opts) {
    if (node && typeof node.removeEventListener === 'function') node.removeEventListener(event, fn, opts);
  }

  const host = document.createElement('div');
  host.id = 'toastHost';
  host.className = 'toast-host';
  document.body.appendChild(host);

  const Toast = (() => {
    const q = [];
    let showing = 0;

    function show(text, ms = 2200) {
      q.push({ text, ms });
      if (!showing) next();
    }
    function next() {
      if (!q.length) { showing = 0; return; }
      showing = 1;
      const { text, ms } = q.shift();
      const node = document.createElement('div');
      node.className = 'toast';
      node.textContent = text;
      host.appendChild(node);
      setTimeout(() => {
        node.style.transition = 'opacity .2s ease, transform .2s ease';
        node.style.opacity = '0'; node.style.transform = 'translateY(-6px)';
        setTimeout(() => { node.remove(); next(); }, 220);
      }, ms);
    }
    return { show };
  })();

  // Legacy shim for old toast() calls
  window.toast = (msg, ms) => Toast.show(msg, ms);

  const ui = { mode: 'inspect' };

  function openMode(mode) {
    const nextMode = (typeof mode === 'string' && mode.trim()) ? mode : 'inspect';
    ui.mode = nextMode;

    if (typeof document !== 'undefined') {
      const root = document.body || document.documentElement;
      if (root) {
        root.setAttribute('data-mode', nextMode);
      }
    }

    if (typeof canvas !== 'undefined' && canvas && canvas.style) {
      canvas.style.cursor = nextMode === 'inspect' ? 'default' : 'crosshair';
    }

    return ui.mode;
  }

  function toggleSheet(id, open) {
    const node = document.getElementById(id);
    if (!node) return;
    node.setAttribute('data-open', open ? 'true' : 'false');
    node.setAttribute('aria-hidden', open ? 'false' : 'true');
  }

  function closeAllSheets() {
    toggleSheet('sheetMenu', false);
    toggleSheet('sheetPrior', false);
  }

  const uiRefs = {
    btnPause: el('btnPause'),
    btnSpeed: el('btnSpeed'),
    btnMenu: el('btnMenu'),
    btnPrior: el('btnPrior'),
    btnSave: el('btnSave'),
    btnNew: el('btnNew'),
    btnHelp: el('btnHelp'),
    btnHelpClose: el('btnHelpClose'),
    help: el('help'),
    sheetMenu: el('sheetMenu'),
    sheetPrior: el('sheetPrior'),
    prioFood: el('prioFood'),
    prioBuild: el('prioBuild'),
    prioExplore: el('prioExplore')
  };
  const btnSave = uiRefs.btnSave;
  if (!Storage.available && btnSave) {
    btnSave.disabled = true;
    btnSave.title = 'Saving unavailable in this context';
  }

  function syncTimeButtons() {
    if (uiRefs.btnPause) uiRefs.btnPause.textContent = time.paused ? '▶️' : '⏸';
    if (uiRefs.btnSpeed) uiRefs.btnSpeed.textContent = SPEEDS[time.speedIdx] + '×';
  }
  function onPauseClick() {
    time.paused = !time.paused;
    syncTimeButtons();
  }
  function onSpeedClick() {
    time.speedIdx = (time.speedIdx + 1) % SPEEDS.length;
    syncTimeButtons();
  }
  function onMenuClick() {
    if (!uiRefs.sheetMenu) return;
    const open = uiRefs.sheetMenu.getAttribute('data-open') === 'true';
    if (!open) toggleSheet('sheetPrior', false);
    toggleSheet('sheetMenu', !open);
  }
  function onPriorClick() {
    if (!uiRefs.sheetPrior) return;
    toggleSheet('sheetMenu', false);
    const open = uiRefs.sheetPrior.getAttribute('data-open') === 'true';
    toggleSheet('sheetPrior', !open);
  }
  function onSaveClick() {
    if (!Storage.available) { Toast.show('Saving disabled in this context'); return; }
    saveGame();
    Toast.show('Saved.');
    toggleSheet('sheetMenu', false);
  }
  function onNewClick() {
    newWorld();
    toggleSheet('sheetMenu', false);
  }
  function onHelpOpenClick() {
    toggleSheet('sheetMenu', false);
    if (!uiRefs.help) return;
    uiRefs.help.removeAttribute('hidden');
  }
  function onHelpCloseClick() {
    if (!uiRefs.help) return;
    uiRefs.help.setAttribute('hidden', '');
    Storage.set('aiv_help_px3', '1');
  }
  function onSheetMenuClick(e) {
    if (e.target.closest('.sheet-close')) toggleSheet('sheetMenu', false);
  }
  function onSheetPriorClick(e) {
    if (e.target.closest('.sheet-close')) toggleSheet('sheetPrior', false);
  }
  function onDocumentClick(e) {
    if (e.target.closest('.sheet') || e.target.closest('.hud-dock') || e.target.closest('.help-card')) return;
    closeAllSheets();
  }
  function onKeyDown(e) {
    if ((e.key === 'l' || e.key === 'L') && e.altKey) {
      LIGHTING.debugShowLightmap = !LIGHTING.debugShowLightmap;
      e.preventDefault();
    }
  }
  function onPrioFoodInput(e) { policy.sliders.food = (parseInt(e.target.value, 10) || 0) / 100; }
  function onPrioBuildInput(e) { policy.sliders.build = (parseInt(e.target.value, 10) || 0) / 100; }
  function onPrioExploreInput(e) { policy.sliders.explore = (parseInt(e.target.value, 10) || 0) / 100; }

  let uiListenersBound = false;
  function bindUIListeners() {
    if (uiListenersBound) return;
    safeOn(uiRefs.btnPause, 'click', onPauseClick);
    safeOn(uiRefs.btnSpeed, 'click', onSpeedClick);
    safeOn(uiRefs.btnMenu, 'click', onMenuClick);
    safeOn(uiRefs.btnPrior, 'click', onPriorClick);
    safeOn(uiRefs.btnSave, 'click', onSaveClick);
    safeOn(uiRefs.btnNew, 'click', onNewClick);
    safeOn(uiRefs.btnHelp, 'click', onHelpOpenClick);
    safeOn(uiRefs.btnHelpClose, 'click', onHelpCloseClick);
    safeOn(uiRefs.sheetMenu, 'click', onSheetMenuClick);
    safeOn(uiRefs.sheetPrior, 'click', onSheetPriorClick);
    document.addEventListener('click', onDocumentClick);
    window.addEventListener('keydown', onKeyDown);
    safeOn(uiRefs.prioFood, 'input', onPrioFoodInput);
    safeOn(uiRefs.prioBuild, 'input', onPrioBuildInput);
    safeOn(uiRefs.prioExplore, 'input', onPrioExploreInput);
    uiListenersBound = true;
  }
  function unbindUIListeners() {
    if (!uiListenersBound) return;
    safeOff(uiRefs.btnPause, 'click', onPauseClick);
    safeOff(uiRefs.btnSpeed, 'click', onSpeedClick);
    safeOff(uiRefs.btnMenu, 'click', onMenuClick);
    safeOff(uiRefs.btnPrior, 'click', onPriorClick);
    safeOff(uiRefs.btnSave, 'click', onSaveClick);
    safeOff(uiRefs.btnNew, 'click', onNewClick);
    safeOff(uiRefs.btnHelp, 'click', onHelpOpenClick);
    safeOff(uiRefs.btnHelpClose, 'click', onHelpCloseClick);
    safeOff(uiRefs.sheetMenu, 'click', onSheetMenuClick);
    safeOff(uiRefs.sheetPrior, 'click', onSheetPriorClick);
    document.removeEventListener('click', onDocumentClick);
    window.removeEventListener('keydown', onKeyDown);
    safeOff(uiRefs.prioFood, 'input', onPrioFoodInput);
    safeOff(uiRefs.prioBuild, 'input', onPrioBuildInput);
    safeOff(uiRefs.prioExplore, 'input', onPrioExploreInput);
    uiListenersBound = false;
  }

  /* Pointer Input */
  const activePointers = new Map();
  let primaryPointer = null;
  let pinch = null;

  function pointerScale() {
    const r = canvas.getBoundingClientRect();
    return { sx: canvas.width / r.width, sy: canvas.height / r.height };
  }

  function screenToWorld(px, py) {
    const rect = canvas.getBoundingClientRect();
    const sx = (px - rect.left) * (canvas.width / rect.width);
    const sy = (py - rect.top) * (canvas.height / rect.height);
    return {
      x: pxToTileX(sx, cam),
      y: pxToTileY(sy, cam)
    };
  }

  function toTile(v) { return Math.floor(v); }

  function onPointerDown(e) {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    canvas.setPointerCapture(e.pointerId);
    if (e.pointerType === 'touch' && activePointers.size === 2) {
      const pts = Array.from(activePointers.values());
      pinch = {
        startDist: Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y),
        startZ: cam.z,
        midx: (pts[0].x + pts[1].x) / 2,
        midy: (pts[0].y + pts[1].y) / 2
      };
      primaryPointer = null;
    } else if (!primaryPointer) {
      primaryPointer = { id: e.pointerId, sx: e.clientX, sy: e.clientY, camx: cam.x, camy: cam.y };
    }
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!activePointers.has(e.pointerId)) return;
    const p = activePointers.get(e.pointerId);
    p.x = e.clientX; p.y = e.clientY; activePointers.set(e.pointerId, p);
    const { sx: scaleX, sy: scaleY } = pointerScale();
    if (pinch && activePointers.size === 2) {
      const pts = Array.from(activePointers.values());
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const before = screenToWorld(pinch.midx, pinch.midy);
      cam.z = clamp((dist / (pinch.startDist || 1)) * pinch.startZ, MIN_Z, MAX_Z);
      const after = screenToWorld(pinch.midx, pinch.midy);
      cam.x += (after.x - before.x);
      cam.y += (after.y - before.y);
      const midx = (pts[0].x + pts[1].x) / 2;
      const midy = (pts[0].y + pts[1].y) / 2;
      cam.x -= pxToTileX((midx - pinch.midx) * scaleX, cam) - cam.x;
      cam.y -= pxToTileY((midy - pinch.midy) * scaleY, cam) - cam.y;
      pinch.midx = midx; pinch.midy = midy;
      clampCam();
    } else if (primaryPointer && e.pointerId === primaryPointer.id) {
      const dx = (e.clientX - primaryPointer.sx) * scaleX;
      const dy = (e.clientY - primaryPointer.sy) * scaleY;
      const dtX = pxToTileX(dx, cam) - cam.x;
      const dtY = pxToTileY(dy, cam) - cam.y;
      cam.x = primaryPointer.camx - dtX;
      cam.y = primaryPointer.camy - dtY;
      clampCam();
    }
  }

  function endPointer(e) {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.delete(e.pointerId);
    if (primaryPointer && e.pointerId === primaryPointer.id) primaryPointer = null;
    if (activePointers.size < 2) pinch = null;
  }

  function onWheel(e) {
    const delta = Math.sign(e.deltaY); const scale = delta > 0 ? 1 / 1.1 : 1.1; const mx = e.clientX, my = e.clientY;
    const before = screenToWorld(mx, my); cam.z = clamp(cam.z * scale, MIN_Z, MAX_Z); const after = screenToWorld(mx, my);
    cam.x += (after.x - before.x); cam.y += (after.y - before.y); clampCam();
  }

  let canvasInputsBound = false;
  function bindCanvasInputs() {
    if (canvasInputsBound) return;
    canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
    canvas.addEventListener('pointermove', onPointerMove, { passive: false });
    canvas.addEventListener('pointerup', endPointer, { passive: false });
    canvas.addEventListener('pointercancel', endPointer, { passive: false });
    canvas.addEventListener('pointerleave', endPointer, { passive: false });
    canvas.addEventListener('wheel', onWheel);
    canvasInputsBound = true;
  }
  function unbindCanvasInputs() {
    if (!canvasInputsBound) return;
    canvas.removeEventListener('pointerdown', onPointerDown, { passive: false });
    canvas.removeEventListener('pointermove', onPointerMove, { passive: false });
    canvas.removeEventListener('pointerup', endPointer, { passive: false });
    canvas.removeEventListener('pointercancel', endPointer, { passive: false });
    canvas.removeEventListener('pointerleave', endPointer, { passive: false });
    canvas.removeEventListener('wheel', onWheel);
    activePointers.clear();
    primaryPointer = null;
    pinch = null;
    canvasInputsBound = false;
  }

  return {
    Toast,
    ui,
    openMode,
    toggleSheet,
    bindUIListeners,
    unbindUIListeners,
    bindCanvasInputs,
    unbindCanvasInputs,
    syncTimeButtons,
    toTile,
    screenToWorld,
    pointerScale
  };
}
