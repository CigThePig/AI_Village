console.log('AIV: HTML parsed v3.1');

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
    { url: 'debugkit.js', label: 'debugkit.js' },
    { url: 'https://cdn.jsdelivr.net/gh/CigThePig/AI_Village@main/debugkit.js', label: 'debugkit.js?cdn' }
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

setTimeout(function () {
  if (!window.__AIV_BOOT__) {
    const versionEl = document.getElementById('version');
    if (versionEl) {
      versionEl.textContent += ' — JS NOT RUNNING (CSP or cache)';
    }
    console.error('AIV: JS did not run — likely CSP or stale cache');
  }
}, 1000);
