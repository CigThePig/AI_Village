// Loaded as a classic deferred <script> from index.html. Must not use
// module-relative URLs (no `import`, no `fetch('./foo')`, no
// `<img src='./foo'>`) — Vite does not rewrite paths in this file for the
// `base=/AI_Village/` production deployment.
console.log('AIV: HTML parsed v3.1');

// Set up the worldgen-ready promise BEFORE any deferred worldgen script
// evaluates. `<script defer>` preserves document order, and bootstrap.js is
// listed first in index.html, so this runs first.
(function () {
  if (typeof window === 'undefined' || window.AIV_WORLDGEN_READY) return;
  let resolveFn;
  let rejectFn;
  window.AIV_WORLDGEN_READY = new Promise(function (resolve, reject) {
    resolveFn = resolve;
    rejectFn = reject;
  });
  function settle() {
    resolveFn = null;
    rejectFn = null;
    window.__AIV_WORLDGEN_RESOLVE__ = null;
    window.__AIV_WORLDGEN_REJECT__ = null;
  }
  window.__AIV_WORLDGEN_RESOLVE__ = function () {
    if (!resolveFn) return;
    const fn = resolveFn;
    settle();
    fn();
  };
  window.__AIV_WORLDGEN_REJECT__ = function (err) {
    if (!rejectFn) return;
    const fn = rejectFn;
    settle();
    fn(err);
  };
  // Fallback timeout: if terrain.js never resolves the promise (e.g. one of
  // the deferred scripts threw at parse time), reject after 5 s so callers
  // surface a clear error instead of hanging.
  setTimeout(function () {
    if (typeof window.__AIV_WORLDGEN_REJECT__ === 'function') {
      try { window.__AIV_WORLDGEN_REJECT__(new Error('AI Village terrain dependencies failed to load before timeout.')); }
      catch (err) { /* noop */ }
    }
  }, 5000);
})();

(function () {
  'use strict';
  const params = new URLSearchParams(window.location.search || '');
  let storageFlag = false;
  try {
    storageFlag = window.localStorage && window.localStorage.getItem('debug') === 'true';
  } catch (err) {
    storageFlag = false;
  }
  if (!(params.get('debug') === '1' || storageFlag)) {
    return;
  }
  const sources = [
    { url: 'debugkit.js', label: 'debugkit.js' }
  ];
  const head = document.head || document.getElementsByTagName('head')[0] || document.body;

  function fetchText(url) {
    if (window.fetch) {
      return fetch(url, { cache: 'no-store' }).then(function (resp) {
        if (!resp.ok) {
          throw new Error('HTTP ' + resp.status);
        }
        return resp.text();
      });
    }
    return new Promise(function (resolve, reject) {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.overrideMimeType && xhr.overrideMimeType('text/plain');
        xhr.onreadystatechange = function () {
          if (xhr.readyState === 4) {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve(xhr.responseText);
            } else {
              reject(new Error('HTTP ' + xhr.status));
            }
          }
        };
        xhr.onerror = function () {
          reject(new Error('Network error'));
        };
        xhr.send();
      } catch (xhrErr) {
        reject(xhrErr);
      }
    });
  }

  function loadFrom(index) {
    if (index >= sources.length) {
      return Promise.reject(new Error('All sources failed'));
    }
    const source = sources[index];
    return fetchText(source.url)
      .then(function (code) {
        const script = document.createElement('script');
        script.type = 'text/javascript';
        script.textContent = code + '\n//# sourceURL=' + source.label;
        head.appendChild(script);
        if (typeof window.__AIV_DEBUGKIT_READY__ === 'function') {
          try {
            window.__AIV_DEBUGKIT_READY__(window.DebugKit);
          } finally {
            delete window.__AIV_DEBUGKIT_READY__;
          }
        }
      })
      .catch(function (err) {
        console.warn('DebugKit load failed from', source.url, err);
        return loadFrom(index + 1);
      });
  }

  loadFrom(0).catch(function (err) {
    console.warn('DebugKit overlay unavailable:', err);
  });
})();

// Wait a bit longer than the dependency bootstrap timeout so we don't
// surface a false negative on slower devices or when the terrain bundle
// takes a moment to attach globals. Skip if main.js already recorded a
// boot failure — that path shows its own fatal overlay via reportFatal.
setTimeout(function () {
  if (window.__AIV_BOOT__ || window.__AIV_BOOT_FAILED__) return;
  const versionEl = document.getElementById('version');
  if (versionEl) {
    versionEl.textContent += ' — JS NOT RUNNING (CSP or cache)';
  }
  console.error('AIV: JS did not run — likely CSP or stale cache');
}, 6000);
