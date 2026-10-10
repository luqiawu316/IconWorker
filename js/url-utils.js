/* ==========================================================================
   url-utils.js —— 输入归一化与校验
   暴露：window.IconUrl
   ========================================================================== */
(function (global) {
  'use strict';

  var IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
  var HAS_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.\-]*:/;

  /**
   * 把用户输入（域名 / 带协议 URL / 带路径 URL）归一化为一个 URL 对象。
   * 保守假设：缺少协议时按 https 处理；不允许空格；域名须含点或为 localhost / IPv4。
   *
   * @param {string} raw 用户原始输入
   * @returns {{ok:true, url:URL, origin:string} | {ok:false, error:string}}
   */
  function normalizeInput(raw) {
    var input = String(raw === null || raw === undefined ? '' : raw).trim();

    if (!input) {
      return { ok: false, error: '请输入网站地址或域名，例如 example.com' };
    }

    // 用户在中文输入法下容易带出全角空格，一并视为非法
    if (/\s/.test(input) || input.indexOf('\u3000') !== -1) {
      return { ok: false, error: '地址中不能包含空格，请检查后重试' };
    }

    var value = input;

    if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(value)) {
      if (value.indexOf('//') === 0) {
        // 形如 //example.com
        value = 'https:' + value;
      } else if (HAS_SCHEME_RE.test(value)) {
        // 有协议但没跟 //（例如 http:example.com、mailto:x@y.com）
        return {
          ok: false,
          error: '地址格式不正确，请使用 http:// 或 https:// 开头的完整地址'
        };
      } else if (value.charAt(0) === '/') {
        return { ok: false, error: '请输入完整域名，例如 example.com' };
      } else {
        value = 'https://' + value;
      }
    }

    var url;
    try {
      url = new URL(value);
    } catch (e) {
      return { ok: false, error: '无法解析该地址，请检查拼写是否正确' };
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, error: '仅支持 http:// 与 https:// 协议' };
    }

    if (!url.hostname) {
      return { ok: false, error: '地址缺少域名，请检查后重试' };
    }

    var host = url.hostname;
    var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (!isLocal && !IPV4_RE.test(host) && host.indexOf('.') === -1) {
      return { ok: false, error: '域名格式不正确，请包含后缀，例如 example.com' };
    }

    if (IPV4_RE.test(host)) {
      var parts = host.split('.');
      for (var i = 0; i < parts.length; i++) {
        if (Number(parts[i]) > 255) {
          return { ok: false, error: 'IP 地址格式不正确，请检查后重试' };
        }
      }
    }

    return { ok: true, url: url, origin: url.origin };
  }

  /**
   * 显示用短化：过长 URL 保留头尾，中间省略。
   * @param {string} url
   * @param {number} [max] 最大字符数
   * @returns {string}
   */
  function shortenUrl(url, max) {
    var limit = max || 58;
    var s = String(url || '');
    if (s.length <= limit) return s;
    var head = s.slice(0, Math.ceil((limit - 1) * 0.62));
    var tail = s.slice(-(limit - 1 - head.length));
    return head + '…' + tail;
  }

  global.IconUrl = {
    normalizeInput: normalizeInput,
    shortenUrl: shortenUrl
  };
})(window);
