/* ==========================================================================
   icon-parse.js —— 解析层（对应文档 §3.1 / §3.2 / §3.3）
   暴露：window.IconParse

   候选对象统一结构：
     { url, source, priority, side, label, purpose, rel, typeHint, note }
   priority 由解析层直接给出，编排层只做加成与惩罚。
   ========================================================================== */
(function (global) {
  'use strict';

  var PRIORITY = {
    declaredIcon: 200,     // <link rel="icon">
    declaredShortcut: 195, // <link rel="shortcut icon">（遗留写法）
    declaredTouch: 200,    // apple-touch-icon（常为 180px，质量好）
    declaredMask: 120,     // mask-icon（单色蒙版，不可当彩色图标）
    tileImage: 150,        // <meta name="msapplication-TileImage">
    manifest: 160,         // Web App Manifest icons[]
    imageSrc: 32,          // <link rel="image_src">（遗留）
    pageImage: 30,         // og:image / twitter:image
    inlineLogo: 35,        // 页面里 src/alt 含 logo 的 <img>
    browserConfig: 65      // browserconfig.xml 的磁贴图
  };

  /** 解析 sizes 声明，取最大边；'any' 按矢量处理 */
  function parseSizes(sizes) {
    if (!sizes) return 0;
    var s = String(sizes).toLowerCase().trim();
    if (s === 'any') return 512;
    var best = 0;
    var re = /(\d+)\s*x\s*(\d+)/g;
    var m;
    while ((m = re.exec(s))) {
      var v = Math.max(parseInt(m[1], 10) || 0, parseInt(m[2], 10) || 0);
      if (v > best) best = v;
    }
    return best;
  }

  /* ---------- 候选数量上限：防止异常页面把候选池撑爆，拖慢后续探测与渲染 ---------- */
  var MAX_DECLARED = 20;       // <link> 类声明
  var MAX_MANIFEST = 12;       // Manifest icons[]
  var MAX_PAGE_IMAGES = 10;    // og:image / twitter:image / image_src
  var MAX_INLINE_LOGO = 6;     // 页面内 <img> logo

  /**
   * 只保留 <head> 片段。图标声明全部位于 <head>，
   * 而页面体积的绝大部分在 <body>——砍掉它能让 DOMParser 的开销下降一个量级。
   *
   * @param {string} html
   * @returns {{html:string, trimmed:boolean, reason:string}}
   */
  function trimHtmlToHead(html) {
    if (!html) return { html: '', trimmed: false, reason: 'empty' };

    var lower = html.toLowerCase();
    var headEnd = lower.indexOf('</head>');
    if (headEnd !== -1) {
      var cut = headEnd + 7;
      if (cut < html.length) return { html: html.slice(0, cut), trimmed: true, reason: 'head-end' };
      return { html: html, trimmed: false, reason: 'whole' };
    }

    var bodyStart = lower.indexOf('<body');
    if (bodyStart !== -1) {
      return { html: html.slice(0, bodyStart), trimmed: true, reason: 'body-start' };
    }

    // 没找到 </head> 也没找到 <body>：可能被截断在 head 中间，整段都用上
    return { html: html, trimmed: false, reason: 'no-marker' };
  }

  /** 是否为空负载的 data: URI —— 这是「主动抑制 favicon」的写法，不是图标 */
  function isEmptyDataUri(href) {
    if (!/^data:/i.test(href)) return false;
    var comma = href.indexOf(',');
    if (comma === -1) return true;
    return !href.slice(comma + 1).trim();
  }

  /**
   * 解析首页 HTML，收集所有图标相关声明（文档 §3.1、§3.4）。
   *
   * @param {string} html
   * @param {URL} pageUrl 页面最终 URL（相对路径解析基准）
   * @returns {{icons:Array, manifestUrl:string, pageImages:Array, suppressed:boolean, baseUrl:string}}
   */
  function parseHtml(html, pageUrl) {
    var result = {
      icons: [],
      manifestUrl: '',
      pageImages: [],
      suppressed: false,
      baseUrl: pageUrl.href
    };

    // 只解析 <head>：图标声明都在这里，body 通常才是体积大头
    var trimmed = trimHtmlToHead(html);
    var parsedHtml = trimmed.html;

    var doc;
    try {
      doc = new DOMParser().parseFromString(parsedHtml, 'text/html');
    } catch (e) {
      return result;
    }
    if (!doc || !doc.querySelectorAll) return result;

    result.headTrimmed = trimmed.trimmed;
    result.headTrimReason = trimmed.reason;

    // <base href> 会改变相对路径的解析基准
    var baseUrl = pageUrl;
    try {
      var baseEl = doc.querySelector('base[href]');
      if (baseEl) {
        var bh = (baseEl.getAttribute('href') || '').trim();
        if (bh) {
          baseUrl = new URL(bh, pageUrl.href);
          result.baseUrl = baseUrl.href;
        }
      }
    } catch (e) { /* 解析失败则退回页面 URL */ }

    function toAbs(href) {
      if (!href) return '';
      var v = String(href).trim();
      if (!v) return '';
      try { return new URL(v, baseUrl.href).href; } catch (e) { return ''; }
    }

    function isAllowedProto(u) {
      try {
        var p = new URL(u).protocol;
        return p === 'http:' || p === 'https:' || p === 'data:';
      } catch (e) { return false; }
    }

    var seen = Object.create(null);

    /* ---- <link rel="...icon..."> 及 manifest / image_src ---- */
    var links = doc.querySelectorAll('link[rel]');
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var rel = (link.getAttribute('rel') || '').toLowerCase().trim();
      if (!rel) continue;

      var rawHref = (link.getAttribute('href') || '').trim();

      if (rel.split(/\s+/).indexOf('manifest') !== -1) {
        var mUrl = toAbs(rawHref);
        if (mUrl && isAllowedProto(mUrl) && !result.manifestUrl) result.manifestUrl = mUrl;
        continue;
      }

      if (rel.indexOf('icon') === -1) {
        // 遗留声明：<link rel="image_src">
        if (rel.split(/\s+/).indexOf('image_src') !== -1 && !isEmptyDataUri(rawHref)) {
          var srcUrl = toAbs(rawHref);
          if (srcUrl && isAllowedProto(srcUrl) && !seen[srcUrl]) {
            seen[srcUrl] = 1;
            result.pageImages.push({
              url: srcUrl,
              source: 'page-image',
              priority: PRIORITY.imageSrc,
              side: 0,
              label: '页面声明 · image_src',
              note: '遗留的代表图声明，非图标语义'
            });
          }
        }
        continue;
      }

      // 主动抑制：<link rel=icon href=data:,>
      if (isEmptyDataUri(rawHref)) {
        result.suppressed = true;
        continue;
      }

      if (result.icons.length >= MAX_DECLARED) continue;

      var abs = toAbs(rawHref);
      if (!abs || !isAllowedProto(abs)) continue;
      if (seen[abs]) continue;
      seen[abs] = 1;

      var sizes = (link.getAttribute('sizes') || '').trim();
      var type = (link.getAttribute('type') || '').trim();
      var color = (link.getAttribute('color') || '').trim();

      var isMask = rel.indexOf('mask-icon') !== -1;
      var isTouch = rel.indexOf('apple-touch') !== -1;
      var isShortcut = rel.split(/\s+/).indexOf('shortcut') !== -1;

      var priority = PRIORITY.declaredIcon;
      var kind = 'icon';
      var note = '';

      if (isMask) {
        priority = PRIORITY.declaredMask;
        kind = 'mask-icon';
        note = '单色蒙版图标（Safari 固定标签页），不适合作为彩色图标使用' + (color ? '' : '；未声明 color，可能不生效');
      } else if (isTouch) {
        priority = PRIORITY.declaredTouch;
        kind = 'apple-touch-icon';
        note = 'iOS 主屏图标，Safari 中优先于 Manifest 图标';
      } else if (isShortcut) {
        priority = PRIORITY.declaredShortcut;
        kind = 'shortcut icon';
        note = '遗留写法，shortcut 为非规范关键字，浏览器忽略后等效于 icon';
      }

      var label = '页面声明 · ' + kind;
      if (sizes) label += ' ' + sizes;
      else if (type) label += ' ' + type;

      result.icons.push({
        url: abs,
        source: 'declared',
        priority: priority,
        side: parseSizes(sizes),
        label: label,
        rel: rel,
        typeHint: type,
        note: note
      });
    }

    /* ---- <meta> 类声明 ---- */
    var metas = doc.querySelectorAll('meta');
    for (var j = 0; j < metas.length; j++) {
      var meta = metas[j];
      var key = (meta.getAttribute('property') || meta.getAttribute('name') || '').toLowerCase().trim();
      var content = (meta.getAttribute('content') || '').trim();
      if (!key || !content) continue;

      if (key === 'msapplication-tileimage') {
        var tileUrl = toAbs(content);
        if (tileUrl && isAllowedProto(tileUrl) && !seen[tileUrl]) {
          seen[tileUrl] = 1;
          result.icons.push({
            url: tileUrl,
            source: 'declared',
            priority: PRIORITY.tileImage,
            side: 144,
            label: '页面声明 · msapplication-TileImage',
            note: 'Windows 磁贴图，通常为 144×144 PNG'
          });
        }
      } else if (key === 'og:image' || key === 'twitter:image' || key === 'og:logo') {
        if (result.pageImages.length >= MAX_PAGE_IMAGES) continue;
        var imgUrl = toAbs(content);
        if (imgUrl && isAllowedProto(imgUrl) && !seen[imgUrl]) {
          seen[imgUrl] = 1;
          result.pageImages.push({
            url: imgUrl,
            source: 'page-image',
            priority: PRIORITY.pageImage,
            side: 0,
            label: '页面图片 · ' + key,
            note: '社交分享卡片图，常见为 1200×630 横幅，含文字，不是图标'
          });
        }
      }
    }

    /* ---- 页面里的 <img> logo 不在这里处理 ---- */
    // 它们位于 <body>，已被 trimHtmlToHead 砍掉；
    // 只有兜底波次才需要，届时由 parsePageImages 单独解析整段文本。

    result.icons.sort(function (a, b) { return b.side - a.side; });
    return result;
  }

  /**
   * 从页面文本里找出疑似 logo 的 <img>（兜底用，对应文档 §3.4）。
   * 与 parseHtml 分开：这一步需要 <body>，开销更大，只在兜底时才调用。
   *
   * @param {string} html 已按上限截断的页面文本
   * @param {URL} pageUrl
   * @returns {Array}
   */
  function parsePageImages(html, pageUrl) {
    var out = [];
    if (!html) return out;

    var doc;
    try {
      doc = new DOMParser().parseFromString(html, 'text/html');
    } catch (e) {
      return out;
    }
    if (!doc || !doc.querySelectorAll) return out;

    var baseUrl = pageUrl;
    try {
      var baseEl = doc.querySelector('base[href]');
      if (baseEl) {
        var bh = (baseEl.getAttribute('href') || '').trim();
        if (bh) baseUrl = new URL(bh, pageUrl.href);
      }
    } catch (e) { /* 忽略 */ }

    var imgs = doc.querySelectorAll('img[src]');
    var seen = Object.create(null);
    var count = 0;

    for (var i = 0; i < imgs.length && count < MAX_INLINE_LOGO; i++) {
      var im = imgs[i];
      var src = (im.getAttribute('src') || '').trim();
      var alt = (im.getAttribute('alt') || '').toLowerCase();
      if (!src) continue;
      if ((src + ' ' + alt).toLowerCase().indexOf('logo') === -1) continue;

      var abs;
      try { abs = new URL(src, baseUrl.href).href; } catch (e) { continue; }

      var proto = '';
      try { proto = new URL(abs).protocol; } catch (e) { continue; }
      if (proto !== 'http:' && proto !== 'https:') continue;

      if (seen[abs]) continue;
      seen[abs] = 1;
      count++;

      out.push({
        url: abs,
        source: 'page-image',
        priority: PRIORITY.inlineLogo,
        side: 0,
        label: '页面图片 · <img> logo',
        note: '页面内 logo 图，可能是含文字的组合标，缩到小尺寸后未必可辨认'
      });
    }

    return out;
  }

  /**
   * 解析 Web App Manifest 的 icons[]（文档 §3.2）。
   * 相对路径按 **manifest 自身的 URL** 解析。
   *
   * @param {object} json 已 JSON.parse 的结果
   * @param {string} manifestUrl
   * @returns {Array}
   */
  function parseManifest(json, manifestUrl) {
    var out = [];
    if (!json || typeof json !== 'object') return out;
    if (!Array.isArray(json.icons)) return out;

    var seen = Object.create(null);

    for (var i = 0; i < json.icons.length && out.length < MAX_MANIFEST; i++) {
      var ic = json.icons[i];
      if (!ic || typeof ic !== 'object') continue;

      var src = typeof ic.src === 'string' ? ic.src.trim() : '';
      if (!src) continue;

      var abs;
      try { abs = new URL(src, manifestUrl).href; } catch (e) { continue; }
      if (seen[abs]) continue;
      seen[abs] = 1;

      var sizes = typeof ic.sizes === 'string' ? ic.sizes.trim() : '';
      var type = typeof ic.type === 'string' ? ic.type.trim() : '';
      var purpose = typeof ic.purpose === 'string' ? ic.purpose.trim().toLowerCase() : '';

      var label = 'Manifest · ' + (sizes || type || '未声明尺寸');
      if (purpose) label += ' [' + purpose + ']';

      var note = '';
      if (purpose.indexOf('maskable') !== -1) {
        note = 'maskable 图标含安全区留白，直接当 favicon 会显得偏小';
      }
      if (purpose.indexOf('monochrome') !== -1) {
        note = 'monochrome 单色蒙版，浏览器会丢弃颜色只取 alpha，不可当彩色图标';
      }

      out.push({
        url: abs,
        source: 'manifest',
        priority: PRIORITY.manifest,
        side: parseSizes(sizes),
        label: label,
        purpose: purpose,
        typeHint: type,
        note: note
      });
    }

    out.sort(function (a, b) { return b.side - a.side; });
    return out;
  }

  /**
   * 解析 /browserconfig.xml（文档 §3.3）。必须确认是 XML 而不是 SPA 兜底 HTML。
   *
   * @param {string} xml
   * @param {string} configUrl
   * @returns {Array}
   */
  function parseBrowserConfig(xml, configUrl) {
    var out = [];
    if (!xml) return out;

    var doc;
    try {
      doc = new DOMParser().parseFromString(xml, 'application/xml');
    } catch (e) {
      return out;
    }
    if (!doc || !doc.getElementsByTagName) return out;
    // 传 HTML 给 XML 解析器会得到 parsererror
    if (doc.getElementsByTagName('parsererror').length) return out;

    var all = doc.getElementsByTagName('*');
    var seen = Object.create(null);

    for (var i = 0; i < all.length; i++) {
      var node = all[i];
      if (!node.getAttribute) continue;
      var src = node.getAttribute('src');
      if (!src) continue;

      var tag = String(node.nodeName || '').toLowerCase();
      if (tag.indexOf('logo') === -1 && tag.indexOf('tile') === -1) continue;

      var abs;
      try { abs = new URL(src.trim(), configUrl).href; } catch (e) { continue; }
      if (seen[abs]) continue;
      seen[abs] = 1;

      out.push({
        url: abs,
        source: 'default',
        priority: PRIORITY.browserConfig,
        side: parseSizes(tag.replace(/[^0-9x]/g, '')) || 150,
        label: 'browserconfig.xml · ' + tag,
        note: 'Windows 磁贴配置中的图像资源'
      });
    }

    return out;
  }

  /** JSON 文本 → 对象；失败返回 null（不要抛异常） */
  function parseJson(text) {
    try {
      var v = JSON.parse(text);
      return (v && typeof v === 'object') ? v : null;
    } catch (e) {
      return null;
    }
  }

  /* ==========================================================================
     以下为「网页源码解析」独立功能所用的解析逻辑。
     处理的是**用户自行提供**的源码文本，全程不联网，与上面的 parseHtml 互不替代：
       · parseHtml   处理联网抓回的片段，只取 <head>，基准是文档 URL；
       · parseSource 处理用户粘贴的文本，解析整份文档，基准是 <base href> 或用户填写的页面地址。
     ========================================================================== */

  var MAX_SOURCE_CHARS  = 2097152;  // 单次解析上限：约 200 万字符
  var MAX_SOURCE_ICONS  = 40;       // 图标声明条数上限
  var MAX_SOURCE_IMAGES = 20;       // 页面图片条数上限
  var MAX_SOURCE_LOGOS  = 12;       // 页面内 <img> logo 条数上限

  /** 粗判输入是否为 HTML 源码（只看开头 4 KB，够用且便宜） */
  function looksLikeHtml(text) {
    var t = (text == null) ? '' : String(text);
    if (!t) return false;
    var head = t.slice(0, 4096).toLowerCase();
    if (head.indexOf('<') === -1) return false;
    if (head.indexOf('<!doctype') !== -1) return true;
    return /<(html|head|body|title|meta|link|base|script|style|div|section|img|a|span|main|nav)[\s/>]/.test(head);
  }

  /** 粗判输入是否为「网址」而不是源码 —— 用于给出更贴切的提示 */
  function looksLikeUrl(text) {
    var t = (text == null) ? '' : String(text).trim();
    if (!t || t.indexOf('<') !== -1 || t.indexOf('\n') !== -1 || t.indexOf(' ') !== -1) return false;
    if (/^[a-z][a-z0-9+.\-]*:\/\/\S+$/i.test(t)) return true;
    return /^[a-z0-9\-]+(\.[a-z0-9\-]+)+(\/\S*)?$/i.test(t);
  }

  /**
   * 解析用户提供的网页源码，识别其中的图标地址。
   *
   * 返回值：
   *   {
   *     ok, reason, inputChars, truncated,
   *     looksLikeHtml, looksLikeUrl,
   *     title, charset, baseHref, baseResolved, baseSource, userBase,
   *     icons[], manifest|null, pageImages[], suppressed,
   *     counts: { icons, manifest, pageImages, unresolved }
   *   }
   * 条目结构：{ url, raw, resolvable, kind, sizes, type, color, purpose, note }
   *   url        —— 可用的地址（能补全时为绝对地址，否则为原样文本）
   *   raw        —— 源码里的原始写法（用于展示「相对路径未补全」）
   *   resolvable —— 是否已能作为可直接使用的地址（相对路径已补全，或本就是绝对地址/data:）
   *
   * @param {string} text 用户提供的源码文本
   * @param {string} [baseUrlText] 用户填写的页面地址（可选）
   * @returns {object}
   */
  function parseSource(text, baseUrlText) {
    var out = {
      ok: false,
      reason: '',
      inputChars: 0,
      truncated: false,
      looksLikeHtml: false,
      looksLikeUrl: false,
      title: '',
      charset: '',
      baseHref: '',
      baseResolved: '',
      baseSource: 'none',
      userBase: '',
      icons: [],
      manifest: null,
      pageImages: [],
      suppressed: false,
      counts: { icons: 0, manifest: 0, pageImages: 0, unresolved: 0 }
    };

    var raw = (text == null) ? '' : String(text);
    out.inputChars = raw.length;

    if (raw.length > MAX_SOURCE_CHARS) {
      raw = raw.slice(0, MAX_SOURCE_CHARS);
      out.truncated = true;
    }

    out.looksLikeHtml = looksLikeHtml(raw);
    out.looksLikeUrl = looksLikeUrl(raw);

    if (!out.looksLikeHtml) {
      out.reason = out.looksLikeUrl ? 'looks-like-url' : 'not-html';
      return out;
    }

    // 传进来的是已经解码好的 JS 字符串，DOMParser 不会再按 <meta charset> 重新解码，
    // 所以不需要处理编码问题（源码在用户浏览器里已是 unicode）。
    var doc;
    try {
      doc = new DOMParser().parseFromString(raw, 'text/html');
    } catch (e) {
      out.reason = 'parse-error';
      return out;
    }
    if (!doc || !doc.querySelectorAll) {
      out.reason = 'parse-error';
      return out;
    }

    out.ok = true;

    /* ---- 标题与字符集声明（仅作信息展示） ---- */
    var titleEl = doc.querySelector('title');
    if (titleEl) {
      out.title = String(titleEl.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    }

    var csEl = doc.querySelector('meta[charset]');
    if (csEl) out.charset = (csEl.getAttribute('charset') || '').trim();
    if (!out.charset) {
      var heMetas = doc.querySelectorAll('meta[http-equiv]');
      for (var hi = 0; hi < heMetas.length; hi++) {
        var he = (heMetas[hi].getAttribute('http-equiv') || '').toLowerCase().trim();
        if (he === 'content-type') {
          var cm = /charset\s*=\s*([^;\s"']+)/i.exec(heMetas[hi].getAttribute('content') || '');
          if (cm) { out.charset = cm[1].trim(); break; }
        }
      }
    }

    /* ---- 相对路径基准：<base href> 优先，其次用户填写的页面地址 ---- */
    var baseEl = doc.querySelector('base[href]');
    if (baseEl) out.baseHref = (baseEl.getAttribute('href') || '').trim();

    var userBase = '';
    if (baseUrlText) {
      var ub = String(baseUrlText).trim();
      if (ub) {
        try { userBase = new URL(ub).href; } catch (e) { userBase = ''; }
      }
    }
    out.userBase = userBase;

    var baseObj = null;
    if (out.baseHref) {
      try { baseObj = userBase ? new URL(out.baseHref, userBase) : new URL(out.baseHref); }
      catch (e2) { baseObj = null; }
      if (baseObj) out.baseSource = 'tag';
    }
    if (!baseObj && userBase) {
      try { baseObj = new URL(userBase); out.baseSource = 'user'; }
      catch (e3) { baseObj = null; }
    }
    out.baseResolved = baseObj ? baseObj.href : '';

    /** 把源码里的写法转成可用地址；补全不了时保留原样并标记 */
    function toAbs(v) {
      var s = String(v == null ? '' : v).trim();
      if (!s) return { abs: '', ok: false };
      if (/^data:/i.test(s)) return { abs: s, ok: true };

      var u = null;
      if (baseObj) { try { u = new URL(s, baseObj.href); } catch (e) { u = null; } }
      if (!u) { try { u = new URL(s); } catch (e2) { u = null; } }
      if (!u) return { abs: s, ok: false };
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { abs: s, ok: false };
      return { abs: u.href, ok: true };
    }

    var seen = Object.create(null);

    function pushIcon(item) {
      if (!item.url) return;
      if (out.icons.length >= MAX_SOURCE_ICONS) return;
      if (seen[item.url]) return;
      seen[item.url] = 1;
      out.icons.push(item);
    }

    function pushPage(item) {
      if (!item.url) return;
      if (out.pageImages.length >= MAX_SOURCE_IMAGES) return;
      if (seen[item.url]) return;
      seen[item.url] = 1;
      out.pageImages.push(item);
    }

    /* ---- <link rel="..."> 上的声明 ---- */
    var links = doc.querySelectorAll('link[rel]');
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var rel = (link.getAttribute('rel') || '').toLowerCase().trim();
      if (!rel) continue;

      var relTokens = rel.split(/\s+/);
      var rawHref = (link.getAttribute('href') || '').trim();

      // Manifest 地址（图标清单在文件内部，本功能不去下载）
      if (relTokens.indexOf('manifest') !== -1) {
        if (out.manifest) continue;
        var mAbs = toAbs(rawHref);
        if (!mAbs.abs) continue;
        out.manifest = {
          url: mAbs.abs,
          raw: rawHref,
          resolvable: mAbs.ok,
          kind: 'manifest',
          sizes: '',
          type: '',
          color: '',
          purpose: '',
          note: '图标清单保存在 Manifest 文件内部。本功能只解析你提供的这份源码，不会去下载它。'
        };
        continue;
      }

      if (rel.indexOf('icon') === -1) {
        // 遗留声明：<link rel="image_src">
        if (relTokens.indexOf('image_src') !== -1 && !isEmptyDataUri(rawHref)) {
          var sAbs = toAbs(rawHref);
          pushPage({
            url: sAbs.abs, raw: rawHref, resolvable: sAbs.ok,
            kind: 'image_src', sizes: '', type: '', color: '', purpose: '',
            note: '遗留的代表图声明，不是图标语义'
          });
        }
        continue;
      }

      // 主动抑制：<link rel=icon href=data:,>
      if (isEmptyDataUri(rawHref)) {
        out.suppressed = true;
        continue;
      }

      var abs = toAbs(rawHref);
      if (!abs.abs) continue;

      var sizes = (link.getAttribute('sizes') || '').trim();
      var type  = (link.getAttribute('type') || '').trim();
      var color = (link.getAttribute('color') || '').trim();

      var isMask = rel.indexOf('mask-icon') !== -1;
      var isTouch = rel.indexOf('apple-touch') !== -1;
      var isShortcut = relTokens.indexOf('shortcut') !== -1;

      var kind = 'icon';
      var note = '';
      if (isMask) {
        kind = 'mask-icon';
        note = '单色蒙版图标（Safari 固定标签页），不适合当彩色图标使用' + (color ? '' : '；未声明 color，可能不生效');
      } else if (isTouch) {
        kind = 'apple-touch-icon';
        // 「常为 180×180」只在没声明尺寸时才说 —— 否则会和实际 sizes 自相矛盾
        note = sizes ? 'iOS 主屏图标' : 'iOS 主屏图标，未声明尺寸，较常见的规格是 180×180';
      } else if (isShortcut) {
        kind = 'shortcut icon';
        note = '遗留写法，shortcut 为非规范关键字，等效于 icon';
      }

      pushIcon({
        url: abs.abs, raw: rawHref, resolvable: abs.ok,
        kind: kind, sizes: sizes, type: type, color: color, purpose: '', note: note
      });
    }

    /* ---- <meta> 上的声明 ---- */
    var metas = doc.querySelectorAll('meta');
    for (var j = 0; j < metas.length; j++) {
      var meta = metas[j];
      var key = (meta.getAttribute('property') || meta.getAttribute('name') || '').toLowerCase().trim();
      var content = (meta.getAttribute('content') || '').trim();
      if (!key || !content) continue;

      if (key === 'msapplication-tileimage') {
        var tAbs = toAbs(content);
        pushIcon({
          url: tAbs.abs, raw: content, resolvable: tAbs.ok,
          kind: 'msapplication-TileImage', sizes: '144x144', type: '', color: '', purpose: '',
          note: 'Windows 磁贴图，通常为 144×144 PNG'
        });
      } else if (key === 'og:image' || key === 'twitter:image' || key === 'og:logo') {
        var iAbs = toAbs(content);
        pushPage({
          url: iAbs.abs, raw: content, resolvable: iAbs.ok,
          kind: key, sizes: '', type: '', color: '', purpose: '',
          note: '社交分享卡片图，常见为横幅且含文字，不是图标'
        });
      }
    }

    /* ---- 页面内疑似 logo 的 <img>（用户给的是整份源码，才做得到） ---- */
    var imgs = doc.querySelectorAll('img[src]');
    var logoCount = 0;
    for (var k = 0; k < imgs.length && logoCount < MAX_SOURCE_LOGOS; k++) {
      var im = imgs[k];
      var src = (im.getAttribute('src') || '').trim();
      var alt = (im.getAttribute('alt') || '').toLowerCase();
      if (!src) continue;
      if ((src + ' ' + alt).toLowerCase().indexOf('logo') === -1) continue;

      var gAbs = toAbs(src);
      if (!gAbs.abs) continue;
      if (/^data:/i.test(gAbs.abs) && gAbs.abs.length < 64) continue;

      logoCount++;
      pushPage({
        url: gAbs.abs, raw: src, resolvable: gAbs.ok,
        kind: '<img> logo', sizes: '', type: '', color: '', purpose: '',
        note: '页面内 logo 图，可能是含文字的组合标，缩到 16px 未必可辨认'
      });
    }

    /* ---- 统计 ---- */
    var unresolved = 0;
    var buckets = [out.icons, out.pageImages];
    if (out.manifest) buckets.push([out.manifest]);
    for (var b = 0; b < buckets.length; b++) {
      for (var n = 0; n < buckets[b].length; n++) {
        if (!buckets[b][n].resolvable) unresolved++;
      }
    }

    out.counts.icons = out.icons.length;
    out.counts.manifest = out.manifest ? 1 : 0;
    out.counts.pageImages = out.pageImages.length;
    out.counts.unresolved = unresolved;

    return out;
  }

  global.IconParse = {
    PRIORITY: PRIORITY,
    MAX_DECLARED: MAX_DECLARED,
    MAX_PAGE_IMAGES: MAX_PAGE_IMAGES,
    MAX_INLINE_LOGO: MAX_INLINE_LOGO,
    MAX_SOURCE_CHARS: MAX_SOURCE_CHARS,
    MAX_SOURCE_ICONS: MAX_SOURCE_ICONS,
    MAX_SOURCE_IMAGES: MAX_SOURCE_IMAGES,
    MAX_SOURCE_LOGOS: MAX_SOURCE_LOGOS,
    parseSizes: parseSizes,
    isEmptyDataUri: isEmptyDataUri,
    trimHtmlToHead: trimHtmlToHead,
    parseHtml: parseHtml,
    parsePageImages: parsePageImages,
    parseManifest: parseManifest,
    parseBrowserConfig: parseBrowserConfig,
    parseJson: parseJson,
    looksLikeHtml: looksLikeHtml,
    looksLikeUrl: looksLikeUrl,
    parseSource: parseSource
  };
})(window);
