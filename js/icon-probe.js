/* ==========================================================================
   icon-probe.js —— 探测层（对应文档 §1「纯前端能力边界」）
   暴露：window.IconProbe

   能力分层（实测结论，见文档 §1.1）：
     <img>  no-cors      可加载 15/19，但读不到状态码 / 字节 / 像素
     fetch  mode:cors    可读 5/19，能拿真实状态码 + 字节（魔数嗅探）+ 像素
     fetch  mode:no-cors opaque 响应，仅能判断网络可达性
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------- 格式识别（魔数嗅探，见文档 §3.3 陷阱 1） ---------- */

  var KIND_LABEL = {
    png: 'PNG', ico: 'ICO', svg: 'SVG', gif: 'GIF', jpeg: 'JPEG',
    webp: 'WebP', bmp: 'BMP', html: 'HTML', json: 'JSON', xml: 'XML',
    text: '文本', empty: '空内容', unknown: '未知格式'
  };

  // 可作图标的格式
  var IMAGE_KINDS = { png: 1, ico: 1, svg: 1, gif: 1, jpeg: 1, webp: 1, bmp: 1 };

  // 魔数 → 构造 Blob 时用的 MIME（不信任服务端 Content-Type）
  var KIND_MIME = {
    png: 'image/png', ico: 'image/x-icon', svg: 'image/svg+xml',
    gif: 'image/gif', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp'
  };

  function bytesToStr(bytes, start, len) {
    var end = Math.min(start + len, bytes.length);
    var s = '';
    for (var i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  /**
   * 用首字节特征判断真实格式。扩展名与 Content-Type 都不可信。
   * @param {Uint8Array} bytes
   * @returns {string} 'png' | 'ico' | 'svg' | ... | 'unknown'
   */
  function sniffKind(bytes) {
    if (!bytes || !bytes.length) return 'empty';

    if (bytes.length >= 8 &&
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';

    if (bytes.length >= 6) {
      var h6 = bytesToStr(bytes, 0, 6);
      if (h6 === 'GIF87a' || h6 === 'GIF89a') return 'gif';
    }

    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpeg';

    if (bytes.length >= 4 &&
        bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) return 'ico';

    if (bytes.length >= 12 &&
        bytesToStr(bytes, 0, 4) === 'RIFF' && bytesToStr(bytes, 8, 4) === 'WEBP') return 'webp';

    if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4D) return 'bmp';

    // 文本类：去掉 BOM 与空白后再判断
    var text = '';
    for (var i = 0; i < Math.min(bytes.length, 1024); i++) text += String.fromCharCode(bytes[i]);
    text = text.replace(/^\uFEFF/, '').replace(/^[\s\u0000]+/, '');
    var lower = text.toLowerCase();

    if (!lower) return 'empty';

    var head = lower.slice(0, 512);

    // HTML 优先判定：错误页 / SPA 兜底最常以 HTML 形式出现
    if (head.indexOf('<!doctype html') !== -1 ||
        head.indexOf('<html') !== -1 ||
        head.indexOf('<head') !== -1) return 'html';

    // browserconfig.xml 必须在 <svg> 之前判定（它也以 <?xml 开头）
    if (lower.indexOf('<browserconfig') !== -1) return 'xml';

    if (lower.indexOf('<svg') !== -1) return 'svg';

    if (lower.charAt(0) === '{' || lower.charAt(0) === '[') return 'json';

    if (lower.charAt(0) === '<') return 'xml';

    return 'unknown';
  }

  function isImageKind(kind) {
    return !!IMAGE_KINDS[kind];
  }

  /* ---------- ICO 容器结构（见文档 §3.3 陷阱 2：.ico 内含多张图） ---------- */

  /**
   * 解析 ICO 目录，列出容器内实际包含的尺寸。
   * @param {Uint8Array} bytes
   * @returns {Array<{width:number,height:number,bpp:number,bytes:number}>|null}
   */
  function parseIcoSizes(bytes) {
    if (!bytes || bytes.length < 6) return null;
    if (!(bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0)) return null;

    var count = bytes[4] | (bytes[5] << 8);
    if (!count || count > 64) return null;

    var out = [];
    for (var i = 0; i < count; i++) {
      var off = 6 + i * 16;
      if (off + 16 > bytes.length) break;
      out.push({
        width: bytes[off] === 0 ? 256 : bytes[off],
        height: bytes[off + 1] === 0 ? 256 : bytes[off + 1],
        bpp: bytes[off + 6] | (bytes[off + 7] << 8),
        bytes: (bytes[off + 8] | (bytes[off + 9] << 8) | (bytes[off + 10] << 16) | (bytes[off + 11] << 24)) >>> 0
      });
    }
    return out.length ? out : null;
  }

  /* ---------- 手段一：<img> 探测（不受 CORS 限制，主力手段） ---------- */

  /**
   * 用 new Image() 以 no-cors 方式探测图片能否加载。
   * 关键：**绝不设置 crossOrigin**——设了就会要求目标站返回 CORS 头，导致大面积失败。
   *
   * @param {string} url
   * @param {number} timeoutMs
   * @returns {Promise<{ok:boolean, width?:number, height?:number, el?:HTMLImageElement, reason?:string}>}
   */
  function probeImage(url, timeoutMs) {
    return new Promise(function (resolve) {
      var img = new Image();
      var settled = false;

      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        img.onload = null;
        img.onerror = null;
        try { img.src = ''; } catch (e) { /* 忽略 */ }
        resolve({ ok: false, reason: 'timeout' });
      }, timeoutMs);

      img.onload = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ok: true,
          width: img.naturalWidth || 0,
          height: img.naturalHeight || 0,
          el: img
        });
      };

      img.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, reason: 'notfound' });
      };

      // 部分站点按 Referer 防盗链，去掉 referer 提高成功率
      try { img.referrerPolicy = 'no-referrer'; } catch (e) { /* 旧浏览器忽略 */ }
      try { img.decoding = 'async'; } catch (e) { /* 旧浏览器忽略 */ }

      img.src = url;
    });
  }

  /* ---------- 手段二：CORS fetch 验真（有 ACAO 时才能用） ---------- */

  /**
   * 只读取响应体前若干字节，读够就 cancel，避免把整个大页面拉下来。
   * 这是「解析网页源码」路径保持流畅的关键：实测大多数页面的 <head> 在前 100 KB 内，
   * 而整页可能有数 MB。
   */
  function readHead(res, maxBytes) {
    if (!res.body || typeof res.body.getReader !== 'function') {
      return res.arrayBuffer().then(function (buf) {
        var u8 = new Uint8Array(buf);
        return u8.length > maxBytes ? u8.subarray(0, maxBytes) : u8;
      }).catch(function () { return new Uint8Array(0); });
    }

    var reader = res.body.getReader();
    var chunks = [];
    var total = 0;

    function finish() {
      var size = Math.min(total, maxBytes);
      var out = new Uint8Array(size);
      var off = 0;
      for (var i = 0; i < chunks.length && off < size; i++) {
        var take = Math.min(chunks[i].length, size - off);
        out.set(chunks[i].subarray(0, take), off);
        off += take;
      }
      return out;
    }

    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return finish();
        chunks.push(r.value);
        total += r.value.length;
        if (total >= maxBytes) {
          try { reader.cancel(); } catch (e) { /* 忽略 */ }
          return finish();
        }
        return pump();
      }).catch(function () { return finish(); });
    }

    return pump();
  }

  /**
   * 用 CORS 模式读取图标资源，拿到**真实 HTTP 状态码**与**响应字节**。
   * 目标站未返回 Access-Control-Allow-Origin 时必然失败——这是常态，不是错误。
   *
   * @param {string} url
   * @param {number} timeoutMs
   * @param {number} [maxBytes=65536]
   * @returns {Promise<object>} {ok, status, kind, bytes, contentLength, contentType, icoSizes}
   */
  function verifyCors(url, timeoutMs, maxBytes) {
    var limit = maxBytes || 65536;

    return new Promise(function (resolve) {
      if (/^data:/i.test(url || '')) {
        resolve({ ok: false, reason: 'data-uri' });
        return;
      }

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
        var headerLen = Number(res.headers.get('content-length') || 0);
        return readHead(res, limit).then(function (bytes) {
          var kind = sniffKind(bytes);
          done({
            ok: true,
            status: res.status,
            finalUrl: res.url || url,
            contentType: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
            contentLength: headerLen || bytes.length,
            bytes: bytes,
            kind: kind,
            isImage: isImageKind(kind),
            icoSizes: kind === 'ico' ? parseIcoSizes(bytes) : null
          });
        });
      }).catch(function () {
        // 未返回 ACAO / 网络失败 / 被 abort，三者浏览器不区分
        done({ ok: false, reason: 'cors-blocked' });
      });
    });
  }

  /* ---------- 头条读取：只取页面前若干字节，用于解析声明 ---------- */

  /**
   * 按响应头 charset → <meta charset> → utf-8 的顺序解码字节。
   * 中文站点大量使用 GBK/GB2312，直接用 UTF-8 解码会把标签解析成乱码。
   *
   * @param {Uint8Array} bytes
   * @param {string} [charsetHint]
   * @returns {string}
   */
  function decodeBytes(bytes, charsetHint) {
    if (!bytes || !bytes.length) return '';

    var charset = (charsetHint || '').toLowerCase().trim();

    // 从头 2 KB 里嗅探 <meta charset=...>
    if (!charset) {
      var head = '';
      var probeLen = Math.min(bytes.length, 2048);
      for (var i = 0; i < probeLen; i++) head += String.fromCharCode(bytes[i]);
      var m = /<meta[^>]+charset\s*=\s*["']?([a-z0-9_\-]+)/i.exec(head);
      if (m) charset = m[1].toLowerCase();
    }
    if (!charset) charset = 'utf-8';

    if (typeof global.TextDecoder === 'function') {
      try {
        return new global.TextDecoder(charset).decode(bytes);
      } catch (e) {
        try { return new global.TextDecoder('utf-8').decode(bytes); } catch (e2) { /* 落到下方兜底 */ }
      }
    }

    // 最后兜底：按单字节逐字转换（对 ASCII 标签结构仍然可用）
    var s = '';
    for (var k = 0; k < bytes.length; k++) s += String.fromCharCode(bytes[k]);
    return s;
  }

  /** 从 Content-Type 响应头里取 charset */
  function charsetFromContentType(ct) {
    var m = /charset\s*=\s*["']?([a-z0-9_\-]+)/i.exec(ct || '');
    return m ? m[1].toLowerCase() : '';
  }

  /**
   * 流式读取页面前 maxBytes 字节并解码为文本。
   * 读够上限就取消剩余下载——这是「解析网页源码」路径在大页面下保持流畅的核心。
   *
   * @param {string} url
   * @param {number} timeoutMs
   * @param {number} [maxBytes=524288]
   * @returns {Promise<object>} {ok, status, httpOk, finalUrl, text, bytesRead, totalBytes, truncated}
   */
  function fetchHeadBytes(url, timeoutMs, maxBytes) {
    var limit = maxBytes || 524288;

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
        var ct = res.headers.get('content-type') || '';
        var headerLen = Number(res.headers.get('content-length') || 0);

        return readHead(res, limit).then(function (bytes) {
          done({
            ok: true,
            httpOk: !!res.ok,
            status: res.status,
            finalUrl: res.url || url,
            contentType: ct.split(';')[0].trim().toLowerCase(),
            bytesRead: bytes.length,
            totalBytes: headerLen || 0,
            truncated: bytes.length >= limit || (headerLen > 0 && headerLen > bytes.length),
            text: decodeBytes(bytes, charsetFromContentType(ct))
          });
        });
      }).catch(function () {
        done({ ok: false, reason: 'cors-blocked' });
      });
    });
  }

  /* ---------- 像素检测：仅当已通过 CORS 拿到字节时可用 ---------- */

  /** 像素采样上限：大图标先缩到 ≤128px 再统计，避免为了一个比例遍历上百万像素 */
  var PIXEL_SAMPLE_LIMIT = 128;

  /**
   * 用已读取的字节构造 Blob 再解码到 canvas 取像素。
   * 走 Blob 而非目标 URL，是因为 Blob URL 属同源，画布不会被污染；
   * 同时也避免了第二次网络请求。
   *
   * @param {Uint8Array} bytes
   * @param {string} kind 嗅探出的格式
   * @returns {Promise<{ok:boolean, opaqueRatio?:number, width?:number, height?:number, reason?:string}>}
   */
  function measurePixels(bytes, kind) {
    return new Promise(function (resolve) {
      if (!bytes || !bytes.length) { resolve({ ok: false, reason: 'no-bytes' }); return; }
      if (!isImageKind(kind)) { resolve({ ok: false, reason: 'not-image' }); return; }
      if (typeof global.Blob === 'undefined' || typeof global.URL === 'undefined' ||
          typeof global.URL.createObjectURL !== 'function') {
        resolve({ ok: false, reason: 'unsupported' });
        return;
      }

      var blob;
      try {
        blob = new Blob([bytes], { type: KIND_MIME[kind] || 'application/octet-stream' });
      } catch (e) {
        resolve({ ok: false, reason: 'blob-failed' });
        return;
      }

      var objUrl = global.URL.createObjectURL(blob);
      var img = new Image();
      var settled = false;

      function cleanup() {
        try { global.URL.revokeObjectURL(objUrl); } catch (e) { /* 忽略 */ }
      }

      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ ok: false, reason: 'timeout' });
      }, 5000);

      img.onload = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        var result = { ok: false, reason: 'canvas-failed' };
        try {
          var nw = img.naturalWidth || 0;
          var nh = img.naturalHeight || 0;
          var scale = Math.min(1, PIXEL_SAMPLE_LIMIT / Math.max(nw || 1, nh || 1));
          var sw = Math.max(1, Math.round(nw * scale));
          var sh = Math.max(1, Math.round(nh * scale));

          var cv = document.createElement('canvas');
          cv.width = sw;
          cv.height = sh;
          var ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0, sw, sh);
          var data = ctx.getImageData(0, 0, sw, sh).data;
          var opaque = 0;
          var totalPixels = data.length / 4;
          for (var k = 3; k < data.length; k += 4) {
            if (data[k] > 0) opaque++;
          }
          result = {
            ok: true,
            opaqueRatio: totalPixels ? opaque / totalPixels : 0,
            width: nw,
            height: nh
          };
        } catch (e) {
          result = { ok: false, reason: 'tainted' };
        }

        cleanup();
        resolve(result);
      };

      img.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve({ ok: false, reason: 'decode-failed' });
      };

      img.src = objUrl;
    });
  }

  /* ---------- 手段三：可达性探测（no-cors，区分「不可达」与「可达但无图标」） ---------- */

  /**
   * 以 no-cors 方式请求站点根地址。
   *   resolve（opaque 响应） => 站点网络层可达
   *   reject                 => 域名无法解析 / 网络不可达 / 被策略拦截
   *
   * @param {string} origin
   * @param {number} timeoutMs
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  function probeReachable(origin, timeoutMs) {
    function attempt() {
      return new Promise(function (resolve) {
        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var settled = false;

        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          if (controller) { try { controller.abort(); } catch (e) { /* 忽略 */ } }
          resolve({ ok: false, reason: 'timeout' });
        }, timeoutMs);

        var opts = {
          method: 'GET',
          mode: 'no-cors',
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'follow'
        };
        if (controller) opts.signal = controller.signal;

        fetch(origin, opts).then(function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ ok: true });
        }).catch(function () {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ ok: false, reason: 'unreachable' });
        });
      });
    }

    // 快速失败时重试一次，避免瞬时网络抖动造成误判
    return attempt().then(function (r) {
      if (r.ok) return r;
      return new Promise(function (resolve) { setTimeout(resolve, 350); })
        .then(attempt)
        .then(function (r2) { return r2.ok ? r2 : r; });
    });
  }

  global.IconProbe = {
    KIND_LABEL: KIND_LABEL,
    IMAGE_KINDS: IMAGE_KINDS,
    PIXEL_SAMPLE_LIMIT: PIXEL_SAMPLE_LIMIT,
    sniffKind: sniffKind,
    isImageKind: isImageKind,
    parseIcoSizes: parseIcoSizes,
    decodeBytes: decodeBytes,
    probeImage: probeImage,
    verifyCors: verifyCors,
    fetchHeadBytes: fetchHeadBytes,
    measurePixels: measurePixels,
    probeReachable: probeReachable
  };
})(window);
