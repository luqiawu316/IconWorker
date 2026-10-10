/* ==========================================================================
   favicon-finder.js —— 编排层（对应文档 §3、§4、§5）
   暴露：window.IconFinder

   分波次候选：
     波次 1  页面声明 + Manifest + 常见路径 + browserconfig.xml
     波次 2  页面图片兜底（仅当波次 1 全部落空）
     波次 3  存档快照 / 第三方服务（需显式开启，仅当波次 2 仍落空）

   流程：
     收集候选 → <img> 探测能否显示 → 对成功项做 CORS 验真 → 评分排序 → 输出
   ========================================================================== */
(function (global) {
  'use strict';

  var Probe = global.IconProbe;
  var Parse = global.IconParse;

  /* ---------- 常见路径（文档 §3.3） ---------- */
  var DEFAULT_PATHS = [
    { path: '/favicon.ico',                      label: '根目录 /favicon.ico',                 priority: 92 },
    { path: '/favicon.svg',                      label: '矢量图标 /favicon.svg',               priority: 90 },
    { path: '/apple-touch-icon.png',             label: 'Apple Touch Icon',                    priority: 88 },
    { path: '/apple-touch-icon-precomposed.png', label: 'Apple Touch Icon (precomposed)',      priority: 86 },
    { path: '/favicon.png',                      label: '根目录 /favicon.png',                 priority: 84 },
    { path: '/favicon-32x32.png',                label: 'favicon 32×32',                       priority: 82 },
    { path: '/favicon-16x16.png',                label: 'favicon 16×16',                       priority: 80 },
    { path: '/apple-touch-icon-180x180.png',     label: 'Apple Touch Icon 180×180',            priority: 78 },
    { path: '/android-chrome-192x192.png',       label: 'Android Chrome 192×192',              priority: 74 },
    { path: '/android-chrome-512x512.png',       label: 'Android Chrome 512×512',              priority: 72 },
    { path: '/mstile-150x150.png',               label: 'Microsoft Tile 150×150',              priority: 70 },
    { path: '/assets/favicon.ico',               label: '构建目录 /assets/favicon.ico',         priority: 68 },
    { path: '/static/favicon.ico',               label: '构建目录 /static/favicon.ico',         priority: 66 },
    { path: '/img/favicon.ico',                  label: '构建目录 /img/favicon.ico',            priority: 64 },
    { path: '/images/favicon.ico',               label: '构建目录 /images/favicon.ico',         priority: 62 }
  ];

  /* Manifest 猜测路径（文档 §3.2 实测命中 3/18） */
  var MANIFEST_PATHS = ['/manifest.json', '/site.webmanifest', '/manifest.webmanifest'];

  var BROWSERCONFIG_PATH = '/browserconfig.xml';

  /* 格式加成（文档 §4） */
  var FORMAT_BONUS = { svg: 10, png: 5, ico: 0, bmp: -3, webp: -5, gif: -8, jpeg: -10 };

  var EXT_KIND = {
    svg: 'svg', png: 'png', ico: 'ico', jpg: 'jpeg', jpeg: 'jpeg',
    gif: 'gif', webp: 'webp', bmp: 'bmp'
  };

  /* ---------- 受限并发调度 ---------- */

  function runWithConcurrency(tasks, limit, onProgress) {
    return new Promise(function (resolve) {
      var total = tasks.length;
      var results = new Array(total);
      var next = 0;
      var active = 0;
      var done = 0;

      if (!total) { resolve(results); return; }

      function launch() {
        while (active < limit && next < total) {
          (function (index) {
            active++;
            Promise.resolve()
              .then(tasks[index])
              .then(function (r) { results[index] = r; })
              .catch(function (e) { results[index] = { error: e }; })
              .then(function () {
                active--;
                done++;
                if (typeof onProgress === 'function') {
                  try { onProgress(done, total, results[index]); } catch (e) { /* 忽略 */ }
                }
                if (done >= total) resolve(results);
                else launch();
              });
          })(next);
          next++;
        }
      }

      launch();
    });
  }

  /* ---------- 让出主线程：保证状态条与进度能先绘制，再执行同步解析 ---------- */

  function formatBytes(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(v < 10240 ? 1 : 0) + ' KB';
    return (v / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function yieldToUi() {
    return new Promise(function (resolve) {
      if (typeof global.requestAnimationFrame === 'function') {
        global.requestAnimationFrame(function () { setTimeout(resolve, 0); });
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  /* ---------- 文本请求（CORS，失败是常态） ---------- */

  function fetchText(url, timeoutMs) {
    return new Promise(function (resolve) {
      var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var settled = false;

      function done(r) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      }

      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        if (controller) { try { controller.abort(); } catch (e) { /* 忽略 */ } }
        resolve({ ok: false, reason: 'timeout' });
      }, timeoutMs);

      var opts = {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        redirect: 'follow',
        cache: 'no-store'
      };
      if (controller) opts.signal = controller.signal;

      fetch(url, opts).then(function (res) {
        if (!res.ok) { done({ ok: false, reason: 'http', status: res.status }); return null; }
        return res.text().then(function (text) {
          done({ ok: true, text: text, finalUrl: res.url || url });
        }, function () {
          done({ ok: false, reason: 'read-failed' });
        });
      }).catch(function () {
        done({ ok: false, reason: 'cors-blocked' });
      });
    });
  }

  /* ---------- 评分（文档 §4） ---------- */

  function guessKind(item) {
    if (item.kind) return item.kind;
    var m = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(item.url || '');
    return m ? (EXT_KIND[m[1].toLowerCase()] || 'unknown') : 'unknown';
  }

  function scoreOf(item) {
    var score = item.priority || 0;

    // 尺寸加成：180px → +45，16px → +4
    var minSide = Math.min(item.width || 0, item.height || 0);
    score += Math.min(50, Math.round(minSide / 4));

    // 格式加成
    score += FORMAT_BONUS[guessKind(item)] || 0;

    // maskable 含安全区留白，实际观感偏小
    if (item.purpose && item.purpose.indexOf('maskable') !== -1) score -= 5;

    // 宽高比偏离 1:1 的（og:image 横幅、横向组合标）
    if (item.width && item.height) {
      var ratio = item.width / item.height;
      if (ratio < 0.75 || ratio > 1.33) score -= 20;
    }

    // 已通过 CORS 验真的略微加分（状态码与格式都确认过）
    if (item.verified === true) score += 3;

    return score;
  }

  /** 返回不可用原因；空串表示可用 */
  function exclusionReason(item) {
    if (item.usable === false) return item.rejectReason || '内容不是可用图片';
    if (item.purpose &&
        item.purpose.indexOf('monochrome') !== -1 &&
        item.purpose.indexOf('any') === -1) {
      return 'monochrome 单色蒙版，浏览器会丢弃颜色只取 alpha，不能作为彩色图标';
    }
    return '';
  }

  /* ---------- 主流程 ---------- */

  /**
   * @param {URL} pageUrl 已校验的目标 URL
   * @param {object} [options]
   * @param {boolean} [options.parseHtml=true]      读取首页 HTML 解析声明
   * @param {boolean} [options.useManifest=true]    读取 Web App Manifest
   * @param {boolean} [options.usePageImages=true]  页面图片兜底
   * @param {boolean} [options.useArchive=false]    网页存档快照（第三方）
   * @param {boolean} [options.useThirdParty=false] 第三方 favicon 服务（第三方）
   * @param {number}  [options.timeout=9000]        首页 HTML 超时
   * @param {number}  [options.assetTimeout=8000]   manifest / browserconfig 超时
   * @param {number}  [options.imageTimeout=6000]   单个图标探测超时
   * @param {number}  [options.verifyTimeout=6000]  CORS 验真超时
   * @param {number}  [options.concurrency=6]       探测并发数
   * @param {function} [options.onProgress]         (done, total) 进度
   * @param {function} [options.onPhase]            (phaseKey) 阶段变化
   * @returns {Promise<object>} 探测报告
   */
  function findFavicons(pageUrl, options) {
    var opts = options || {};
    var pageTimeout = opts.timeout || 9000;
    var assetTimeout = opts.assetTimeout || 8000;
    var imageTimeout = opts.imageTimeout || 6000;
    var verifyTimeout = opts.verifyTimeout || 6000;
    var concurrency = opts.concurrency || 6;
    var maxBytes = opts.maxBytes || 65536;
    // 解析源码时最多读取的字节数：图标声明都在 <head>，读完就取消剩余下载
    var htmlLimit = opts.htmlLimit || 524288;

    var want = {
      html: opts.parseHtml !== false,
      manifest: opts.useManifest !== false,
      pageImages: opts.usePageImages !== false,
      archive: opts.useArchive === true,
      thirdParty: opts.useThirdParty === true
    };

    var origin = pageUrl.origin;
    var host = pageUrl.hostname;

    var warnings = [];
    var pool = [];
    var seenUrl = Object.create(null);
    var pageImageQueue = [];
    var declaredManifestUrl = '';
    var suppressed = false;

    // 源码解析状态：供界面展示「解析了什么、读了多少、为什么失败」
    var pageHtmlChunk = '';
    var pageHtmlBase = null;
    var htmlMeta = {
      tried: [],
      ok: false,
      reason: '',
      status: 0,
      finalUrl: '',
      bytesRead: 0,
      totalBytes: 0,
      truncated: false,
      headTrimmed: false,
      declaredCount: 0,
      manifestUrl: '',
      suppressed: false
    };

    function note(type, text) { warnings.push({ type: type, text: text }); }

    var reachPromise = null;
    function checkReachable() {
      if (!reachPromise) reachPromise = Probe.probeReachable(origin, Math.min(pageTimeout, 6000));
      return reachPromise;
    }

    function reportPhase(key) {
      if (typeof opts.onPhase === 'function') {
        try { opts.onPhase(key); } catch (e) { /* 忽略 */ }
      }
    }

    function add(candidate) {
      if (!candidate || !candidate.url) return null;
      if (seenUrl[candidate.url]) return null;
      seenUrl[candidate.url] = 1;
      candidate.width = 0;
      candidate.height = 0;
      candidate.ok = false;
      candidate.probed = false;
      pool.push(candidate);
      return candidate;
    }

    function addAll(list) {
      for (var i = 0; i < (list || []).length; i++) add(list[i]);
    }

    /* ===== 阶段 A：页面声明（解析网页源码） ===== */

    var phaseA = Promise.resolve();

    if (want.html) {
      reportPhase('html');

      // 优先请求用户给的地址；失败则回退到站点根。
      // 依据实测：同一站点的不同路径，CORS 策略可能完全不同，根路径常常更宽松。
      var htmlUrls = [pageUrl.href];
      try {
        var rootHref = new URL('/', pageUrl.origin).href;
        if (rootHref !== pageUrl.href) htmlUrls.push(rootHref);
      } catch (e) { /* 忽略 */ }

      function requestHtml(url) {
        return Probe.fetchHeadBytes(url, pageTimeout, htmlLimit).then(function (r) {
          htmlMeta.tried.push({
            url: url,
            ok: !!r.ok,
            status: r.ok ? r.status : 0,
            reason: r.ok ? '' : r.reason
          });
          if (!r.ok) return null;
          if (!r.httpOk) {
            htmlMeta.status = r.status;
            return null;
          }
          return r;
        });
      }

      function pickHtmlUrl() {
        var i = 0;
        function next() {
          if (i >= htmlUrls.length) return Promise.resolve(null);
          return requestHtml(htmlUrls[i++]).then(function (r) {
            return r || next();
          });
        }
        return next();
      }

      phaseA = pickHtmlUrl().then(function (hit) {
        if (!hit) {
          return checkReachable().then(function (reach) {
            if (reach.ok) {
              htmlMeta.reason = 'cors-blocked';
              note('warn', '站点可访问，但页面源码被浏览器的跨域策略（CORS）拦截，无法读取声明的 icon。' +
                           '这是纯前端方案的固有限制，不代表该站点没有图标。');
            } else {
              htmlMeta.reason = 'unreachable';
              note('warn', '未能读取页面源码，且无法连接到 ' + origin +
                           '（域名可能不存在、DNS 解析失败，或网络暂时不可达）。');
            }
          });
        }

        // 先让浏览器把状态条画出来，再做同步的 DOMParser——大页面下这一步很关键
        return yieldToUi().then(function () {
          htmlMeta.ok = true;
          htmlMeta.reason = '';
          htmlMeta.status = hit.status;
          htmlMeta.finalUrl = hit.finalUrl;
          htmlMeta.bytesRead = hit.bytesRead;
          htmlMeta.totalBytes = hit.totalBytes;
          htmlMeta.truncated = !!hit.truncated;

          var base;
          try { base = new URL(hit.finalUrl || pageUrl.href); } catch (e) { base = pageUrl; }
          pageHtmlBase = base;
          pageHtmlChunk = hit.text;

          var parsed;
          try {
            parsed = Parse.parseHtml(hit.text, base);
          } catch (e) {
            note('warn', '页面源码解析失败，已跳过声明解析。');
            return;
          }

          suppressed = !!parsed.suppressed;
          declaredManifestUrl = parsed.manifestUrl || '';

          htmlMeta.suppressed = suppressed;
          htmlMeta.manifestUrl = declaredManifestUrl;
          htmlMeta.declaredCount = parsed.icons.length;
          htmlMeta.headTrimmed = !!parsed.headTrimmed;

          addAll(parsed.icons);
          pageImageQueue = pageImageQueue.concat(parsed.pageImages);

          if (suppressed) {
            note('warn', '页面声明了空负载的 data: 图标（如 href="data:,"）——这是主动抑制 favicon 的写法，说明该站点明确不提供图标。');
          }
          if (parsed.icons.length) {
            note('info', '成功读取页面源码，解析出 ' + parsed.icons.length + ' 个声明的图标。');
          } else if (!suppressed) {
            note('info', '页面源码可读，但其中没有 <link rel="icon"> 之类的图标声明。');
          }
          if (htmlMeta.truncated) {
            note('info', '页面较大，只读取了前 ' + formatBytes(htmlMeta.bytesRead) +
                         ' 用于解析（完整页面约 ' + (htmlMeta.totalBytes ? formatBytes(htmlMeta.totalBytes) : '未知') + '）。');
          }
          if (base.host !== pageUrl.host) {
            note('info', '页面最终跳转到 ' + base.origin + '，声明的图标按跳转后的地址解析。');
          }
        });
      });
    }

    /* ===== 阶段 B：Manifest（先试声明的地址，再猜常见路径） ===== */

    var phaseB = phaseA.then(function () {
      if (!want.manifest) return null;
      reportPhase('manifest');

      var urls = [];
      var seenU = Object.create(null);

      function push(u) {
        if (!u || seenU[u]) return;
        seenU[u] = 1;
        urls.push(u);
      }

      if (declaredManifestUrl) push(declaredManifestUrl);
      for (var i = 0; i < MANIFEST_PATHS.length; i++) {
        try { push(new URL(MANIFEST_PATHS[i], origin).href); } catch (e) { /* 忽略 */ }
      }

      var idx = 0;

      function next() {
        if (idx >= urls.length) return Promise.resolve(null);
        var u = urls[idx++];

        return fetchText(u, assetTimeout).then(function (r) {
          if (!r.ok) return next();

          var json = Parse.parseJson(r.text);
          if (!json) {
            note('info', '已跳过 manifest：' + u + ' 返回的内容不是合法 JSON（可能是 SPA 兜底页面）。');
            return next();
          }
          if (!Array.isArray(json.icons)) {
            note('info', '已跳过 manifest：' + u + ' 是合法 JSON，但没有 icons 字段。');
            return next();
          }

          var icons = Parse.parseManifest(json, r.finalUrl || u);
          if (!icons.length) {
            note('info', '已跳过 manifest：' + u + ' 的 icons 数组为空。');
            return next();
          }

          return { url: r.finalUrl || u, icons: icons };
        });
      }

      return next().then(function (hit) {
        if (hit) {
          addAll(hit.icons);
          note('info', '从 manifest 读取到 ' + hit.icons.length + ' 个图标：' + hit.url);
        }
        return hit;
      });
    });

    /* ===== 阶段 C：常见路径 + browserconfig.xml ===== */

    var phaseC = phaseB.then(function () {
      reportPhase('paths');

      for (var i = 0; i < DEFAULT_PATHS.length; i++) {
        var p = DEFAULT_PATHS[i];
        var abs;
        try { abs = new URL(p.path, origin).href; } catch (e) { continue; }
        add({
          url: abs,
          source: 'default',
          priority: p.priority,
          side: 0,
          label: p.label
        });
      }

      if (!want.manifest) return null;

      // browserconfig.xml：可能是 SPA 兜底的 HTML，必须校验是 XML
      var bcUrl;
      try { bcUrl = new URL(BROWSERCONFIG_PATH, origin).href; } catch (e) { return null; }

      return fetchText(bcUrl, assetTimeout).then(function (r) {
        if (!r.ok) return null;
        var items = Parse.parseBrowserConfig(r.text, r.finalUrl || bcUrl);
        if (!items.length) {
          note('info', '/browserconfig.xml 返回的内容不是有效的磁贴配置 XML，已忽略。');
          return null;
        }
        addAll(items);
        note('info', '从 /browserconfig.xml 读取到 ' + items.length + ' 个磁贴图。');
        return items;
      });
    });

    /* ===== 波次探测 ===== */

    function probeWave(items) {
      var tasks = items.map(function (item) {
        return function () {
          item.probed = true;
          return Probe.probeImage(item.url, imageTimeout).then(function (r) {
            item.ok = !!r.ok;
            item.width = r.width || 0;
            item.height = r.height || 0;
            item.el = r.el || null;
            item.reason = r.reason || null;
            return item;
          }, function () {
            item.ok = false;
            item.reason = 'internal';
            return item;
          });
        };
      });
      return runWithConcurrency(tasks, concurrency, function (done, total) {
        if (typeof opts.onProgress === 'function') {
          try { opts.onProgress(done, total); } catch (e) { /* 忽略 */ }
        }
      });
    }

    /* ===== CORS 验真（文档 §1.1：有 ACAO 时才能读到状态码与字节） ===== */

    function verifyFound(found) {
      var targets = found.filter(function (it) {
        return !it.skipVerify && !/^data:/i.test(it.url);
      });

      var tasks = targets.map(function (it) {
        return function () {
          return Probe.verifyCors(it.url, verifyTimeout, maxBytes).then(function (r) {
            if (!r.ok) {
              it.verified = false;
              it.verifyReason = r.reason;
              return it;
            }

            it.verified = true;
            it.httpStatus = r.status;
            it.kind = r.kind;
            it.contentType = r.contentType;
            it.bytes = r.contentLength;
            it.icoSizes = r.icoSizes;

            if (r.status !== 200 || !r.isImage) {
              it.usable = false;
              it.rejectReason = 'HTTP ' + r.status + '，实际内容是 ' +
                (Probe.KIND_LABEL[r.kind] || r.kind) + '，不是图片';
              return it;
            }

            return Probe.measurePixels(r.bytes, r.kind).then(function (px) {
              if (px.ok) {
                it.opaqueRatio = px.opaqueRatio;
                it.pixelWidth = px.width;
                it.pixelHeight = px.height;
              }
              return it;
            });
          }, function () {
            it.verified = false;
            return it;
          });
        };
      });

      return runWithConcurrency(tasks, 4);
    }

    /* ===== 波次 2 / 3 的候选构造 ===== */

    function buildArchiveCandidates() {
      var year = new Date().getFullYear();
      var list = [];
      var paths = ['/favicon.ico', '/apple-touch-icon.png'];
      for (var i = 0; i < paths.length; i++) {
        list.push({
          url: 'https://web.archive.org/web/' + year + 'id_/' + origin + paths[i],
          source: 'archive',
          priority: 40,
          side: 0,
          label: '存档快照 · ' + paths[i] + '（Wayback）',
          note: '来自网页存档，可能是过期版本，不代表站点当前图标',
          skipVerify: true,
          external: true
        });
      }
      return list;
    }

    function buildThirdPartyCandidates() {
      var q = encodeURIComponent(host);
      return [
        {
          url: 'https://www.google.com/s2/favicons?domain=' + q + '&sz=128',
          source: 'third-party',
          priority: 20,
          side: 128,
          label: '第三方 · Google S2（128px）',
          note: '由第三方服务提供，可能不是站点当前图标，也可能是默认占位图，且无法验证',
          skipVerify: true,
          external: true
        },
        {
          url: 'https://icons.duckduckgo.com/ip3/' + q + '.ico',
          source: 'third-party',
          priority: 18,
          side: 32,
          label: '第三方 · DuckDuckGo',
          note: '由第三方服务提供，可能不是站点当前图标，也可能是默认占位图，且无法验证',
          skipVerify: true,
          external: true
        }
      ];
    }

    /* ===== 串联全流程 ===== */

    return phaseC.then(function () {
      var wave1 = pool.slice();

      return probeWave(wave1).then(function () {
        var found = pool.filter(function (it) { return it.ok; });
        var usedFallback = '';

        if (found.length) return { found: found, usedFallback: '' };

        // 波次 2：页面图片兜底（需要 <body>，开销更大，只有前面全落空才走这里）
        if (want.pageImages && (pageImageQueue.length || pageHtmlChunk)) {
          reportPhase('pageImages');
          return yieldToUi().then(function () {
            var extras = pageImageQueue.slice();
            if (pageHtmlChunk && pageHtmlBase) {
              try {
                extras = extras.concat(Parse.parsePageImages(pageHtmlChunk, pageHtmlBase));
              } catch (e) { /* 忽略 */ }
            }

            var wave2 = [];
            extras.forEach(function (c) { var r = add(c); if (r) wave2.push(r); });
            if (!wave2.length) return null;

            return probeWave(wave2).then(function () {
              var f2 = pool.filter(function (it) { return it.ok; });
              if (f2.length) {
                note('warn', '未能找到图标声明或常规路径图标，以下结果来自页面图片（logo / og:image），' +
                             '它们不是图标，可能含文字或为横幅，仅供参考。');
                return { found: f2, usedFallback: 'pageImages' };
              }
              return null;
            });
          });
        }
        return null;
      }).then(function (mid) {
        if (mid) return mid;

        // 波次 3：存档 / 第三方（都需显式开启）
        var wave3 = [];
        if (want.archive) buildArchiveCandidates().forEach(function (c) { var r = add(c); if (r) wave3.push(r); });
        if (want.thirdParty) buildThirdPartyCandidates().forEach(function (c) { var r = add(c); if (r) wave3.push(r); });
        if (!wave3.length) return { found: [], usedFallback: '' };

        reportPhase('external');

        if (want.archive) {
          note('info', '已按你的选择向 web.archive.org 请求了该站点的存档快照。');
        }
        if (want.thirdParty) {
          note('info', '已按你的选择把域名 ' + host + ' 发送给第三方图标服务（Google S2 / DuckDuckGo）。');
        }

        return probeWave(wave3).then(function () {
          var f3 = pool.filter(function (it) { return it.ok; });
          if (f3.length && want.archive) {
            note('warn', '以下结果来自网页存档快照，可能已过期，不代表该站点当前图标。');
          }
          if (f3.length && want.thirdParty) {
            note('warn', '以下结果来自第三方图标服务，未经源站确认，可能不是最新图标，也可能是服务的默认占位图。' +
                         '你查询的域名已发送给该第三方。');
          }
          return { found: f3, usedFallback: 'external' };
        });
      }).then(function (mid) {
        if (mid) return mid;
        return { found: [], usedFallback: '' };
      }).then(function (mid) {
        var found = mid.found;
        var usedFallback = mid.usedFallback;

        reportPhase('verify');

        // 对成功项做 CORS 验真
        var verifyStep = found.length
          ? verifyFound(found)
          : Promise.resolve([]);

        return verifyStep.then(function () {
          var anyVerified = false;
          var anyCorsBlocked = false;
          for (var i = 0; i < found.length; i++) {
            if (found[i].verified === true) anyVerified = true;
            if (found[i].verified === false && found[i].verifyReason === 'cors-blocked') anyCorsBlocked = true;
          }

          if (found.length && !anyVerified && anyCorsBlocked) {
            note('info', '该站点未对图标资源返回 Access-Control-Allow-Origin，纯前端无法读取 HTTP 状态码与响应内容，' +
                         '只能以「图片能否显示」作为唯一判据（实测约 15/19 的站点属此情形）。');
          }

          // 通配兜底启发式（一）：多个路径返回完全相同大小的**字节数**（需 CORS）
          var bySize = Object.create(null);
          for (var j = 0; j < found.length; j++) {
            var b = found[j].bytes;
            if (!b) continue;
            bySize[b] = (bySize[b] || 0) + 1;
          }
          for (var size in bySize) {
            if (bySize[size] >= 3) {
              note('warn', '有 ' + bySize[size] + ' 个不同路径返回了完全相同大小的文件（' + size +
                           ' 字节），该服务器可能是通配兜底（任意路径都返回同一张图），请人工确认。');
              break;
            }
          }

          // 通配兜底启发式（二）：多个默认路径返回完全相同的**尺寸**（不依赖 CORS）
          var byDim = Object.create(null);
          for (var m = 0; m < found.length; m++) {
            var f = found[m];
            if (f.source !== 'default' || !f.width || !f.height) continue;
            var dimKey = f.width + 'x' + f.height;
            if (!byDim[dimKey]) byDim[dimKey] = [];
            byDim[dimKey].push(f);
          }
          for (var dim in byDim) {
            if (byDim[dim].length >= 5) {
              note('warn', '有 ' + byDim[dim].length + ' 个不同的默认路径都返回了完全相同尺寸的图（' + dim +
                           '），该服务器很可能存在通配兜底（任意路径都返回同一张图），' +
                           '此时路径探测的「命中数」不代表真的存在这么多图标。');
              break;
            }
          }

          // 不可用 / 需排除的项
          var usable = [];
          for (var k = 0; k < found.length; k++) {
            var reason = exclusionReason(found[k]);
            if (reason) {
              found[k].excluded = true;
              found[k].excludeReason = reason;
            } else {
              usable.push(found[k]);
            }
          }

          usable.sort(function (a, b) {
            var d = scoreOf(b) - scoreOf(a);
            if (d !== 0) return d;
            return (b.priority || 0) - (a.priority || 0);
          });

          var finish = (usable.length || found.length) ? Promise.resolve(null) : checkReachable();

          return finish.then(function (reach) {
            if (!usable.length && !found.length) {
              var timeouts = pool.filter(function (it) { return it.probed && !it.ok && it.reason === 'timeout'; }).length;
              if (timeouts) {
                note('warn', '有 ' + timeouts + ' 个候选请求超时，可能是网络较慢或该站点响应缓慢。');
              }
            }

            // 未尝试过的兜底候选（波次已命中，故未探测）——如实标注
            var skipped = pool.filter(function (it) { return !it.probed; });

            return {
              pageUrl: pageUrl.href,
              origin: origin,
              host: host,
              attempts: pool,
              skipped: skipped,
              found: found,
              usable: usable,
              best: usable[0] || null,
              alternatives: usable.slice(1),
              warnings: warnings,
              reachable: reach ? !!reach.ok : null,
              reachChecked: !!reach || !!reachPromise,
              suppressed: suppressed,
              usedFallback: usedFallback,
              anyVerified: anyVerified,
              htmlMeta: htmlMeta
            };
          });
        });
      });
    });
  }

  global.IconFinder = {
    DEFAULT_PATHS: DEFAULT_PATHS,
    MANIFEST_PATHS: MANIFEST_PATHS,
    scoreOf: scoreOf,
    findFavicons: findFavicons,
    // 兼容旧调用
    probeImage: function (url, t) { return Probe.probeImage(url, t); },
    probeReachable: function (o, t) { return Probe.probeReachable(o, t); },
    collectDeclaredIcons: function (html, base) { return Parse.parseHtml(html, base).icons; }
  };
})(window);
