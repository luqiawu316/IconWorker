/* ==========================================================================
   proxy-check.js —— 代理环境检测胶囊（右下角，页面所有布局共用）

   双重检测，任一命中即判定为「代理环境」（绿点）；两项都未命中为「直连」（红点）：
     1. Google 访问检测：no-cors 请求 google.com/generate_204，能拿到响应即视为可达。
        注意：在网络受限地区，Google 可达通常意味着有代理；在本身可直连 Google 的地区，
        这一项会恒为「可达」，属于固有的误报来源。
     2. 系统代理检测：请求同源 /api/net-check（Cloudflare Function），
        出口时区与本机时区不一致 → 出口位于别处，判为经过代理。
        本地双击打开或平台不支持 Functions 时此项「无法判断」，不参与结论。

   暴露：window.ProxyCheck.run()   重新检测
   ========================================================================== */
(function (global, document) {
  'use strict';

  var GOOGLE_URL = 'https://www.google.com/generate_204';
  var NET_CHECK_PATH = '/api/net-check';
  var TIMEOUT_MS = 5000;

  var el = {
    capsule: document.getElementById('proxyCapsule'),
    dot:     document.getElementById('proxyDot'),
    label:   document.getElementById('proxyLabel')
  };

  /** 带超时的 fetch；超时或失败统一 reject */
  function fetchWithTimeout(url, init) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (controller) controller.abort();
    }, TIMEOUT_MS);
    var opts = Object.assign({ cache: 'no-store' }, init || {});
    if (controller) opts.signal = controller.signal;
    return fetch(url, opts).finally(function () { clearTimeout(timer); });
  }

  /** Google 访问检测：no-cors 下拿到任何响应（含 opaque）即代表网络可达 */
  function checkGoogle() {
    return fetchWithTimeout(GOOGLE_URL, { mode: 'no-cors' }).then(
      function () { return { reachable: true }; },
      function () { return { reachable: false }; }
    );
  }

  /** 系统代理检测：比对 Cloudflare 看到的出口时区与本机时区 */
  function checkSystemProxy() {
    var localTz = '';
    try {
      localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (e) {
      localTz = '';
    }

    return fetchWithTimeout(NET_CHECK_PATH).then(function (res) {
      if (!res.ok) throw new Error('net-check ' + res.status);
      return res.json();
    }).then(function (info) {
      if (!info || !info.timezone || !localTz) {
        return { known: false };
      }
      return {
        known: true,
        proxied: info.timezone !== localTz,
        exitTimezone: info.timezone,
        localTimezone: localTz,
        country: info.country || ''
      };
    }, function () {
      // 本地预览或不支持 Functions 的平台：无法判断
      return { known: false };
    });
  }

  function setState(state, text) {
    el.capsule.setAttribute('data-state', state);
    el.label.textContent = text;
    el.capsule.setAttribute('aria-label', '代理环境检测：' + text);
  }

  function describe(google, system) {
    var lines = [];
    lines.push('Google 访问：' + (google.reachable ? '可达' : '不可达'));
    if (system.known) {
      lines.push('系统代理：' + (system.proxied
        ? '出口时区 ' + system.exitTimezone + '，与本机 ' + system.localTimezone + ' 不一致'
        : '出口与本机一致'));
    } else {
      lines.push('系统代理：无法判断（需部署到 Cloudflare Pages）');
    }
    return lines.join('\n');
  }

  var running = false;

  function run() {
    if (running) return Promise.resolve();
    running = true;
    el.capsule.setAttribute('aria-busy', 'true');
    setState('checking', '检测中…');

    return Promise.all([checkGoogle(), checkSystemProxy()]).then(function (results) {
      var google = results[0];
      var system = results[1];
      var proxied = google.reachable || (system.known && system.proxied);

      setState(proxied ? 'proxy' : 'direct', proxied ? '代理环境' : '直连环境');
      el.capsule.title = describe(google, system) + '\n\n点击重新检测';
    }).catch(function () {
      setState('unknown', '检测失败');
    }).then(function () {
      running = false;
      el.capsule.removeAttribute('aria-busy');
    });
  }

  el.capsule.addEventListener('click', run);

  run();

  global.ProxyCheck = { run: run };

})(window, document);
