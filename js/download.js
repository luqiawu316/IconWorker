/* ==========================================================================
   download.js —— 图标下载（两个功能共用）
   暴露：window.IconDownload
     · IconDownload.save(url, {ext})            → Promise<'downloaded'>，失败时 reject
     · IconDownload.errorText(err)              → 给用户看的一句话（两个功能共用同一套文案）
     · IconDownload.embeddedHint()              → 处于 iframe 内嵌预览时的补充提示，否则空串
     · IconDownload.extFromMime / extFromUrl

   下载策略（三级，越靠后越可靠）：
     1. data: 内联图标        —— 本机解码，不联网；
     2. 同源 / 已开放 CORS     —— 直接 fetch 取字节，最快，不经过服务器；
     3. 其余（多数跨域图标）   —— 走同源代理 /api/icon，由服务端代取并以附件返回。
        这一级是 Cloudflare Pages Function（functions/api/icon.js），部署后生效。

   为什么不直接给 <a href="图标地址" download> 点击：
     跨域地址上的 download 属性会被浏览器忽略，点击会变成「跳转到图标页面」
     而不是下载。所以字节必须由 JS 拿到（直连或经代理），再以 Blob 触发保存。

   失败一律如实报错，不打开新标签页、不假装已下载。
   err.code: 'cors-blocked'（直连被跨域拦且代理不可用，另带 err.proxyMissing）
             'proxy-failed'（代理可取，但源站失败，err.proxyMessage 为原因）
             err.httpStatus：直连时的 HTTP 状态码
   ========================================================================== */
(function (global, document) {
  'use strict';

  var PROXY_PATH = '/api/icon';     // Cloudflare Pages Function 的路径
  var PROXY_HEADER = 'x-icon-proxy'; // 用于确认响应确实来自本站代理
  var DIRECT_TIMEOUT = 6000;         // 直连超时（毫秒）：跨域拦截是瞬时失败，这里只防死站点；超时即转投代理
  var PROXY_TIMEOUT = 20000;         // 代理超时（服务端自己还有 8s 上游超时，重定向回退时会更久）

  var EXT_ALIAS = { jpeg: 'jpg' };
  var KNOWN_EXT = /^(png|ico|svg|jpe?g|gif|webp|bmp|avif)$/i;
  var DOWNLOADABLE_EXT = /^(png|ico|svg|jpg|gif|webp|bmp|avif)$/;

  function normExt(ext) {
    var e = String(ext || '').toLowerCase();
    return EXT_ALIAS[e] || e;
  }

  /** 由 MIME 推断扩展名，例如 image/x-icon → ico */
  function extFromMime(mime) {
    var m = /^image\/([a-z0-9.+-]+)/i.exec(String(mime || ''));
    if (!m) return '';
    var sub = m[1].toLowerCase();
    if (sub === 'x-icon' || sub === 'vnd.microsoft.icon') return 'ico';
    if (sub === 'svg+xml') return 'svg';
    return normExt(sub.replace(/\+.*$/, ''));
  }

  /** 由地址的路径扩展名推断，例如 /icon.png?v=2 → png */
  function extFromUrl(url) {
    var m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(String(url || ''));
    if (!m || !KNOWN_EXT.test(m[1])) return '';
    return normExt(m[1]);
  }

  function safePart(s, fallback) {
    var out = String(s || '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
    return out || fallback;
  }

  /** 生成文件名：<站点>-<原文件名>.<ext>；内联图标记为 inline */
  function buildName(url, ext) {
    var host = 'icon';
    var base = 'icon';
    if (/^data:/i.test(url)) {
      host = 'inline';
    } else {
      try {
        var u = new URL(url);
        host = u.hostname;
        var seg = u.pathname.split('/').filter(Boolean).pop();
        if (seg) base = decodeURIComponent(seg).replace(/\.[a-z0-9]+$/i, '');
      } catch (e) {
        /* 地址无法解析时使用默认名 */
      }
    }
    return safePart(host, 'icon') + '-' + safePart(base, 'icon') + '.' + (normExt(ext) || 'png');
  }

  /* ---------- 超时：旧浏览器没有 AbortSignal.timeout 时退化为无信号（不影响功能） ---------- */

  function timeoutSignal(ms) {
    try {
      return (global.AbortSignal && global.AbortSignal.timeout) ? global.AbortSignal.timeout(ms) : undefined;
    } catch (e) {
      return undefined;
    }
  }

  /* ---------- data: 内联图标：本机解码，不联网 ---------- */

  var B64_OK = /^[A-Za-z0-9+/=\s]*$/;

  function dataUrlToBlob(url) {
    var comma = url.indexOf(',');
    if (comma < 0) throw new Error('bad data url');
    var head = url.slice(5, comma);          // 去掉开头的 'data:'
    var body = url.slice(comma + 1);
    var isB64 = /;base64/i.test(head);
    var mime = (/^([^;,]+)/.exec(head) || [])[1] || 'application/octet-stream';

    if (!isB64) {
      // 百分号编码的文本（SVG 常见）：解码后交给 Blob，构造函数会按 UTF-8 编码
      return new Blob([decodeURIComponent(body)], { type: mime });
    }

    var clean = body.replace(/\s+/g, '');
    if (!B64_OK.test(clean)) throw new Error('bad base64');
    var bin = global.atob(clean);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  /* ---------- 取字节：直连 / 代理 ---------- */

  function fetchBytes(url, opts) {
    return global.fetch(url, opts).then(function (res) {
      if (!res.ok) {
        var err = new Error('HTTP ' + res.status);
        err.httpStatus = res.status;
        throw err;
      }
      return res.blob();
    });
  }

  function directFetch(url) {
    return fetchBytes(url, {
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: timeoutSignal(DIRECT_TIMEOUT)
    });
  }

  /**
   * 同源代理：拿不到字节的跨域图标由它代取，并区分「代理不存在」与「代理明确报错」。
   * 部署平台没有 Functions 时，/api/icon 会落到静态 404 或 SPA 兜底页面，
   * 用自定义响应头 x-icon-proxy 才能确认回应者是不是本站代理。
   */
  function proxyFetchChecked(url) {
    var endpoint = PROXY_PATH + '?url=' + encodeURIComponent(url);
    return global.fetch(endpoint, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: timeoutSignal(PROXY_TIMEOUT)
    }).then(function (res) {
      if (res.headers.get(PROXY_HEADER) !== '1') {
        var missing = new Error('no proxy');
        missing.proxyMissing = true;
        throw missing;
      }
      if (!res.ok) {
        return res.text().then(function (t) {
          var e = new Error('proxy failed');
          e.code = 'proxy-failed';
          e.proxyStatus = res.status;
          e.proxyMessage = String(t || '').replace(/\s+/g, ' ').trim().slice(0, 120);
          throw e;
        });
      }
      return res.blob();
    }, function () {
      var missing = new Error('no proxy');
      missing.proxyMissing = true;
      throw missing;
    });
  }

  /* ---------- 触发保存 ---------- */

  function triggerDownload(blobUrl, name) {
    var a = document.createElement('a');
    a.href = blobUrl;
    a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);   // 部分浏览器要求元素在文档中才会触发
    a.click();
    document.body.removeChild(a);
    // 撤销太早会让大文件写到一半失败，留足时间再回收
    setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 30000);
  }

  /* ---------- 内嵌预览提示 ---------- */

  /** 是否运行在 iframe 里（工作台内嵌预览、被其他站点嵌入） */
  function isEmbedded() {
    try {
      return global.self !== global.top;
    } catch (e) {
      return true;  // 跨域读 top 抛错，说明确实在 iframe 内
    }
  }

  /** 内嵌场景下的补充提示：沙箱 iframe 若没开 allow-downloads，下载会被浏览器静默拦掉 */
  function embeddedHint() {
    return isEmbedded() ? '（若未开始下载，说明当前是嵌入预览，浏览器沙箱会拦截下载，请在新标签页打开本页重试）' : '';
  }

  /* ---------- 用户可读的失败原因（两个功能共用，避免文案漂移） ---------- */

  function errorText(err) {
    if (err && err.code === 'proxy-failed') {
      return '下载失败：' + (err.proxyMessage || ('服务器返回 HTTP ' + err.proxyStatus));
    }
    if (err && err.httpStatus) {
      return '下载失败：站点返回 HTTP ' + err.httpStatus;
    }
    if (err && err.code === 'cors-blocked') {
      return '下载失败：该站点未开放跨域，无法直接保存；本站的下载代理也不可用。' +
             '请复制地址后在浏览器中打开另存，或把本站部署到支持 Functions 的平台';
    }
    return '下载失败，请稍后重试';
  }

  /**
   * 保存一个图标。
   * @param {string} url 图标地址（已补全为绝对地址，或 data:）
   * @param {{ext?: string}} [opts] 扩展名（如 png / ico / svg）；缺省时由 MIME 或地址推断
   * @returns {Promise<'downloaded'>} 已触发保存；失败时以 Error 拒绝（见文件头 err.code）
   */
  function save(url, opts) {
    opts = opts || {};
    if (!url) return Promise.reject(new Error('empty url'));

    // 调用方传入的扩展名只接受真正的图片格式，避免 IMG / DATA 之类的占位词变成文件后缀
    var hint = normExt(opts.ext);
    if (!DOWNLOADABLE_EXT.test(hint)) hint = '';

    function finish(blob) {
      var ext = hint || extFromMime(blob.type) || extFromUrl(url) || 'png';
      triggerDownload(URL.createObjectURL(blob), buildName(url, ext));
      return 'downloaded';
    }

    // 内联图标：本机解码，任何环境下都能下载
    if (/^data:/i.test(url)) {
      return Promise.resolve().then(function () { return finish(dataUrlToBlob(url)); });
    }

    // 第一级：直连（同源、或站点已开放 CORS）
    return directFetch(url).then(finish, function (directErr) {
      // 第二级：同源代理
      return proxyFetchChecked(url).then(finish, function (proxyErr) {
        if (proxyErr && proxyErr.code === 'proxy-failed') throw proxyErr;
        // 代理不可用：把直连的错误如实带给用户
        if (directErr && directErr.httpStatus) {
          directErr.proxyMissing = true;
          throw directErr;
        }
        var e = new Error('cors-blocked');
        e.code = 'cors-blocked';
        e.proxyMissing = !!(proxyErr && proxyErr.proxyMissing);
        throw e;
      });
    });
  }

  /* ---------- 对外接口 ---------- */

  global.IconDownload = {
    save: save,
    errorText: errorText,
    embeddedHint: embeddedHint,
    isEmbedded: isEmbedded,
    extFromMime: extFromMime,
    extFromUrl: extFromUrl
  };
})(window, document);
