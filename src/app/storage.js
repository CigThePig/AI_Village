const AIV_SCOPE = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this);

// ---- Safe storage wrapper ----
const Storage = (() => {
  const host = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null);
  let store = null;
  try {
    if (host && host.localStorage) {
      store = host.localStorage;
    }
  } catch (e) {
    store = null;
  }

  let available = false;
  if (store) {
    try {
      const k = '__aiv_test__' + Math.random();
      store.setItem(k, '1');
      store.removeItem(k);
      available = true;
    } catch (e) {
      available = false;
    }
  }

  function get(key, def = null) {
    if (!available || !store) return def;
    try {
      const v = store.getItem(key);
      return v === null ? def : v;
    } catch (e) {
      return def;
    }
  }

  function set(key, value) {
    if (!available || !store) return false;
    try {
      store.setItem(key, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  function del(key) {
    if (!available || !store) return false;
    try {
      store.removeItem(key);
      return true;
    } catch (e) {
      return false;
    }
  }

  return {
    get available() { return available; },
    set available(v) { available = !!v; },
    get,
    set,
    del
  };
})();

let updateCallback = null;

function setUpdateCallback(fn) {
  updateCallback = typeof fn === 'function' ? fn : null;
}

function describeError(value) {
  if (value == null) {
    return 'Fatal error';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.stack || value.message || String(value);
  }
  if (typeof value === 'object') {
    const stack = value.stack || value.message;
    if (stack) {
      return stack;
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch (jsonErr) {
      return String(value);
    }
  }
  return String(value);
}

function showFatalOverlay(err) {
  if (typeof document === 'undefined') {
    console.error('Startup error', describeError(err));
    return;
  }
  const message = describeError(err);
  let div = document.getElementById('fatal-overlay');
  if (!div) {
    div = document.createElement('div');
    div.id = 'fatal-overlay';
    div.style.cssText = `
      position:fixed;left:12px;right:12px;top:12px;z-index:9999;
      background:rgba(20,24,33,0.96);color:#e9f1ff;border:1px solid rgba(255,255,255,0.15);
      border-radius:12px;padding:12px;font:14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      box-shadow:0 10px 30px rgba(0,0,0,.6)
    `;
    document.body.appendChild(div);
  }
  if (typeof div.replaceChildren === 'function') {
    div.replaceChildren();
  } else {
    while (div.firstChild) {
      div.removeChild(div.firstChild);
    }
  }

  const title = document.createElement('b');
  title.textContent = 'Startup error';
  div.appendChild(title);
  div.appendChild(document.createElement('br'));

  const pre = document.createElement('pre');
  pre.style.whiteSpace = 'pre-wrap';
  pre.textContent = message;
  div.appendChild(pre);

  const button = document.createElement('button');
  button.id = 'btnContinueNoSave';
  button.style.marginTop = '8px';
  button.textContent = 'Continue (no save)';
  div.appendChild(button);

  const btn = button;
  btn.onclick = () => {
    if (typeof Storage !== 'undefined') {
      Storage.available = false;
      const bs=document.getElementById('btnSave');
      if(bs){ bs.disabled=true; bs.title='Saving unavailable in this context'; }
    }
    div.remove();
    if (typeof requestAnimationFrame !== 'undefined' && updateCallback) {
      try { requestAnimationFrame(updateCallback); } catch (e) {}
    }
  };
}

function reportFatal(err, extra) {
  console.error('Fatal error', err, extra);
  try {
    if (err == null) {
      throw new Error('Fatal error');
    }
    if (typeof err === 'string' || err instanceof Error) {
      throw err;
    }
    if (typeof err === 'object') {
      throw new Error(describeError(err));
    }
    throw new Error(String(err));
  } catch (e) {
    let fallback = describeError(err);
    if (typeof e?.message === 'string') {
      fallback = `${fallback}\n${e.message}`;
    }
    if (fallback == null || fallback === '') {
      fallback = 'Fatal error';
    }
    showFatalOverlay(fallback);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    const detail = e && (e.error || e.message || e);
    reportFatal(detail, e);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const detail = e && (e.reason || e);
    reportFatal(detail, e);
  });
}

if (AIV_SCOPE && typeof AIV_SCOPE === 'object') {
  AIV_SCOPE.AIV_STORAGE = Storage;
}

export {
  Storage,
  describeError,
  showFatalOverlay,
  reportFatal,
  setUpdateCallback
};
