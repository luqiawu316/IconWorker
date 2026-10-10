/* ==========================================================================
   source-tool.js —— 独立功能：网页源码解析
   暴露：window.IconSourceTool
   依赖：window.IconParse（纯文本解析）、window.IconUrl（页面地址归一化）

   与「自动探测网站」功能完全分离：
     · 本模块不调用 fetch / XMLHttpRequest / IconFinder，不去「寻找」图标地址——
       图标地址全部来自用户提供的源码，本模块只做解析与展示；
     · 唯一的网络活动是把解析出的地址渲染成 <img> 预览图（与浏览器加载网页图标同理，只求能显示）；
     · 自动探测的界面与流程在 app.js + favicon-finder.js，二者不互相调用、不共享状态。

   界面归属：本模块负责顶部两个标签页的切换（薄导航），
             但只切换 pane 的显示状态，不介入另一端的内容渲染。
   ========================================================================== */
(function (global, document) {
  'use strict';

  var Parse = global.IconParse;

  /* ---------- DOM ---------- */
  var el = {
    tabAuto:    document.getElementById('tabAuto'),
    tabSource:  document.getElementById('tabSource'),
    paneAuto:   document.getElementById('paneAuto'),
    paneSource: document.getElementById('paneSource'),

    baseInput:  document.getElementById('srcBaseInput'),
    baseHint:   document.getElementById('srcBaseHint'),
    baseError:  document.getElementById('srcBaseError'),
    input:      document.getElementById('srcInput'),
    parseBtn:   document.getElementById('srcParseBtn'),
    sampleBtn:  document.getElementById('srcSampleBtn'),
    clearBtn:   document.getElementById('srcClearBtn'),
    sizeMeta:   document.getElementById('srcSizeMeta'),
    errorBox:   document.getElementById('srcError'),

    resultPanel:   document.getElementById('srcResultPanel'),
    resultBadge:   document.getElementById('srcResultBadge'),
    resultSummary: document.getElementById('srcResultSummary'),
    resultKv:      document.getElementById('srcResultKv'),
    groups:        document.getElementById('srcGroups'),
    actions:       document.getElementById('srcActions'),
    copyAllBtn:    document.getElementById('srcCopyAllBtn'),

    sampleSrc:  document.getElementById('srcSampleSource'),
    toast:      document.getElementById('toast')
  };

  var KIND_TAG = {
    'icon':                     'rel=icon',
    'shortcut icon':            'rel=shortcut icon',
    'apple-touch-icon':         'apple-touch-icon',
    'mask-icon':                'mask-icon',
    'msapplication-TileImage':  'ms-TileImage',
    'manifest':                 'rel=manifest',
    'image_src':                'rel=image_src',
    'og:image':                 'og:image',
    'twitter:image':            'twitter:image',
    'og:logo':                  'og:logo',
    '<img> logo':               '<img> logo'
  };

  var toastTimer = null;
  var copyList = [];          // 「复制全部图标地址」的内容

  /* ---------- 小工具 ---------- */

  function showError(message) {
    el.errorBox.textContent = message;
    el.errorBox.hidden = false;
  }

  function clearError() {
    el.errorBox.textContent = '';
    el.errorBox.hidden = true;
  }

  function showToast(message, holdMs) {
    if (!el.toast) return;
    el.toast.textContent = message;
    el.toast.hidden = false;
    void el.toast.offsetWidth;
    el.toast.classList.add('is-visible');

    if (toastTimer) clearTimeout(toastTimer);
    // holdMs 传 0 表示常驻，直到下一条消息把它替换掉（用于「正在下载…」这类不能提前消失的提示）
    var delay = (typeof holdMs === 'number') ? holdMs : 1800;
    if (delay > 0) {
      toastTimer = setTimeout(function () {
        el.toast.classList.remove('is-visible');
        setTimeout(function () { el.toast.hidden = true; }, 220);
      }, delay);
    } else {
      toastTimer = null;
    }
  }

  function copyText(text) {
    if (global.navigator && global.navigator.clipboard && global.isSecureContext) {
      return global.navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('execCommand copy failed'));
      } catch (e) {
        reject(e);
      }
    });
  }

  /** 地址的格式缩写，用于代替无法离线渲染的预览图 */
  function extOf(item) {
    if (item.kind === 'manifest') return 'JSON';

    var u = item.url || '';
    if (/^data:/i.test(u)) {
      var dm = /^data:([^;,]+)/i.exec(u);
      if (dm) {
        var sub = String(dm[1]).split('/')[1] || 'data';
        return sub.replace(/\+.*$/, '').toUpperCase().slice(0, 4);
      }
      return 'DATA';
    }
    var m = /\.([a-z0-9]{2,6})(?:[?#]|$)/i.exec(item.raw || u);
    return m ? m[1].toUpperCase() : 'IMG';
  }

  /* ---------- 页面地址（必填）校验 ---------- */

  /** 校验并归一化页面地址；返回 {ok:true, href} / {ok:false, error, empty} */
  function checkBase(silent) {
    var raw = el.baseInput.value;
    if (!raw || !raw.replace(/\s/g, '')) {
      return { ok: false, error: '', empty: true };
    }
    // 复用主搜索框的归一化规则（允许省略协议、拒绝空格、要求带后缀的域名）
    var parsed = global.IconUrl.normalizeInput(raw);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    if (!silent) el.baseInput.value = parsed.url.href;
    return { ok: true, href: parsed.url.href };
  }

  /**
   * 把校验结果画到输入框与提示上，返回校验结果。
   * @param {{requireFilled?:boolean}} [opts] requireFilled=true 时，留空也视为不合法并标红
   *        （用户点了「解析源码」之后才传，避免一进页面就报错）
   */
  function paintBaseState(opts) {
    var requireFilled = !!(opts && opts.requireFilled);
    var r = checkBase(true);
    var invalid = (!r.ok && !r.empty) || (r.empty && requireFilled);

    if (invalid) {
      el.baseInput.classList.add('is-invalid');
      el.baseInput.setAttribute('aria-invalid', 'true');
      el.baseHint.hidden = true;
      el.baseError.textContent = r.empty
        ? '必填项，请填写这份源码所在的页面地址'
        : r.error;
      el.baseError.hidden = false;
    } else {
      el.baseInput.classList.remove('is-invalid');
      el.baseInput.removeAttribute('aria-invalid');
      el.baseHint.hidden = false;
      el.baseError.textContent = '';
      el.baseError.hidden = true;
    }
    return r;
  }

  /* ---------- 标签页 ---------- */

  function activateTab(which) {
    var isAuto = which !== 'source';

    el.paneAuto.hidden = !isAuto;
    el.paneSource.hidden = isAuto;

    if (isAuto) {
      el.tabAuto.classList.add('is-active');
      el.tabSource.classList.remove('is-active');
    } else {
      el.tabSource.classList.add('is-active');
      el.tabAuto.classList.remove('is-active');
    }

    el.tabAuto.setAttribute('aria-selected', isAuto ? 'true' : 'false');
    el.tabSource.setAttribute('aria-selected', isAuto ? 'false' : 'true');
  }

  /* ---------- 渲染 ---------- */

  function addKv(label, value) {
    var row = document.createElement('div');
    row.className = 'kv__row';

    var dt = document.createElement('dt');
    dt.textContent = label;

    var dd = document.createElement('dd');
    dd.textContent = value;

    row.appendChild(dt);
    row.appendChild(dd);
    el.resultKv.appendChild(row);
  }

  function addTag(parent, text, extraClass) {
    var s = document.createElement('span');
    s.className = 'src-item__tag' + (extraClass ? ' ' + extraClass : '');
    s.textContent = text;
    parent.appendChild(s);
  }

  function baseTextOf(r) {
    if (r.baseSource === 'tag') {
      return '<base href="' + r.baseHref + '"> → ' + (r.baseResolved || '无法解析为绝对地址');
    }
    if (r.baseSource === 'user') {
      return '你填写的页面地址 → ' + r.baseResolved;
    }
    if (r.baseHref) {
      return '<base href="' + r.baseHref + '">（相对地址，未提供页面地址，无法补全）';
    }
    return '未提供 —— 相对路径无法补全';
  }

  function renderItem(item) {
    var li = document.createElement('li');
    li.className = 'src-item';

    var isData = /^data:/i.test(item.url || '');
    // Manifest 是图标清单文件而不是图片，给它做图片预览必然失败，不要误报成「加载失败」
    var canPreview = item.resolvable && item.kind !== 'manifest';
    var tagsRow = null;   // 由下面的标签行赋值；预览加载失败时往这里补一条标记

    // 预览框：凡是已补全的图片地址（含内联 data:）都直接把图标加载出来，
    // 加载失败（地址失效 / 防盗链 / 混合内容拦截）时退回显示格式缩写，并如实标出来。
    var pv = document.createElement('div');
    pv.className = 'src-item__preview';

    if (canPreview) {
      var im = document.createElement('img');
      im.alt = '';
      im.loading = 'lazy';
      // 与探测功能一致：不设 crossOrigin（只求能显示），并绕开按 Referer 防盗链的站点
      im.referrerPolicy = 'no-referrer';
      im.addEventListener('error', function () {
        pv.classList.add('src-item__preview--text');
        pv.textContent = extOf(item);
        pv.title = '预览加载失败：地址失效、站点防盗链，或被混合内容策略拦截';
        if (tagsRow) addTag(tagsRow, '预览加载失败', 'is-warn');
      });
      im.src = item.url;
      pv.appendChild(im);
    } else {
      pv.classList.add('src-item__preview--text');
      pv.textContent = extOf(item);
      pv.title = item.kind === 'manifest'
        ? 'Manifest 是图标清单文件，不是图片，无法直接预览'
        : '地址无法补全为可用地址，无法加载预览';
    }
    li.appendChild(pv);

    var body = document.createElement('div');
    body.className = 'src-item__body';

    var addr;
    if (isData) {
      addr = document.createElement('span');
      addr.className = 'src-item__url is-plain';
      addr.textContent = 'data:…（内联图标，' + item.url.length + ' 字符）';
      addr.title = item.url;
    } else if (item.resolvable) {
      addr = document.createElement('a');
      addr.className = 'src-item__url';
      addr.href = item.url;
      addr.target = '_blank';
      addr.rel = 'noopener noreferrer';
      addr.textContent = item.url;
      addr.title = item.url;
    } else {
      addr = document.createElement('span');
      addr.className = 'src-item__url is-plain is-relative';
      addr.textContent = item.raw;
      addr.title = item.raw;
    }
    body.appendChild(addr);

    var tags = document.createElement('div');
    tags.className = 'src-item__tags';
    addTag(tags, KIND_TAG[item.kind] || item.kind || '—');
    if (item.sizes) addTag(tags, item.sizes);
    if (item.type) addTag(tags, item.type.replace(/^image\//, ''));
    if (item.color) addTag(tags, item.color);
    if (item.purpose) addTag(tags, item.purpose);
    if (!isData && !item.resolvable) addTag(tags, '无法补全为可用地址', 'is-warn');
    if (!isData && item.raw && item.raw !== item.url) addTag(tags, '源码写作 ' + item.raw);
    body.appendChild(tags);
    tagsRow = tags;

    if (item.note) {
      var note = document.createElement('p');
      note.className = 'src-item__note';
      note.textContent = item.note;
      body.appendChild(note);
    }

    li.appendChild(body);

    if (!isData) {
      var actions = document.createElement('div');
      actions.className = 'src-item__actions';

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn--mini src-item__copy';
      btn.textContent = '复制';
      btn.addEventListener('click', function () {
        // 与「复制全部」保持一致：补全不了时也复制源码里的原样写法
        copyText(item.url).then(function () {
          showToast(item.resolvable ? '已复制图标地址' : '已复制源码中的相对路径写法');
        }, function () {
          showToast('复制失败，请手动选择文本复制');
        });
      });
      actions.appendChild(btn);

      // 只有补全为绝对地址的图标才能下载；相对路径无法获取
      if (item.resolvable) {
        var dl = document.createElement('button');
        dl.type = 'button';
        dl.className = 'btn btn--mini src-item__dl';
        dl.textContent = '下载';
        dl.setAttribute('aria-label', '下载图标 ' + item.url);
        dl.addEventListener('click', function () {
          dl.disabled = true;
          // 跨域图标要等浏览器直连失败后再由服务器代取，可能耗时数秒，先给个常驻提示
          showToast('正在下载…', 0);
          global.IconDownload.save(item.url, { ext: extOf(item).toLowerCase() }).then(function () {
            showToast('已开始下载' + global.IconDownload.embeddedHint());
          }, function (err) {
            // 失败原因与自动探测页共用同一套文案（download.js）
            showToast(global.IconDownload.errorText(err));
          }).then(function () {
            dl.disabled = false;
          });
        });
        actions.appendChild(dl);
      }

      li.appendChild(actions);
    }

    return li;
  }

  function appendGroup(title, hint, items) {
    var sec = document.createElement('div');
    sec.className = 'src-group';

    var head = document.createElement('div');
    head.className = 'src-group__head';

    var h = document.createElement('h3');
    h.className = 'src-group__title';
    h.textContent = title;

    var cnt = document.createElement('span');
    cnt.className = 'src-group__count';
    cnt.textContent = items.length + ' 个';

    head.appendChild(h);
    head.appendChild(cnt);
    sec.appendChild(head);

    if (hint) {
      var p = document.createElement('p');
      p.className = 'src-group__hint';
      p.textContent = hint;
      sec.appendChild(p);
    }

    var ul = document.createElement('ul');
    ul.className = 'src-list';
    for (var i = 0; i < items.length; i++) ul.appendChild(renderItem(items[i]));
    sec.appendChild(ul);

    el.groups.appendChild(sec);
  }

  function emptyState() {
    var p = document.createElement('p');
    p.className = 'src-tool__empty';
    p.textContent = '这份源码里没有找到任何图标相关声明（<link rel="icon">、apple-touch-icon、Manifest 等）。' +
      '请确认粘贴的是完整源码，尤其是 <head> 部分没有被截断。';
    return p;
  }

  function render(result) {
    el.groups.innerHTML = '';
    el.resultKv.innerHTML = '';
    el.actions.hidden = true;
    copyList = [];

    var c = result.counts;
    var hasAny = (c.icons + c.manifest + c.pageImages) > 0;

    el.resultBadge.className = 'badge ' + (hasAny ? 'badge--ok' : 'badge--no');
    el.resultBadge.textContent = hasAny ? '已解析' : '无声明';

    var sum = [];
    if (c.icons) sum.push('识别出 ' + c.icons + ' 个图标声明');
    if (c.manifest) sum.push('1 个 Manifest 地址');
    if (c.pageImages) sum.push(c.pageImages + ' 个页面图片');

    var tail = result.truncated ? '输入超过上限，已截断后解析。' : '';
    el.resultSummary.textContent = sum.length
      ? ('解析完成：' + sum.join('、') + '。' + tail)
      : ('解析完成，但这份源码里没有任何图标相关声明。' + tail);

    addKv('输入规模', result.inputChars.toLocaleString('zh-CN') + ' 字符' + (result.truncated ? '（已按上限截断）' : ''));
    addKv('页面标题', result.title || '未声明');
    addKv('声明字符集', result.charset || '未声明');
    addKv('相对路径基准', baseTextOf(result));
    if (result.suppressed) {
      addKv('抑制声明', '有 —— 源码中出现空负载的 data: 图标（href="data:,"），即主动声明不要图标');
    }
    if (c.unresolved) {
      addKv('未能补全', c.unresolved + ' 条地址无法补全为可用地址（预览用源码原样写法）');
    }

    if (c.icons) {
      appendGroup('图标声明', '可直接作为网站图标（favicon）使用', result.icons);
      for (var i = 0; i < result.icons.length; i++) {
        if (!/^data:/i.test(result.icons[i].url)) copyList.push(result.icons[i].url);
      }
    }
    if (c.manifest) {
      appendGroup('Web App Manifest 地址',
        '图标清单保存在 Manifest 文件内部，本功能不会去下载它', [result.manifest]);
    }
    if (c.pageImages) {
      appendGroup('页面图片（非图标）',
        '社交分享图、页面 logo 等，可能含文字或为横幅，仅供参考', result.pageImages);
    }
    if (!hasAny) el.groups.appendChild(emptyState());

    if (copyList.length) {
      el.copyAllBtn.textContent = '复制全部图标地址（' + copyList.length + '）';
      el.actions.hidden = false;
    }
  }

  /* ---------- 主流程 ---------- */

  function runParse() {
    clearError();
    el.resultPanel.hidden = true;

    var text = el.input.value;
    if (!text || !text.replace(/\s/g, '')) {
      showError('请先粘贴网页源代码，再点击「解析源码」。');
      el.input.focus();
      return;
    }

    // 页面地址是必填项：没有它就补全不了相对路径
    var base = paintBaseState({ requireFilled: true });
    if (base.empty) {
      showError('请填写页面地址。\n' +
        '源码里的图标地址大多是相对路径（如 href="/favicon.ico"），必须知道这份源码来自哪个页面才能补全为可用的绝对地址。');
      el.baseInput.focus();
      return;
    }
    if (!base.ok) {
      showError('请先修正页面地址，再解析源码。\n具体原因见上方输入框下方的红色提示。');
      el.baseInput.focus();
      return;
    }

    var result = Parse.parseSource(text, el.baseInput.value);

    if (!result.ok) {
      if (result.reason === 'looks-like-url') {
        showError('这看起来是一个网址，不是网页源码。\n' +
          '请先在浏览器里打开该页面、按 Ctrl+U（macOS 为 Cmd+Option+U）查看源码，再全选复制粘贴到这里；' +
          '或者切换到「自动探测网站」标签页去探测这个网址。');
      } else if (result.reason === 'parse-error') {
        showError('源码解析失败。请确认粘贴的是 HTML 文本，而不是二进制内容或被截断的片段。');
      } else {
        showError('没有在输入内容里识别出 HTML 结构。\n' +
          '请粘贴完整的网页源代码（包含 <head>、<link> 等标签），而不是页面上渲染后可见的文字。');
      }
      el.input.focus();
      return;
    }

    render(result);
    el.resultPanel.hidden = false;
    if (el.resultPanel.scrollIntoView) {
      el.resultPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function updateMeta() {
    var n = el.input.value.length;
    el.sizeMeta.textContent = n.toLocaleString('zh-CN') + ' 字符' +
      (n > Parse.MAX_SOURCE_CHARS ? '（超出上限，解析时截断）' : '');
  }

  var SAMPLE_BASE = 'https://www.example.com/shop/index.html';

  function fillSample() {
    if (!el.sampleSrc) return;
    el.input.value = String(el.sampleSrc.textContent || '').replace(/^\n/, '');
    el.baseInput.value = SAMPLE_BASE;      // 页面地址是必填项，示例一并填好
    paintBaseState();
    updateMeta();
    clearError();
    el.input.focus();
    // 焦点会把光标放到末尾、把文本域滚到底部，回到开头才能看到 <!DOCTYPE html>
    if (el.input.setSelectionRange) el.input.setSelectionRange(0, 0);
    el.input.scrollTop = 0;
    showToast('已填入示例源码与页面地址，点击「解析源码」试试');
  }

  function clearAll() {
    el.input.value = '';
    el.baseInput.value = '';
    el.resultPanel.hidden = true;
    el.groups.innerHTML = '';
    el.resultKv.innerHTML = '';
    updateMeta();
    paintBaseState();
    clearError();
    el.input.focus();
  }

  /* ---------- 事件绑定 ---------- */

  if (el.tabAuto)   el.tabAuto.addEventListener('click', function () { activateTab('auto'); });
  if (el.tabSource) el.tabSource.addEventListener('click', function () { activateTab('source'); });

  el.parseBtn.addEventListener('click', runParse);

  el.input.addEventListener('input', function () {
    updateMeta();
    if (!el.errorBox.hidden) clearError();
  });

  // Ctrl / Cmd + Enter 直接解析
  el.input.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.keyCode === 13)) {
      e.preventDefault();
      runParse();
    }
  });

  el.sampleBtn.addEventListener('click', fillSample);
  el.clearBtn.addEventListener('click', clearAll);

  el.baseInput.addEventListener('input', function () {
    if (!el.errorBox.hidden) clearError();
    paintBaseState();
  });

  // 失焦时把归一化结果回写，让用户看到实际使用的地址（与主搜索框行为一致）
  el.baseInput.addEventListener('blur', function () {
    var r = paintBaseState();
    if (r.ok) el.baseInput.value = r.href;
  });

  el.copyAllBtn.addEventListener('click', function () {
    if (!copyList.length) return;
    copyText(copyList.join('\n')).then(function () {
      showToast('已复制 ' + copyList.length + ' 个图标地址');
    }, function () {
      showToast('复制失败，请手动选择文本复制');
    });
  });

  updateMeta();
  paintBaseState();
  activateTab('auto');

  global.IconSourceTool = {
    parse: function (t, b) { return Parse.parseSource(t, b); },
    activateTab: activateTab,
    runParse: runParse
  };

})(window, document);
