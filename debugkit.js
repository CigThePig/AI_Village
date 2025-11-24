(function () {
  const DEBUG = (() => {
    const qsDebug = new URLSearchParams(location.search).get('debug') == '1';
    try {
      return qsDebug || localStorage.getItem('debug') == 'true';
    } catch (err) {
      return qsDebug;
    }
  })();
  if (!DEBUG) {
    return;
  }

  const MAX_LOGS = 1500;
  const BODY_PREVIEW = 1200;
  const REDACT_HEADERS = ['authorization', 'cookie', 'x-api-key'];
  const REDACT_QUERY = ['token', 'key', 'apikey', 'password', 'passwd', 'auth', 'signature'];
  const REDACT_STORAGE_KEYS = ['token', 'key', 'auth', 'secret', 'password'];

  let logs = [];
  let pendingLogs = [];
  let autoscroll = true;
  let paused = false;
  let netHook = true;
  let dragging = false;
  let dragPointerId = null;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let stateProvider = null;
  let html2cReady = false;
  let html2cLoading = false;
  let renderScheduled = false;
  let filterMode = 'ALL';
  let searchTerm = '';
  let fpsActive = false;
  let fpsHandle = null;
  let fpsFrameCount = 0;
  let fpsLastTime = 0;
  let logId = 0;
  let connectionListenerAttached = false;
  let trayCollapsed = false;
  let appGetLightingProbe = null;
  let appGetPipeline = null;
  let appEnterSafeMode = null;

  const doc = document;
  const win = window;

  const sectionState = Object.create(null);

  const style = doc.createElement('style');
  style.textContent = `
    #dbgTray {
      --dbg-head-height: 0px;
      --dbg-vertical-margins: calc(20px + env(safe-area-inset-bottom, 0));
      position: fixed;
      left: 8px;
      bottom: calc(8px + env(safe-area-inset-bottom, 0));
      max-width: min(720px, 95vw);
      width: min(720px, calc(100vw - 12px));
      max-height: calc(100vh - 16px - env(safe-area-inset-bottom, 0));
      background: #0f1522;
      color: #e8eefc;
      border: 1px solid #2a3550;
      border-radius: 16px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px;
      line-height: 1.35;
      z-index: 2147483647;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
    }
    #dbgTray.collapsed {
      max-height: none;
      width: auto;
      min-width: 240px;
      max-width: min(420px, 90vw);
    }
    #dbgTray.collapsed #dbgHead {
      padding: 8px 10px;
      gap: 8px;
    }
    #dbgTray.collapsed #dbgContent {
      display: none;
      min-height: 0;
    }
    #dbgTray.collapsed #dbgBody { display: none; }
    #dbgTray.collapsed #dbgRowB,
    #dbgTray.collapsed #dbgRowC,
    #dbgTray.collapsed #dbgVillagerSection { display: none; }
    #dbgTray.collapsed .dbg-aux { display: none; }
    #dbgHead {
      background: #141c2c;
      border-bottom: 1px solid #2a3550;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px;
      touch-action: none;
      user-select: none;
      position: sticky;
      top: 0;
      z-index: 2;
    }
    #dbgRowA, #dbgRowB, #dbgRowC {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      overflow-x: auto;
      scrollbar-width: thin;
      row-gap: 10px;
    }
    #dbgRowA .dbg-title {
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    #dbgRowA .dbg-spacer {
      flex: 1;
    }
    #dbgContent {
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      overflow-x: hidden;
      min-height: 0;
      -webkit-overflow-scrolling: touch;
    }
    #dbgBody {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      padding: 10px;
      background: #0f1522;
      white-space: pre-wrap;
      word-break: break-word;
      -webkit-overflow-scrolling: touch;
    }
    #dbgVillagerSection {
      background: #0c111d;
      border-bottom: 1px solid #1f2a3d;
      flex: 0 0 auto;
      min-height: 0;
      overflow: auto;
      padding: 10px;
    }
    #dbgVillagerSection .dbg-villagers-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-weight: 700;
      letter-spacing: 0.02em;
      margin-bottom: 6px;
    }
    #dbgVillagerSection .dbg-villagers-title {
      display: flex;
      align-items: baseline;
      gap: 10px;
    }
    #dbgVillagerList {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .dbg-villager-row {
      border: 1px solid #1f2a3d;
      border-radius: 10px;
      padding: 6px 8px;
      background: #12192a;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.03);
    }
    .dbg-villager-row .dbg-villager-meta {
      font-size: 12px;
      opacity: 0.8;
      display: flex;
      flex-wrap: wrap;
      gap: 6px 12px;
    }
    .dbg-villager-row .dbg-villager-state {
      font-size: 13px;
      margin: 4px 0;
    }
    .dbg-villager-row .dbg-villager-bars {
      display: flex;
      gap: 6px;
      font-size: 12px;
    }
    .dbg-villagers-empty {
      font-size: 13px;
      opacity: 0.75;
      padding: 4px 2px;
    }
    #dbgBody::-webkit-scrollbar {
      width: 8px;
    }
    #dbgBody::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.15);
      border-radius: 4px;
    }
    #dbgPill {
      position: fixed;
      bottom: calc(16px + env(safe-area-inset-bottom, 0));
      right: 16px;
      background: #141c2c;
      color: #e8eefc;
      border: 1px solid #2a3550;
      border-radius: 999px;
      padding: 10px 18px;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.4);
      display: none;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      letter-spacing: 0.04em;
      cursor: pointer;
      z-index: 2147483647;
    }
    #dbgTray button,
    #dbgTray select,
    #dbgTray input[type="text"],
    #dbgTray input[type="search"],
    #dbgTray input[type="number"],
    #dbgTray label {
      min-height: 34px;
      border-radius: 10px;
      border: 1px solid #2a3550;
      background: #10192b;
      color: #e8eefc;
      padding: 7px 12px;
      font-size: 14px;
    }
    #dbgTray button,
    #dbgTray select {
      cursor: pointer;
    }
    #dbgTray button:hover,
    #dbgTray button:focus {
      background: #19253c;
      outline: none;
    }
    #dbgTray button:active {
      background: #0d1422;
    }
    #dbgTray input[type="text"],
    #dbgTray select {
      flex: 1;
    }
    #dbgTray label {
      display: flex;
      align-items: center;
      gap: 8px;
      padding-right: 12px;
    }
    #dbgTray label input {
      margin: 0;
    }
    #dbgTray .dbg-section {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 8px;
      border: 1px solid #1f2a3d;
      border-radius: 12px;
      background: #0f1522;
      flex: 1 1 240px;
      min-width: 200px;
    }
    #dbgTray .dbg-section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    #dbgTray .dbg-section-title {
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    #dbgTray .dbg-section-toggle {
      min-height: 30px;
      padding: 4px 10px;
      font-size: 12px;
    }
    #dbgTray .dbg-section-body {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    #dbgTray .dbg-section[data-collapsed="true"] .dbg-section-body {
      display: none;
    }
    #dbgTray .dbg-shade-control {
      flex: 0 1 auto;
      min-width: 0;
      gap: 6px;
      font-size: 12px;
    }
    #dbgTray .dbg-shade-control input[type="range"] {
      flex: 1 1 80px;
      min-width: 60px;
    }
    #dbgTray .dbg-shade-value {
      min-width: 40px;
      text-align: right;
      font-variant-numeric: tabular-nums;
      font-size: 12px;
      opacity: 0.75;
    }
    #dbgTray .dbg-shade-state {
      font-size: 12px;
      opacity: 0.75;
      margin-left: 4px;
    }
    #dbgTray select.dbg-shade-mode {
      flex: 0 0 auto;
    }
    .dbg-row {
      padding: 6px 8px;
      border-left: 4px solid transparent;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .dbg-row:last-child {
      border-bottom: none;
    }
    .dbg-row .dbg-time {
      font-size: 12px;
      opacity: 0.65;
      margin-right: 6px;
    }
    .dbg-row .dbg-kind {
      font-weight: 600;
      margin-right: 6px;
    }
    .dbg-row .dbg-data {
      margin-top: 4px;
      font-size: 12px;
      opacity: 0.85;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .dbg-row.dbg-error { border-left-color: #ff7f8a; }
    .dbg-row.dbg-warn { border-left-color: #ffd85e; }
    .dbg-row.dbg-net { border-left-color: #8ff0a4; }
    .dbg-row.dbg-note { border-left-color: #7db4ff; }
    #dbgTray input[type="text"].dbg-selector {
      flex: 1 1 auto;
    }
    #dbgHead button.small {
      padding: 5px 12px;
      min-width: 64px;
    }
    #dbgTray .dbg-viewport {
      font-size: 12px;
      opacity: 0.75;
      margin-left: auto;
    }
    @media (max-width: 640px) {
      #dbgTray {
        left: 4px;
        right: 4px;
        max-width: none;
        width: calc(100vw - 8px);
        max-height: calc(100vh - 12px - env(safe-area-inset-bottom, 0));
      }
      #dbgHead {
        gap: 8px;
        padding: 10px 10px 8px;
      }
      #dbgRowA, #dbgRowB, #dbgRowC {
        flex-wrap: wrap;
        gap: 8px;
        padding-bottom: 2px;
      }
      #dbgRowA::-webkit-scrollbar,
      #dbgRowB::-webkit-scrollbar,
      #dbgRowC::-webkit-scrollbar {
        display: none;
      }
      #dbgContent {
        min-height: 0;
        max-height: calc(100vh - var(--dbg-head-height, 180px) - var(--dbg-vertical-margins, 24px));
      }
      #dbgVillagerSection {
        flex-basis: auto;
      }
      #dbgTray label {
        flex: 1 1 120px;
      }
    }
  `;
  doc.head.appendChild(style);

  function el(tag, attrs, children) {
    const element = doc.createElement(tag);
    if (attrs) {
      for (const key in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
        const value = attrs[key];
        if (key === 'style' && value && typeof value === 'object') {
          Object.assign(element.style, value);
        } else if (key.startsWith('on') && typeof value === 'function') {
          element.addEventListener(key.slice(2), value);
        } else if (key === 'className') {
          element.className = value;
        } else if (key === 'text') {
          element.textContent = value;
        } else if (key === 'checked' && value === 'checked') {
          element.checked = true;
        } else {
          element.setAttribute(key, value);
        }
      }
    }
    if (children != null) {
      if (Array.isArray(children)) {
        for (const child of children) {
          if (child == null) continue;
          element.appendChild(typeof child === 'string' ? doc.createTextNode(child) : child);
        }
      } else {
        element.appendChild(typeof children === 'string' ? doc.createTextNode(children) : children);
      }
    }
    return element;
  }

  function safeStringify(value) {
    const seen = new WeakSet();
    return JSON.stringify(value, function (key, val) {
      if (typeof val === 'bigint') {
        return val.toString() + 'n';
      }
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) {
          return '[Circular]';
        }
        seen.add(val);
      }
      if (val instanceof Error) {
        return {
          name: val.name,
          message: val.message,
          stack: val.stack
        };
      }
      return val;
    }, 2);
  }

  function fmt(v) {
    if (v == null) return String(v);
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v === 'bigint') return v.toString() + 'n';
    if (v instanceof Error) {
      return v.stack || (v.name + ': ' + v.message);
    }
    if (typeof v === 'function') {
      return `[Function ${v.name || 'anonymous'}]`;
    }
    if (typeof v === 'object') {
      try {
        return safeStringify(v);
      } catch (err) {
        return '[Unserializable Object]';
      }
    }
    return String(v);
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  // Optional: a quick min/max helper for Float32Array-like inputs
  function arrMinMax(a) {
    if (!a || !a.length) return { min: null, max: null };
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < a.length; i++) {
      const v = a[i]; if (v < mn) mn = v; if (v > mx) mx = v;
    }
    return { min: +mn.toFixed(3), max: +mx.toFixed(3) };
  }

  function shouldRedactKey(key) {
    const lower = String(key).toLowerCase();
    return REDACT_QUERY.some(q => lower.includes(q));
  }

  function redactObj(obj) {
    try {
      const seen = new WeakMap();
      function clone(value) {
        if (value == null) return value;
        if (typeof value === 'bigint') return value.toString() + 'n';
        if (typeof value !== 'object') return value;
        if (value instanceof Date) return value.toISOString();
        if (value instanceof Error) {
          return {
            name: value.name,
            message: value.message,
            stack: value.stack
          };
        }
        if (seen.has(value)) return '[Circular]';
        seen.set(value, true);
        if (Array.isArray(value)) {
          return value.map(clone);
        }
        const out = {};
        for (const key of Object.keys(value)) {
          if (shouldRedactKey(key)) {
            out[key] = '***';
          } else {
            out[key] = clone(value[key]);
          }
        }
        return out;
      }
      return clone(obj);
    } catch (err) {
      return fmt(obj);
    }
  }

  function redactURL(input) {
    if (!input) return input;
    try {
      const url = new URL(input, location.href);
      url.searchParams.forEach((value, key) => {
        if (shouldRedactKey(key)) {
          url.searchParams.set(key, '***');
        }
      });
      const sameOrigin = input.startsWith('/') || input.startsWith('?') || (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input));
      if (sameOrigin) {
        return url.pathname + url.search + url.hash;
      }
      return url.toString();
    } catch (err) {
      return input;
    }
  }

  function storagePairs(storage) {
    const items = [];
    if (!storage) return items;
    const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key == null) continue;
      let value = null;
      let bytes = 0;
      try {
        value = storage.getItem(key);
        if (typeof value === 'string') {
          bytes = encoder ? encoder.encode(value).length : value.length;
        }
      } catch (err) {
        value = '[unavailable]';
      }
      const lower = key.toLowerCase();
      const sensitive = REDACT_STORAGE_KEYS.some(part => lower.includes(part));
      const entry = { key, bytes };
      if (!sensitive && value != null) {
        entry.value = value;
      } else if (sensitive) {
        entry.value = '***';
      }
      items.push(entry);
    }
    return items;
  }

  function makeLog(kind, text, data) {
    return {
      id: ++logId,
      tsISO: new Date().toISOString(),
      kind,
      text,
      data: data === undefined ? undefined : data
    };
  }

  function pushLog(entry) {
    logs.push(entry);
    if (logs.length > MAX_LOGS) {
      logs.splice(0, logs.length - MAX_LOGS);
    }
  }

  function add(kind, text, data) {
    const safeData = data === undefined ? undefined : ensureDataSafe(data);
    const entry = makeLog(kind, typeof text === 'string' ? text : fmt(text), safeData);
    if (paused) {
      if (pendingLogs.length >= MAX_LOGS) {
        pendingLogs.shift();
      }
      pendingLogs.push(entry);
      return;
    }
    pushLog(entry);
    scheduleRender();
  }

  function flushPending() {
    if (!pendingLogs.length) return;
    for (const entry of pendingLogs) {
      pushLog(entry);
    }
    pendingLogs = [];
    scheduleRender();
  }
  function createSection(id, title, defaultCollapsed) {
    const toggle = el('button', {
      className: 'dbg-section-toggle',
      'aria-expanded': defaultCollapsed ? 'false' : 'true',
      'aria-label': `${defaultCollapsed ? 'Expand' : 'Collapse'} ${title} section`
    }, defaultCollapsed ? 'Expand' : 'Collapse');
    const headTitle = el('span', { className: 'dbg-section-title', text: title });
    const head = el('div', { className: 'dbg-section-head' }, [headTitle, toggle]);
    const body = el('div', { className: 'dbg-section-body' });
    const section = el('div', {
      id,
      className: 'dbg-section',
      'data-collapsed': defaultCollapsed ? 'true' : 'false'
    });

    function setCollapsed(collapsed) {
      const value = !!collapsed;
      sectionState[id] = value;
      section.setAttribute('data-collapsed', value ? 'true' : 'false');
      toggle.textContent = value ? 'Expand' : 'Collapse';
      toggle.setAttribute('aria-expanded', value ? 'false' : 'true');
      toggle.setAttribute('aria-label', `${value ? 'Expand' : 'Collapse'} ${title} section`);
    }

    setCollapsed(defaultCollapsed);
    toggle.addEventListener('click', () => setCollapsed(!sectionState[id]));

    section.append(head, body);
    return { section, head, body, toggle, setCollapsed };
  }

  const tray = el('div', { id: 'dbgTray' });
  const head = el('div', { id: 'dbgHead' });
  const content = el('div', { id: 'dbgContent' });
  const rowA = el('div', { id: 'dbgRowA' });
  const rowB = el('div', { id: 'dbgRowB' });
  const rowC = el('div', { id: 'dbgRowC' });
  const body = el('div', { id: 'dbgBody' });
  const narrowLayout = win.innerWidth <= 720;
  const villagerSectionParts = createSection('dbgVillagerSection', 'Villagers', narrowLayout);
  const villagerSection = villagerSectionParts.section;
  const villagerHead = villagerSectionParts.head;
  const villagerTitle = el('span', { text: 'Villagers' });
  const villagerUpdated = el('span', { className: 'dbg-villager-updated', text: 'Waiting…' });
  const villagerList = el('div', { id: 'dbgVillagerList' });
  const villagerEmpty = el('div', { className: 'dbg-villagers-empty', text: 'No villager data yet.' });
  const pill = el('div', { id: 'dbgPill', text: 'Debug' });

  const viewportLabel = el('span', { className: 'dbg-viewport' });
  const collapseBtn = el('button', { className: 'small', 'aria-label': 'Collapse debug panel' }, 'Collapse');
  const hideBtn = el('button', { className: 'small', 'aria-label': 'Hide debug panel' }, 'Hide');
  const copyBtn = el('button', null, 'Copy');
  const exportBtn = el('button', null, 'Export');
  const shareBtn = el('button', null, 'Share');
  const clearBtn = el('button', null, 'Clear');
  const pauseBtn = el('button', null, 'Pause');
  const markBtn = el('button', null, 'Mark');
  const stateBtn = el('button', null, 'State');
  const fpsInput = el('input', { type: 'checkbox' });
  const fpsLabel = el('label', null, [fpsInput, doc.createTextNode('FPS')]);
  const netInput = el('input', { type: 'checkbox', checked: 'checked' });
  const netLabel = el('label', null, [netInput, doc.createTextNode('Net')]);
  const filterSelect = el('select', null, [
    el('option', { value: 'ALL', text: 'All' }),
    el('option', { value: 'ERROR', text: 'Errors' }),
    el('option', { value: 'WARN', text: 'Warn' }),
    el('option', { value: 'NET', text: 'Network' }),
    el('option', { value: 'NOTE', text: 'Notes' })
  ]);
  const searchInput = el('input', { type: 'text', placeholder: 'Search…' });
  const shadingSelect = el('select', { className: 'dbg-shade-mode', title: 'Terrain shading mode' }, [
    el('option', { value: 'off', text: 'Off' }),
    el('option', { value: 'altitude', text: 'Altitude' }),
    el('option', { value: 'hillshade', text: 'Hillshade' })
  ]);
  const ambientInput = el('input', { type: 'range', min: '0', max: '1', step: '0.01' });
  ambientInput.classList.add('dbg-shade-slider');
  const ambientValue = el('span', { className: 'dbg-shade-value', text: '--' });
  const ambientLabel = el('label', { className: 'dbg-shade-control', title: 'Ambient light floor' }, [
    'Ambient',
    ambientInput,
    ambientValue
  ]);
  const intensityInput = el('input', { type: 'range', min: '0', max: '1', step: '0.01' });
  intensityInput.classList.add('dbg-shade-slider');
  const intensityValue = el('span', { className: 'dbg-shade-value', text: '--' });
  const intensityLabel = el('label', { className: 'dbg-shade-control', title: 'Shade contrast' }, [
    'Intensity',
    intensityInput,
    intensityValue
  ]);
  const slopeInput = el('input', { type: 'range', min: '0.10', max: '16', step: '0.05' });
  slopeInput.classList.add('dbg-shade-slider');
  const slopeValue = el('span', { className: 'dbg-shade-value', text: '--' });
  const slopeLabel = el('label', { className: 'dbg-shade-control', title: 'Slope influence' }, [
    'Slope',
    slopeInput,
    slopeValue
  ]);
  const shadingStateLabel = el('span', { className: 'dbg-shade-state', text: 'Shade: loading…' });
  const shadingSection = createSection('dbgShadeSection', 'Shading', narrowLayout);
  shadingSection.body.append(shadingSelect, ambientLabel, intensityLabel, slopeLabel, shadingStateLabel);
  const perfBtn = el('button', null, 'Perf');
  const connBtn = el('button', null, 'Conn');
  const permsBtn = el('button', null, 'Perms');
  const geoBtn = el('button', null, 'Geo');
  const keysBtn = el('button', null, 'Keys');
  const selectorInput = el('input', { type: 'text', placeholder: 'CSS selector', className: 'dbg-selector' });
  const rectBtn = el('button', null, 'Rect');
  const shotBtn = el('button', null, 'Shot');
  const diagBtn = el('button', null, 'Diag');
  const safeBtn = el('button', null, 'Safe');
  const filterSection = createSection('dbgFilterSection', 'Network & Filters', narrowLayout);
  filterSection.body.append(netLabel, filterSelect, searchInput);

  copyBtn.classList.add('dbg-aux');
  exportBtn.classList.add('dbg-aux');
  shareBtn.classList.add('dbg-aux');
  clearBtn.classList.add('dbg-aux');
  pauseBtn.classList.add('dbg-aux');

  rowA.append(
    el('span', { className: 'dbg-title', text: 'Debug' }),
    collapseBtn,
    hideBtn,
    copyBtn,
    exportBtn,
    shareBtn,
    clearBtn,
    pauseBtn,
    el('span', { className: 'dbg-spacer' }),
    viewportLabel
  );

  rowB.append(
    markBtn,
    stateBtn,
    shadingSection.section,
    filterSection.section,
    fpsLabel
  );

  rowC.append(
    perfBtn,
    connBtn,
    permsBtn,
    geoBtn,
    keysBtn,
    selectorInput,
    rectBtn,
    shotBtn
  );
  rowC.append(diagBtn, safeBtn);

  head.append(rowA, rowB, rowC);
  villagerHead.classList.add('dbg-villagers-head');
  villagerHead.replaceChildren(
    el('span', { className: 'dbg-villagers-title' }, [villagerTitle, villagerUpdated]),
    villagerSectionParts.toggle
  );
  villagerSectionParts.body.append(villagerList, villagerEmpty);
  villagerSection.append(villagerHead, villagerSectionParts.body);
  content.append(villagerSection, body);
  tray.append(head, content);
  doc.body.appendChild(tray);
  doc.body.appendChild(pill);

  function updateHeadMetrics() {
    requestAnimationFrame(() => {
      const headRect = head.getBoundingClientRect();
      tray.style.setProperty('--dbg-head-height', Math.round(headRect.height) + 'px');
    });
  }

  updateHeadMetrics();

  let shadingHooksInstalled = false;
  let shadingSyncInterval = null;

  function clampShadeUnit(value) {
    if (!Number.isFinite(value)) {
      return 0;
    }
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }

  function clampSlopeScale(value) {
    if (!Number.isFinite(value)) {
      return 1;
    }
    return clamp(value, 0.1, 16);
  }

  function normalizeShadeModeValue(value) {
    const lower = value == null ? '' : String(value).toLowerCase();
    if (lower === 'off' || lower === 'altitude' || lower === 'hillshade') {
      return lower;
    }
    return 'hillshade';
  }

  function shadingAPIAvailable() {
    return typeof win.setShadingMode === 'function' && typeof win.setShadingParams === 'function' && !!win.SHADING_DEFAULTS;
  }

  function readShadingState() {
    if (!shadingAPIAvailable()) {
      return null;
    }
    const defaults = win.SHADING_DEFAULTS || {};
    return {
      mode: normalizeShadeModeValue(defaults.mode),
      ambient: clampShadeUnit(Number(defaults.ambient)),
      intensity: clampShadeUnit(Number(defaults.intensity)),
      slopeScale: clampSlopeScale(Number(defaults.slopeScale))
    };
  }

  function formatShadeValue(value) {
    return clampShadeUnit(value).toFixed(2);
  }

  function formatSlopeValue(value) {
    return clampSlopeScale(value).toFixed(2);
  }

  function syncShadingControls() {
    const state = readShadingState();
    const available = !!state;
    shadingSelect.disabled = !available;
    ambientInput.disabled = !available;
    intensityInput.disabled = !available;
    slopeInput.disabled = !available;
    if (!available) {
      shadingSelect.value = 'off';
      ambientValue.textContent = '--';
      intensityValue.textContent = '--';
      slopeInput.value = '1';
      slopeValue.textContent = '--';
      shadingStateLabel.textContent = 'Shade: loading…';
      return;
    }
    shadingSelect.value = state.mode;
    ambientInput.value = formatShadeValue(state.ambient);
    intensityInput.value = formatShadeValue(state.intensity);
    ambientValue.textContent = formatShadeValue(state.ambient);
    intensityValue.textContent = formatShadeValue(state.intensity);
    const slope = clampSlopeScale(state.slopeScale);
    slopeInput.value = String(slope);
    slopeValue.textContent = formatSlopeValue(slope);
    const label = state.mode === 'hillshade' ? 'Hillshade' : state.mode === 'altitude' ? 'Altitude' : 'Off';
    shadingStateLabel.textContent = `Shade: ${label} a=${formatShadeValue(state.ambient)} i=${formatShadeValue(state.intensity)} s=${formatSlopeValue(slope)}`;
  }

  function ensureShadingMonitoring() {
    if (!shadingAPIAvailable()) {
      return;
    }
    if (!shadingHooksInstalled) {
      const originalMode = win.setShadingMode;
      const originalParams = win.setShadingParams;
      win.setShadingMode = function (mode) {
        const result = originalMode.apply(this, arguments);
        syncShadingControls();
        return result;
      };
      win.setShadingParams = function (params) {
        const result = originalParams.apply(this, arguments);
        syncShadingControls();
        return result;
      };
      shadingHooksInstalled = true;
    }
    if (shadingSyncInterval == null) {
      shadingSyncInterval = setInterval(syncShadingControls, 1000);
    }
    syncShadingControls();
  }

  syncShadingControls();
  ensureShadingMonitoring();
  const shadingReadyWatcher = setInterval(() => {
    if (!shadingHooksInstalled) {
      ensureShadingMonitoring();
    }
    if (shadingHooksInstalled) {
      clearInterval(shadingReadyWatcher);
    }
  }, 500);
  win.addEventListener('focus', syncShadingControls);

  function setCollapsedState(value) {
    trayCollapsed = !!value;
    tray.classList.toggle('collapsed', trayCollapsed);
    collapseBtn.textContent = trayCollapsed ? 'Expand' : 'Collapse';
    collapseBtn.setAttribute('aria-expanded', trayCollapsed ? 'false' : 'true');
    collapseBtn.setAttribute('aria-label', trayCollapsed ? 'Expand debug panel' : 'Collapse debug panel');
    updateHeadMetrics();
  }

  setCollapsedState(false);
  if (win.innerWidth <= 768 || win.innerHeight <= 640) {
    setCollapsedState(true);
  }

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(renderLogs);
  }

  function formatPercent(value) {
    if (!Number.isFinite(value)) return '--';
    return Math.round(clamp(value, 0, 1) * 100) + '%';
  }

  function renderVillagerDetails() {
    if (!villagerSection.isConnected) return;
    if (typeof stateProvider !== 'function') {
      villagerUpdated.textContent = 'Awaiting game state…';
      villagerList.textContent = '';
      villagerEmpty.style.display = '';
      villagerEmpty.textContent = 'Provide getState in DebugKit.configure() to see villagers.';
      return;
    }

    let details = [];
    let timeLabel = 'Live';
    try {
      const state = stateProvider();
      if (state && Array.isArray(state.villagerDetails)) {
        details = state.villagerDetails;
      }
      if (state && Number.isFinite(state.timeOfDay)) {
        timeLabel = 't=' + state.timeOfDay.toFixed(2);
      }
    } catch (err) {
      villagerUpdated.textContent = 'Villagers: error';
      villagerList.textContent = '';
      villagerEmpty.style.display = '';
      villagerEmpty.textContent = 'Villager diagnostics unavailable.';
      return;
    }

    villagerUpdated.textContent = details.length ? 'Updated ' + new Date().toLocaleTimeString() + ' (' + timeLabel + ')' : timeLabel;
    villagerList.textContent = '';
    if (!details.length) {
      villagerEmpty.style.display = '';
      villagerEmpty.textContent = 'No villagers reported yet.';
      return;
    }

    villagerEmpty.style.display = 'none';
    for (const entry of details) {
      const row = el('div', { className: 'dbg-villager-row' });
      const titleText = `#${entry?.number ?? '?'} — ${entry?.role || 'villager'} (${entry?.lifeStage || 'adult'})`;
      row.append(el('div', { className: 'dbg-villager-state', text: titleText }));

      const meta = el('div', { className: 'dbg-villager-meta' });
      meta.append(
        el('span', { text: entry?.state ? `Doing: ${entry.state}` : 'Doing: idle' }),
        el('span', { text: entry?.condition ? `Condition: ${entry.condition}` : 'Condition: normal' }),
        el('span', { text: entry?.thought ? `Thought: ${entry.thought}` : 'Thought: --' })
      );
      if (entry?.targetJob) {
        const job = entry.targetJob;
        const coords = (job.x != null && job.y != null) ? ` @ (${Math.round(job.x)},${Math.round(job.y)})` : '';
        meta.append(el('span', { text: `Job: ${job.type || 'task'}${coords}` }));
      }
      if (entry?.carrying) {
        meta.append(el('span', { text: `Carrying: ${entry.carrying.qty ?? 1} ${entry.carrying.type || ''}` }));
      }
      if (entry?.activeBuildingId) {
        meta.append(el('span', { text: `Building: ${entry.activeBuildingId}` }));
      }
      const pos = entry?.position;
      if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
        meta.append(el('span', { text: `Pos: (${Math.round(pos.x)},${Math.round(pos.y)})` }));
      }
      row.append(meta);

      const bars = el('div', { className: 'dbg-villager-bars' });
      bars.append(
        el('span', { text: 'Hunger ' + formatPercent(entry?.hunger) }),
        el('span', { text: 'Energy ' + formatPercent(entry?.energy) }),
        el('span', { text: 'Hydration ' + formatPercent(entry?.hydration) }),
        el('span', { text: 'Mood ' + formatPercent(entry?.happy) })
      );
      row.append(bars);

      villagerList.append(row);
    }
  }

  function renderLogs() {
    renderScheduled = false;
    const term = searchTerm.trim().toLowerCase();
    const fragment = doc.createDocumentFragment();
    const filter = filterMode;
    const filtered = logs.filter(entry => {
      if (filter === 'ERROR') {
        if (!(entry.kind === 'ERROR' || entry.kind === 'UNCAUGHT' || entry.kind === 'PROMISE')) return false;
      } else if (filter === 'WARN') {
        if (entry.kind !== 'WARN') return false;
      } else if (filter === 'NET') {
        if (entry.kind !== 'NET') return false;
      } else if (filter === 'NOTE') {
        if (!(entry.kind === 'NOTE' || entry.kind === 'MARK' || entry.kind === 'STATE' || entry.kind === 'INFO' || entry.kind === 'ENV' || entry.kind === 'FPS' || entry.kind === 'PERF')) return false;
      }
      if (!term) return true;
      const base = (entry.text || '').toLowerCase();
      const matchText = base.includes(term);
      if (matchText) return true;
      if (entry.data != null) {
        try {
          const dataStr = typeof entry.data === 'string' ? entry.data : fmt(entry.data);
          return dataStr.toLowerCase().includes(term);
        } catch (err) {
          return false;
        }
      }
      return false;
    });
    for (const entry of filtered) {
      const row = doc.createElement('div');
      row.className = 'dbg-row ' + classForKind(entry.kind);
      const time = doc.createElement('span');
      time.className = 'dbg-time';
      const timeObj = new Date(entry.tsISO);
      time.textContent = timeObj.toLocaleTimeString();
      const kindSpan = doc.createElement('span');
      kindSpan.className = 'dbg-kind';
      kindSpan.textContent = '[' + entry.kind + ']';
      const textNode = doc.createElement('span');
      textNode.textContent = entry.text;
      row.append(time, kindSpan, textNode);
      if (entry.data !== undefined) {
        const dataEl = doc.createElement('div');
        dataEl.className = 'dbg-data';
        dataEl.textContent = typeof entry.data === 'string' ? entry.data : fmt(entry.data);
        row.appendChild(dataEl);
      }
      fragment.appendChild(row);
    }
    body.textContent = '';
    body.appendChild(fragment);
    if (autoscroll) {
      body.scrollTop = body.scrollHeight;
    }
  }

  function classForKind(kind) {
    if (kind === 'ERROR' || kind === 'UNCAUGHT' || kind === 'PROMISE') return 'dbg-error';
    if (kind === 'WARN') return 'dbg-warn';
    if (kind === 'NET') return 'dbg-net';
    if (kind === 'NOTE' || kind === 'MARK' || kind === 'STATE' || kind === 'INFO' || kind === 'ENV' || kind === 'FPS' || kind === 'PERF') return 'dbg-note';
    return 'dbg-note';
  }

  body.addEventListener('scroll', function () {
    const nearBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 8;
    autoscroll = nearBottom;
  });

  renderVillagerDetails();
  setInterval(renderVillagerDetails, 1000);

  collapseBtn.addEventListener('click', () => {
    setCollapsedState(!trayCollapsed);
  });

  hideBtn.addEventListener('click', () => {
    minimizeTray();
  });

  copyBtn.addEventListener('click', async () => {
    try {
      const snap = snapshot();
      const text = JSON.stringify(snap, null, 2);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        add('NOTE', 'Copied snapshot to clipboard.');
      } else {
        const textarea = el('textarea', { style: { position: 'fixed', opacity: '0', pointerEvents: 'none' } }, text);
        doc.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        doc.execCommand('copy');
        textarea.remove();
        add('NOTE', 'Copied snapshot to clipboard.');
      }
    } catch (err) {
      add('ERROR', 'Copy failed', fmt(err));
    }
  });

  exportBtn.addEventListener('click', () => {
    try {
      const blob = new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: 'debug-' + Date.now() + '.json' });
      doc.body.appendChild(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 1000);
      add('NOTE', 'Exported snapshot file.');
    } catch (err) {
      add('ERROR', 'Export failed', fmt(err));
    }
  });

  shareBtn.addEventListener('click', async () => {
    const snapBlob = new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' });
    const fileName = 'debug-' + Date.now() + '.json';
    let file = null;
    if (typeof File === 'function') {
      try {
        file = new File([snapBlob], fileName, { type: 'application/json' });
      } catch (err) {
        file = null;
      }
    }
    if (file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Debug snapshot' });
        add('NOTE', 'Shared debug snapshot.');
        return;
      } catch (err) {
        add('WARN', 'Share cancelled or failed', fmt(err));
      }
    }
    add('WARN', 'Sharing unavailable; downloading instead.');
    const url = URL.createObjectURL(snapBlob);
    const a = el('a', { href: url, download: fileName });
    doc.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  });

  clearBtn.addEventListener('click', () => {
    logs = [];
    pendingLogs = [];
    scheduleRender();
  });

  pauseBtn.addEventListener('click', () => {
    const wasPaused = paused;
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    if (!paused) {
      flushPending();
      add('NOTE', 'Logging resumed.');
    } else if (!wasPaused && paused) {
      const entry = makeLog('NOTE', 'Logging paused.');
      pushLog(entry);
      scheduleRender();
    }
  });

  shadingSelect.addEventListener('change', () => {
    const mode = normalizeShadeModeValue(shadingSelect.value);
    if (shadingAPIAvailable()) {
      win.setShadingMode(mode);
    }
    syncShadingControls();
  });

  ambientInput.addEventListener('input', () => {
    const value = clampShadeUnit(parseFloat(ambientInput.value));
    ambientValue.textContent = formatShadeValue(value);
    if (shadingAPIAvailable()) {
      win.setShadingParams({ ambient: value });
    }
    syncShadingControls();
  });

  intensityInput.addEventListener('input', () => {
    const value = clampShadeUnit(parseFloat(intensityInput.value));
    intensityValue.textContent = formatShadeValue(value);
    if (shadingAPIAvailable()) {
      win.setShadingParams({ intensity: value });
    }
    syncShadingControls();
  });

  slopeInput.addEventListener('input', () => {
    const value = clampSlopeScale(parseFloat(slopeInput.value));
    slopeValue.textContent = formatSlopeValue(value);
    if (shadingAPIAvailable()) {
      win.setShadingParams({ slopeScale: value });
    }
    syncShadingControls();
  });

  markBtn.addEventListener('click', () => {
    const label = 'Mark @ ' + new Date().toLocaleTimeString();
    add('MARK', label);
  });

  stateBtn.addEventListener('click', () => {
    if (typeof stateProvider === 'function') {
      try {
        const state = stateProvider();
        add('STATE', 'App state', redactObj(state));
      } catch (err) {
        add('ERROR', 'stateProvider error', fmt(err));
      }
    } else {
      add('INFO', 'No stateProvider configured.');
    }
  });

  fpsInput.addEventListener('change', () => {
    if (fpsInput.checked) {
      startFPS();
    } else {
      stopFPS();
    }
  });

  netInput.addEventListener('change', () => {
    netHook = netInput.checked;
    add('NOTE', netHook ? 'Network logging enabled.' : 'Network logging disabled.');
  });

  filterSelect.addEventListener('change', () => {
    filterMode = filterSelect.value;
    scheduleRender();
  });

  searchInput.addEventListener('input', () => {
    searchTerm = searchInput.value || '';
    scheduleRender();
  });

  perfBtn.addEventListener('click', () => {
    logPerformance();
  });

  connBtn.addEventListener('click', () => {
    logConnection('Connection info');
    attachConnectionListener();
  });

  diagBtn.addEventListener('click', () => {
    try {
      const pipe = appGetPipeline ? appGetPipeline() : null;
      if (pipe && Array.isArray(pipe)) {
        add('NOTE', 'Pipeline checkpoints', pipe);
      } else {
        add('WARN', 'No pipeline info from app. Provide getPipeline() in DebugKit.configure().');
      }
      const probe = appGetLightingProbe ? appGetLightingProbe() : null;
      if (probe) {
        const summary = {
          mode: probe.mode,
          useMultiply: probe.useMultiplyComposite,
          scale: probe.lightmapScale,
          ctx: probe.contexts,
          Hq: { present: !!probe.hillshadeQ, min: probe.HqMin, max: probe.HqMax },
          Lq: { present: !!probe.lightmapQ, min: probe.LqMin, max: probe.LqMax },
          canMultiply: probe.canMultiply,
          reasons: probe.reasons || []
        };
        add('STATE', 'Lighting probe', summary);
        if (summary.canMultiply === false && summary.reasons && summary.reasons.length) {
          add('ERROR', 'Lighting not ready', summary.reasons.join('; '));
        }
      } else {
        add('WARN', 'No lighting probe from app. Provide getLightingProbe() in DebugKit.configure().');
      }
    } catch (err) {
      add('ERROR', 'Diag failed', fmt(err));
    }
  });

  safeBtn.addEventListener('click', () => {
    try {
      if (appEnterSafeMode) {
        appEnterSafeMode();
        add('NOTE', 'Safe mode requested by DebugKit.');
      } else {
        add('WARN', 'No onSafeMode() provided in DebugKit.configure().');
      }
    } catch (err) {
      add('ERROR', 'Safe mode failed', fmt(err));
    }
  });

  permsBtn.addEventListener('click', () => {
    checkPermissions();
  });

  geoBtn.addEventListener('click', () => {
    geolocate();
  });

  keysBtn.addEventListener('click', () => {
    logStorageKeys();
  });

  rectBtn.addEventListener('click', () => {
    const selector = selectorInput.value.trim();
    if (!selector) {
      add('WARN', 'Provide a CSS selector first.');
      return;
    }
    try {
      const elTarget = doc.querySelector(selector);
      if (!elTarget) {
        add('WARN', 'No element matches selector.');
        return;
      }
      const rect = elTarget.getBoundingClientRect();
      const styles = win.getComputedStyle(elTarget);
      add('NOTE', 'Element rect', {
        selector,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        styles: {
          display: styles.display,
          position: styles.position,
          transform: styles.transform
        }
      });
    } catch (err) {
      add('ERROR', 'Selector failed', fmt(err));
    }
  });

  shotBtn.addEventListener('click', () => {
    takeScreenshot();
  });

  pill.addEventListener('click', () => {
    tray.style.display = 'flex';
    pill.style.display = 'none';
  });

  head.addEventListener('dblclick', (ev) => {
    if (ev.target && ev.target.closest('button, input, select, textarea, label, a')) return;
    setCollapsedState(!trayCollapsed);
  });

  let longPressTimer = null;
  head.addEventListener('pointerdown', (ev) => {
    if (ev.target && ev.target.closest('button, input, select, textarea, label, a')) return;
    if (typeof ev.button === 'number' && ev.button !== 0) return;
    try {
      head.setPointerCapture(ev.pointerId);
    } catch (err) {
      /* ignore */
    }
    dragging = true;
    dragPointerId = ev.pointerId;
    const rect = tray.getBoundingClientRect();
    startX = ev.clientX;
    startY = ev.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    tray.style.top = rect.top + 'px';
    tray.style.left = rect.left + 'px';
    tray.style.bottom = 'auto';
    longPressTimer = setTimeout(() => {
      minimizeTray();
    }, 450);
  });

  head.addEventListener('pointermove', (ev) => {
    if (!dragging || ev.pointerId !== dragPointerId) return;
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    const left = clamp(startLeft + dx, 4, win.innerWidth - tray.offsetWidth - 4);
    const top = clamp(startTop + dy, 4, win.innerHeight - tray.offsetHeight - 4);
    tray.style.left = left + 'px';
    tray.style.top = top + 'px';
  });

  head.addEventListener('pointerup', (ev) => {
    if (ev.pointerId === dragPointerId) {
      dragging = false;
      dragPointerId = null;
      try {
        head.releasePointerCapture(ev.pointerId);
      } catch (err) {
        /* ignore */
      }
    }
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });

  head.addEventListener('pointercancel', (ev) => {
    if (ev.pointerId === dragPointerId) {
      dragging = false;
      if (dragPointerId != null) {
        try {
          head.releasePointerCapture(dragPointerId);
        } catch (err) {
          /* ignore */
        }
      }
      dragPointerId = null;
    }
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  });

  function minimizeTray() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    tray.style.display = 'none';
    pill.style.display = 'flex';
    if (dragPointerId != null) {
      try {
        head.releasePointerCapture(dragPointerId);
      } catch (err) {
        /* ignore */
      }
    }
    dragging = false;
    dragPointerId = null;
  }

  function startFPS() {
    if (fpsActive) return;
    fpsActive = true;
    fpsFrameCount = 0;
    fpsLastTime = performance.now();
    const loop = (now) => {
      if (!fpsActive) return;
      fpsFrameCount++;
      if (now - fpsLastTime >= 1000) {
        const fps = Math.round((fpsFrameCount * 1000) / (now - fpsLastTime));
        add('FPS', 'FPS: ' + fps);
        fpsFrameCount = 0;
        fpsLastTime = now;
      }
      fpsHandle = requestAnimationFrame(loop);
    };
    fpsHandle = requestAnimationFrame(loop);
  }

  function stopFPS() {
    fpsActive = false;
    if (fpsHandle) {
      cancelAnimationFrame(fpsHandle);
      fpsHandle = null;
    }
    fpsFrameCount = 0;
  }

  function snapshot() {
    const sourceLogs = logs.concat(paused ? pendingLogs : []);
    return {
      when: new Date().toString(),
      location: location.href,
      logs: sourceLogs.map(entry => ({
        tsISO: entry.tsISO,
        kind: entry.kind,
        text: entry.text,
        data: entry.data === undefined ? undefined : entry.data
      }))
    };
  }
  function ensureDataSafe(value) {
    if (value == null) return value;
    if (typeof value === 'object') {
      return redactObj(value);
    }
    return value;
  }

  function logEnvSnapshot(context) {
    const info = {
      context: context || 'init',
      time: new Date().toString(),
      location: location.href,
      viewport: {
        width: win.innerWidth,
        height: win.innerHeight,
        dpr: win.devicePixelRatio
      },
      screen: win.screen ? { width: win.screen.width, height: win.screen.height } : null,
      userAgent: navigator.userAgent,
      language: navigator.language,
      languages: navigator.languages,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      online: navigator.onLine,
      deviceMemory: navigator.deviceMemory != null ? navigator.deviceMemory : 'n/a',
      hardwareConcurrency: navigator.hardwareConcurrency != null ? navigator.hardwareConcurrency : 'n/a',
      serviceWorker: navigator.serviceWorker ? Boolean(navigator.serviceWorker.controller) : false,
      orientation: getOrientation()
    };
    add('ENV', 'Environment snapshot', info);
  }

  function getOrientation() {
    const scr = win.screen;
    if (scr && scr.orientation && typeof scr.orientation.type === 'string') {
      return scr.orientation.type + ' ' + scr.orientation.angle;
    }
    if (typeof win.orientation === 'number') {
      return String(win.orientation);
    }
    return 'unknown';
  }

  function updateViewportLabel() {
    viewportLabel.textContent = win.innerWidth + '×' + win.innerHeight + ' @' + (win.devicePixelRatio || 1).toFixed(2) + 'x';
  }

  function logPerformance() {
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      const paints = performance.getEntriesByType('paint').map(p => ({ name: p.name, value: Math.round(p.startTime) }));
      const resources = performance.getEntriesByType('resource');
      const slowResources = resources
        .slice()
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 5)
        .map(r => ({
          name: r.name.length > 80 ? r.name.slice(0, 77) + '…' : r.name,
          initiatorType: r.initiatorType,
          durMs: Math.round(r.duration),
          transferSize: r.transferSize
        }));
      const summary = {
        navigation: nav ? {
          type: nav.type,
          ttfb: Math.round(nav.responseStart),
          domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
          load: Math.round(nav.loadEventEnd)
        } : null,
        paints,
        resources: {
          count: resources.length,
          slowest: slowResources
        }
      };
      if (performance.memory) {
        summary.heapMB = {
          used: Math.round(performance.memory.usedJSHeapSize / 1048576),
          limit: Math.round(performance.memory.jsHeapSizeLimit / 1048576)
        };
      }
      add('PERF', 'Performance entries', summary);
    } catch (err) {
      add('ERROR', 'Performance inspection failed', fmt(err));
    }
  }

  function logConnection(reason) {
    try {
      const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (!conn) {
        add('WARN', 'Network Information API not supported.');
        return;
      }
      add('NOTE', reason || 'Connection info', {
        type: conn.type,
        effectiveType: conn.effectiveType,
        downlink: conn.downlink,
        rtt: conn.rtt,
        saveData: conn.saveData
      });
    } catch (err) {
      add('ERROR', 'Connection info failed', fmt(err));
    }
  }

  function attachConnectionListener() {
    if (connectionListenerAttached) return;
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!conn || !conn.addEventListener) return;
    const handler = () => {
      logConnection('Connection change');
    };
    conn.addEventListener('change', handler);
    connectionListenerAttached = true;
  }

  function checkPermissions() {
    if (!navigator.permissions || !navigator.permissions.query) {
      add('WARN', 'Permissions API not supported.');
      return;
    }
    const names = ['geolocation', 'clipboard-read', 'clipboard-write', 'notifications', 'camera', 'microphone', 'persistent-storage'];
    names.forEach(name => {
      navigator.permissions.query({ name }).then(result => {
        add('NOTE', 'Permission ' + name, { state: result.state });
      }).catch(err => {
        add('WARN', 'Permission ' + name + ' unavailable', fmt(err));
      });
    });
  }

  function geolocate() {
    if (!navigator.geolocation || !navigator.geolocation.getCurrentPosition) {
      add('WARN', 'Geolocation not supported.');
      return;
    }
    navigator.geolocation.getCurrentPosition((pos) => {
      add('NOTE', 'Geolocation', {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        acc: pos.coords.accuracy + 'm'
      });
    }, (err) => {
      add('WARN', 'Geolocation error', fmt(err));
    }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 });
  }

  function logStorageKeys() {
    try {
      const local = storagePairs(localStorage);
      const session = storagePairs(sessionStorage);
      add('NOTE', 'Storage keys', { local, session });
    } catch (err) {
      add('ERROR', 'Storage inspection failed', fmt(err));
    }
  }

  function ensureHtml2Canvas() {
    if (html2cReady) return Promise.resolve(true);
    if (html2cLoading) {
      return new Promise((resolve) => {
        const poll = () => {
          if (html2cReady) {
            resolve(true);
          } else {
            setTimeout(poll, 200);
          }
        };
        poll();
      });
    }
    html2cLoading = true;
    return new Promise((resolve) => {
      const script = el('script', { src: 'https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js' });
      script.onload = () => {
        html2cReady = typeof win.html2canvas === 'function';
        html2cLoading = false;
        if (!html2cReady) {
          add('WARN', 'html2canvas failed to initialize.');
          resolve(false);
        } else {
          resolve(true);
        }
      };
      script.onerror = () => {
        html2cLoading = false;
        add('WARN', 'Unable to load html2canvas.');
        resolve(false);
      };
      doc.head.appendChild(script);
    });
  }

  async function takeScreenshot() {
    const ready = await ensureHtml2Canvas();
    if (!ready) return;
    if (typeof win.html2canvas !== 'function') {
      add('WARN', 'html2canvas unavailable.');
      return;
    }
    try {
      const canvas = await win.html2canvas(doc.body, {
        scale: win.devicePixelRatio || 1
      });
      await new Promise((resolve, reject) => {
        canvas.toBlob(async (blob) => {
          if (!blob) {
            reject(new Error('Screenshot failed'));
            return;
          }
          const fileName = 'screenshot-' + Date.now() + '.png';
          let file = null;
          if (typeof File === 'function') {
            try {
              file = new File([blob], fileName, { type: 'image/png' });
            } catch (err) {
              file = null;
            }
          }
          if (file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
              await navigator.share({ files: [file], title: 'Debug screenshot' });
              add('NOTE', 'Shared screenshot.');
              resolve();
            } catch (err) {
              add('WARN', 'Share cancelled or failed', fmt(err));
              resolve();
            }
          } else {
            const url = URL.createObjectURL(blob);
            const a = el('a', { href: url, download: fileName });
            doc.body.appendChild(a);
            a.click();
            setTimeout(() => {
              URL.revokeObjectURL(url);
              a.remove();
            }, 1000);
            add('NOTE', 'Screenshot downloaded.');
            resolve();
          }
        }, 'image/png');
      });
    } catch (err) {
      add('ERROR', 'Screenshot failed', fmt(err));
    }
  }

  function installConsoleHooks() {
    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error
    };
    console.log = function (...args) {
      original.log.apply(console, args);
      add('INFO', args.map(arg => fmt(arg)).join(' '));
    };
    console.info = function (...args) {
      original.info.apply(console, args);
      add('INFO', args.map(arg => fmt(arg)).join(' '));
    };
    console.warn = function (...args) {
      original.warn.apply(console, args);
      add('WARN', args.map(arg => fmt(arg)).join(' '));
    };
    console.error = function (...args) {
      original.error.apply(console, args);
      add('ERROR', args.map(arg => fmt(arg)).join(' '));
    };
  }

  function installErrorHooks() {
    win.addEventListener('error', (event) => {
      if (!event) return;
      const message = event.message + ' @ ' + event.filename + ':' + event.lineno + ':' + event.colno;
      add('UNCAUGHT', message);
    });
    win.addEventListener('unhandledrejection', (event) => {
      let reason = event.reason;
      if (reason instanceof Error) {
        reason = reason.stack || reason.message;
      }
      add('PROMISE', 'Unhandled rejection', ensureDataSafe(reason));
    });
  }

  function installFetchHook() {
    if (!win.fetch) return;
    const originalFetch = win.fetch;
    win.fetch = function (input, init) {
      const method = (init && init.method) || (input && input.method) || 'GET';
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const redactedUrl = redactURL(url);
      const start = performance.now();
      return originalFetch.apply(this, arguments).then(response => {
        if (netHook) {
          logFetchResponse(method, redactedUrl, response, performance.now() - start);
        }
        return response;
      }).catch(err => {
        if (netHook) {
          add('NET', method + ' ' + redactedUrl + ' failed', fmt(err));
        }
        throw err;
      });
    };
  }

  function logFetchResponse(method, url, response, duration) {
    const info = {
      method,
      url,
      status: response.status,
      ok: response.ok,
      duration: Math.round(duration)
    };
    if (response.headers) {
      const headers = {};
      response.headers.forEach((value, key) => {
        headers[key] = REDACT_HEADERS.includes(key.toLowerCase()) ? '***' : value;
      });
      info.headers = headers;
    }
    const contentType = response.headers ? (response.headers.get('content-type') || '') : '';
    const isJSON = /application\/json|\+json/i.test(contentType);
    if (response.clone) {
      response.clone().text().then(text => {
        if (!netHook) return;
        if (isJSON) {
          try {
            const parsed = JSON.parse(text);
            info.body = JSON.stringify(redactObj(parsed)).slice(0, BODY_PREVIEW);
          } catch (err) {
            info.body = text.slice(0, BODY_PREVIEW);
          }
        } else {
          info.body = text.slice(0, BODY_PREVIEW);
        }
        add('NET', method + ' ' + url + ' → ' + response.status, info);
      }).catch(() => {
        add('NET', method + ' ' + url + ' → ' + response.status, info);
      });
    } else {
      add('NET', method + ' ' + url + ' → ' + response.status, info);
    }
  }

  function installXHRHook() {
    const OriginalXHR = win.XMLHttpRequest;
    if (!OriginalXHR) return;
    function WrappedXHR() {
      const xhr = new OriginalXHR();
      let method = 'GET';
      let url = '';
      let startTime = 0;
      xhr.addEventListener('loadstart', () => {
        startTime = performance.now();
      });
      xhr.addEventListener('loadend', () => {
        if (!netHook) return;
        const duration = performance.now() - startTime;
        let bodyPreview = '';
        let hadError = false;
        let rawText = '';
        try {
          rawText = typeof xhr.responseText === 'string' ? xhr.responseText : '';
        } catch (err) {
          hadError = true;
        }
        if (hadError) {
          bodyPreview = '[unavailable]';
        } else {
          let contentType = '';
          try {
            contentType = xhr.getResponseHeader ? (xhr.getResponseHeader('content-type') || '') : '';
          } catch (err) {
            contentType = '';
          }
          if (rawText && /application\/json|\+json/i.test(contentType)) {
            try {
              bodyPreview = JSON.stringify(redactObj(JSON.parse(rawText))).slice(0, BODY_PREVIEW);
            } catch (err) {
              bodyPreview = rawText.slice(0, BODY_PREVIEW);
            }
          } else {
            bodyPreview = rawText ? rawText.slice(0, BODY_PREVIEW) : '';
          }
        }
        add('NET', method + ' ' + url + ' → ' + xhr.status, {
          method,
          url,
          status: xhr.status,
          duration: Math.round(duration),
          body: bodyPreview
        });
      });
      const originalOpen = xhr.open;
      xhr.open = function (m, requestUrl) {
        method = m ? m.toUpperCase() : 'GET';
        url = redactURL(requestUrl);
        return originalOpen.apply(xhr, arguments);
      };
      return xhr;
    }
    WrappedXHR.prototype = OriginalXHR.prototype;
    try {
      Object.getOwnPropertyNames(OriginalXHR).forEach(name => {
        if (name === 'prototype' || name === 'name' || name === 'length') return;
        const descriptor = Object.getOwnPropertyDescriptor(OriginalXHR, name);
        if (descriptor) {
          Object.defineProperty(WrappedXHR, name, descriptor);
        }
      });
      if (Object.getOwnPropertySymbols) {
        Object.getOwnPropertySymbols(OriginalXHR).forEach(symbol => {
          const descriptor = Object.getOwnPropertyDescriptor(OriginalXHR, symbol);
          if (descriptor) {
            Object.defineProperty(WrappedXHR, symbol, descriptor);
          }
        });
      }
    } catch (err) {}
    win.XMLHttpRequest = WrappedXHR;
  }

  function refreshEnv() {
    updateViewportLabel();
    logEnvSnapshot('refresh');
  }

  function getBatteryInfo() {
    if (!navigator.getBattery) return;
    navigator.getBattery().then(battery => {
      add('NOTE', 'Battery', {
        level: Math.round(battery.level * 100) + '%',
        charging: battery.charging
      });
    }).catch(() => {});
  }

  function logStorageEstimate() {
    if (!navigator.storage || !navigator.storage.estimate) return;
    navigator.storage.estimate().then(info => {
      if (!info) return;
      const usage = info.usage || 0;
      const quota = info.quota || 0;
      add('NOTE', 'Storage estimate', {
        usageMB: Math.round(usage / 1048576),
        quotaMB: Math.round(quota / 1048576)
      });
    }).catch(() => {});
  }

  function setupVisibilityListeners() {
    doc.addEventListener('visibilitychange', () => {
      add('NOTE', 'visibility: ' + doc.visibilityState);
    });
    win.addEventListener('online', () => add('NOTE', 'Went online.'));
    win.addEventListener('offline', () => add('NOTE', 'Went offline.'));
    win.addEventListener('orientationchange', () => {
      add('NOTE', 'orientation: ' + getOrientation());
      updateHeadMetrics();
    });
    win.addEventListener('resize', () => {
      updateViewportLabel();
      updateHeadMetrics();
    });
  }

  function installNetworkHooks() {
    installFetchHook();
    installXHRHook();
  }

  installConsoleHooks();
  installErrorHooks();
  installNetworkHooks();
  setupVisibilityListeners();
  updateViewportLabel();
  logEnvSnapshot('init');
  getBatteryInfo();
  logStorageEstimate();

  if (navigator.onLine === false) {
    add('NOTE', 'Initial state: offline');
  }

  if (navigator.storage && typeof navigator.storage.persisted === 'function') {
    navigator.storage.persisted().then(persisted => {
      if (persisted) {
        add('NOTE', 'Storage persisted.');
      }
    }).catch(() => {});
  }

  const state = {
    note(text) {
      add('NOTE', text);
    },
    event(name, data) {
      add('NOTE', name, data);
    },
    state(obj) {
      add('STATE', 'State update', obj);
    },
    mark(name) {
      try {
        performance.mark(name);
      } catch (err) {
        add('WARN', 'performance.mark failed', fmt(err));
      }
      add('MARK', 'performance.mark("' + name + '")');
    },
    configure(opts = {}) {
      if (typeof opts.getState === 'function') {
        stateProvider = opts.getState;
      }
      if (Array.isArray(opts.redactHeaders)) {
        for (const h of opts.redactHeaders) {
          if (typeof h === 'string') {
            const lower = h.toLowerCase();
            if (!REDACT_HEADERS.includes(lower)) {
              REDACT_HEADERS.push(lower);
            }
          }
        }
      }
      if (Array.isArray(opts.redactQuery)) {
        for (const q of opts.redactQuery) {
          if (typeof q === 'string') {
            const lower = q.toLowerCase();
            if (!REDACT_QUERY.includes(lower)) {
              REDACT_QUERY.push(lower);
            }
          }
        }
      }
    },
    checkpoint(name, ok, extra) {
      add(ok ? 'NOTE' : 'ERROR', 'CHK ' + name, extra === undefined ? undefined : ensureDataSafe(extra));
    },
    refreshEnv
  };

  const origConfigure = state.configure;
  state.configure = function (opts = {}) {
    origConfigure(opts);
    if (typeof opts.getLightingProbe === 'function') appGetLightingProbe = opts.getLightingProbe;
    if (typeof opts.getPipeline === 'function') appGetPipeline = opts.getPipeline;
    if (typeof opts.onSafeMode === 'function') appEnterSafeMode = opts.onSafeMode;
    return state;
  };

  state.fatal = function (message, data) {
    try {
      if (!doc || !doc.body) {
        add('ERROR', 'fatal() failed', 'Document body unavailable');
        return;
      }
      const shield = doc.createElement('div');
      Object.assign(shield.style, {
        position: 'fixed', inset: 0, background: 'rgba(10,12,18,0.92)',
        color: '#fff', zIndex: 2147483647, display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: '24px'
      });
      const box = doc.createElement('div');
      box.style.maxWidth = '720px';
      box.style.font = "500 16px/1.45 system-ui, -apple-system, Segoe UI, sans-serif";
      box.innerHTML = '<div style="font-size:20px;font-weight:700;margin-bottom:8px">Render unavailable</div>'
        + '<div style="opacity:.9;margin-bottom:12px">' + (message || 'Unknown rendering error') + '</div>'
        + '<pre style="max-height:40vh;overflow:auto;background:#0f1522;padding:12px;border-radius:8px;white-space:pre-wrap;word-break:break-word;"></pre>'
        + '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">'
        +   '<button id="dbgSafe" style="padding:8px 12px;border-radius:8px;background:#19253c;color:#e8eefc;border:1px solid #2a3550">Safe Mode</button>'
        +   '<button id="dbgReload" style="padding:8px 12px;border-radius:8px;background:#19253c;color:#e8eefc;border:1px solid #2a3550">Reload</button>'
        + '</div>';
      shield.appendChild(box);
      doc.body.appendChild(shield);
      const pre = box.querySelector('pre');
      if (pre) {
        pre.textContent = data ? (typeof data === 'string' ? data : safeStringify(ensureDataSafe(data))) : '(no details)';
      }
      const safeOverlayBtn = box.querySelector('#dbgSafe');
      if (safeOverlayBtn) {
        safeOverlayBtn.onclick = () => {
          try { if (appEnterSafeMode) appEnterSafeMode(); } catch (_) {}
          if (shield.parentNode) {
            shield.parentNode.removeChild(shield);
          }
        };
      }
      const reloadBtn = box.querySelector('#dbgReload');
      if (reloadBtn) {
        reloadBtn.onclick = () => {
          const u = new URL(location.href);
          u.searchParams.set('buster', Date.now());
          location.href = u.toString();
        };
      }
      add('ERROR', 'Fatal overlay shown', { message, details: data });
    } catch (err) {
      add('ERROR', 'fatal() failed', fmt(err));
    }
  };

  state.arrMinMax = arrMinMax;

  win.DebugKit = state;

  add('NOTE', 'DebugKit v4 — Mobile Max active.');
})();
