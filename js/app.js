/* ==========================================================================
   app.js —— 界面装配与交互
   依赖：window.IconUrl、window.IconProbe、window.IconParse、window.IconFinder
   ========================================================================== */
(function (global, document) {
  'use strict';

  var Url = global.IconUrl;
  var Finder = global.IconFinder;
  var Probe = global.IconProbe;

  /* ---------- DOM ---------- */
  var el = {
    form:        document.getElementById('searchForm'),
    input:       document.getElementById('urlInput'),
    submitBtn:   document.getElementById('submitBtn'),
    examples:    document.getElementById('examples'),

    optHtml:       document.getElementById('optHtml'),
    optManifest:   document.getElementById('optManifest'),
    optPageImages: document.getElementById('optPageImages'),
    optArchive:    document.getElementById('optArchive'),
    optThirdParty: document.getElementById('optThirdParty'),

    errorBox:    document.getElementById('errorBox'),

    statusPanel: document.getElementById('statusPanel'),
    spinner:     document.getElementById('spinner'),
    statusText:  document.getElementById('statusText'),

    resultPanel:  document.getElementById('resultPanel'),
    resultTitle:  document.getElementById('resultTitle'),
    iconSlotLg:   document.getElementById('iconSlotLg'),
    iconMini:     document.getElementById('iconMini'),
    resultUrl:    document.getElementById('resultUrl'),
    resultSize:   document.getElementById('resultSize'),
    resultFormat: document.getElementById('resultFormat'),
    resultSource: document.getElementById('resultSource'),
    resultVerify: document.getElementById('resultVerify'),
    resultCount:  document.getElementById('resultCount'),
    resultNote:   document.getElementById('resultNote'),
    downloadBtn:  document.getElementById('downloadBtn'),
    copyBtn:      document.getElementById('copyBtn'),
    openBtn:      document.getElementById('openBtn'),

    altPanel:    document.getElementById('altPanel'),
    altGrid:     document.getElementById('altGrid'),

    warnPanel:   document.getElementById('warnPanel'),
    warnList:    document.getElementById('warnList'),

    attemptsPanel: document.getElementById('attemptsPanel'),
    attemptsBody:  document.getElementById('attemptsBody'),

    toast:       document.getElementById('toast')
  };

  var SOURCE_LABEL = {
    declared:     '页面声明',
    manifest:     'Web App Manifest',
    'default':    '常见默认路径',
    'page-image': '页面图片（非图标）',
    archive:      '网页存档快照',
    'third-party':'第三方图标服务'
  };

  var PHASE_TEXT = {
    html:       '读取页面声明',
    manifest:   '读取 Web App Manifest',
    paths:      '探测常见路径',
    pageImages: '尝试页面图片兜底',
    external:   '尝试存档 / 第三方服务',
    verify:     'CORS 验真'
  };

  // 每次探测分配一个令牌；新探测会令旧探测的回调作废，避免互相覆盖
  var runToken = 0;
  var currentBestUrl = '';
  var currentBestItem = null;
  var toastTimer = null;

  /* ---------- 小工具 ---------- */

  /** 下载用的扩展名：探测已按魔数识别格式，直接沿用；否则从地址推断 */
  function extOfItem(item) {
    var k = String(item.kind || '').toLowerCase();
    if (/^(png|ico|svg|gif|jpeg|webp|bmp)$/.test(k)) return k === 'jpeg' ? 'jpg' : k;
    return global.IconDownload.extFromUrl(item.url) || 'png';
  }

  /** 下载失败时给用户看的原因（与源码解析页共用同一套文案，见 download.js） */
  function downloadErrorText(err) {
    return global.IconDownload.errorText(err);
  }

  /** 下载一个探测到的图标；按钮在下载期间禁用，防止重复点击 */
  function downloadIcon(item, btn) {
    if (!item || !item.url) return;
    btn.disabled = true;
    // 跨域图标要等浏览器直连失败后再由服务器代取，可能耗时数秒，先给个常驻提示
    showToast('正在下载…', 0);
    global.IconDownload.save(item.url, { ext: extOfItem(item) }).then(function () {
      showToast('已开始下载' + global.IconDownload.embeddedHint());
    }, function (err) {
      showToast(downloadErrorText(err));
    }).then(function () {
      btn.disabled = false;
    });
  }

  function showError(message) {
    el.errorBox.textContent = message;
    el.errorBox.hidden = false;
  }

  function clearError() {
    el.errorBox.textContent = '';
    el.errorBox.hidden = true;
  }

  function showToast(message, holdMs) {
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

  function setNote(node, text) {
    if (text) {
      node.textContent = text;
      node.hidden = false;
    } else {
      node.textContent = '';
      node.hidden = true;
    }
  }

  function resetOutput() {
    el.resultPanel.hidden = true;
    el.altPanel.hidden = true;
    el.warnPanel.hidden = true;
    el.attemptsPanel.hidden = true;
    el.statusPanel.hidden = true;
    el.attemptsBody.innerHTML = '';
    el.warnList.innerHTML = '';
    el.altGrid.innerHTML = '';
    el.iconSlotLg.innerHTML = '';
    el.iconMini.removeAttribute('src');
    setNote(el.resultNote, '');
    currentBestUrl = '';
    currentBestItem = null;
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

  /* ---------- 展示辅助 ---------- */

  function kindLabelOf(item) {
    var kind = item.kind;
    var inferred = false;
    if (!kind) {
      var m = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(item.url || '');
      kind = m ? m[1].toLowerCase() : '';
      if (kind === 'jpg') kind = 'jpeg';
      inferred = true;
    }
    var label = Probe.KIND_LABEL[kind] || (kind ? String(kind).toUpperCase() : '未知');
    if (inferred && kind) label += '（按扩展名推断）';
    return label;
  }

  function icoDetailOf(item) {
    if (!item.icoSizes || !item.icoSizes.length) return '';
    var parts = [];
    for (var i = 0; i < item.icoSizes.length; i++) {
      parts.push(item.icoSizes[i].width + '×' + item.icoSizes[i].height);
    }
    return 'ICO 内含 ' + parts.join('、');
  }

  function verifyTextOf(item) {
    if (item.verified === true) {
      var parts = ['HTTP ' + item.httpStatus];
      parts.push(Probe.KIND_LABEL[item.kind] || item.kind || '未知');
      if (item.bytes) parts.push(item.bytes + ' B');
      if (typeof item.opaqueRatio === 'number') {
        parts.push('不透明像素 ' + Math.round(item.opaqueRatio * 100) + '%');
      }
      return parts.join(' · ');
    }
    if (item.verified === false) {
      return '未验真（站点未返回 Access-Control-Allow-Origin，读不到状态码与内容）';
    }
    if (item.skipVerify) return '不适用（第三方来源，无法验真）';
    return '不适用';
  }

  /* ---------- 渲染 ---------- */

  function renderResult(report) {
    var best = report.best;

    el.resultUrl.textContent = Url.shortenUrl(best.url, 72);
    el.resultUrl.href = best.url;
    el.resultUrl.title = best.url;
    el.openBtn.href = best.url;

    el.resultSize.textContent = (best.width && best.height)
      ? best.width + ' × ' + best.height + ' px'
      : '未知';

    var fmt = kindLabelOf(best);
    var ico = icoDetailOf(best);
    el.resultFormat.textContent = ico ? (fmt + '（' + ico + '）') : fmt;

    el.resultSource.textContent = SOURCE_LABEL[best.source] || best.source;

    el.resultVerify.textContent = verifyTextOf(best);

    el.resultCount.textContent = report.usable.length + ' / ' + report.attempts.length + ' 个候选可用';

    // 标题随来源变化，兜底来源要一眼看出来
    el.resultTitle.className = 'card__title';
    if (best.source === 'page-image') {
      el.resultTitle.textContent = '未找到图标，以下为页面图片（不是图标）';
      el.resultTitle.classList.add('is-warn-title');
    } else if (best.source === 'archive') {
      el.resultTitle.textContent = '已找到图标（来自网页存档快照，可能已过期）';
      el.resultTitle.classList.add('is-warn-title');
    } else if (best.source === 'third-party') {
      el.resultTitle.textContent = '已找到图标（来自第三方服务，未经源站确认）';
      el.resultTitle.classList.add('is-warn-title');
    } else {
      el.resultTitle.textContent = '已找到图标';
    }

    setNote(el.resultNote, best.note || '');

    // 复用已经加载成功的 Image 元素，避免二次请求
    if (best.el) {
      el.iconSlotLg.appendChild(best.el);
    } else {
      var img = document.createElement('img');
      img.alt = '网站图标预览';
      img.src = best.url;
      el.iconSlotLg.appendChild(img);
    }

    el.iconMini.src = best.url;
    el.iconMini.alt = '图标 16 像素预览：' + best.url;

    currentBestUrl = best.url;
    currentBestItem = best;
    el.resultPanel.hidden = false;
  }

  function renderAlternatives(report) {
    el.altGrid.innerHTML = '';
    var alts = report.alternatives || [];

    if (!alts.length) {
      el.altPanel.hidden = true;
      return;
    }

    var frag = document.createDocumentFragment();
    var limit = Math.min(alts.length, 12);

    for (var i = 0; i < limit; i++) {
      var a = alts[i];

      var box = document.createElement('div');
      box.className = 'alt';

      var iconBox = document.createElement('div');
      iconBox.className = 'icon-box icon-box--md';
      if (a.el) {
        iconBox.appendChild(a.el);
      } else {
        var im = document.createElement('img');
        im.src = a.url;
        im.alt = '';
        iconBox.appendChild(im);
      }
      box.appendChild(iconBox);

      var meta = document.createElement('div');
      meta.className = 'alt__meta';

      var link = document.createElement('a');
      link.className = 'alt__url';
      link.href = a.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = Url.shortenUrl(a.url, 44);
      link.title = a.url;
      meta.appendChild(link);

      var info = document.createElement('span');
      info.className = 'alt__info';
      var bits = [(a.width || 0) + '×' + (a.height || 0)];
      var k = Probe.KIND_LABEL[a.kind];
      if (k) bits.push(k);
      bits.push(SOURCE_LABEL[a.source] || a.source);
      info.textContent = bits.join(' · ');
      meta.appendChild(info);

      box.appendChild(meta);

      var dl = document.createElement('button');
      dl.type = 'button';
      dl.className = 'btn btn--mini alt__dl';
      dl.textContent = '下载';
      dl.setAttribute('aria-label', '下载图标 ' + a.url);
      (function (item, button) {
        button.addEventListener('click', function () { downloadIcon(item, button); });
      })(a, dl);
      box.appendChild(dl);

      frag.appendChild(box);
    }

    el.altGrid.appendChild(frag);
    el.altPanel.hidden = false;
  }

  function renderAttempts(report) {
    var frag = document.createDocumentFragment();

    report.attempts.forEach(function (a) {
      var tr = document.createElement('tr');
      var isBad = (a.excluded === true) || (a.usable === false);
      if (a.ok && !isBad) tr.className = 'is-ok';
      else if (isBad) tr.className = 'is-bad';

      // 候选来源
      var tdLabel = document.createElement('td');
      tdLabel.textContent = a.label;
      tr.appendChild(tdLabel);

      // 地址
      var tdUrl = document.createElement('td');
      var link = document.createElement('a');
      link.href = a.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = Url.shortenUrl(a.url, 60);
      link.title = a.url;
      tdUrl.appendChild(link);
      tr.appendChild(tdUrl);

      // 结果
      var tdState = document.createElement('td');
      var badge = document.createElement('span');
      badge.className = 'badge';
      if (!a.probed) {
        badge.className += ' badge--skip';
        badge.textContent = '未尝试';
      } else if (a.ok) {
        badge.className += ' badge--ok';
        badge.textContent = '成功';
      } else if (a.reason === 'timeout') {
        badge.className += ' badge--no';
        badge.textContent = '超时';
      } else {
        badge.className += ' badge--no';
        badge.textContent = '未找到';
      }
      tdState.appendChild(badge);
      tr.appendChild(tdState);

      // 尺寸
      var tdSize = document.createElement('td');
      tdSize.className = 'cell-size';
      if (!a.probed) {
        tdSize.textContent = '—';
      } else if (a.ok) {
        tdSize.textContent = a.width + '×' + a.height;
        var ico = icoDetailOf(a);
        if (ico) {
          var sub = document.createElement('span');
          sub.className = 'cell-sub';
          sub.textContent = ico;
          tdSize.appendChild(sub);
        }
      } else {
        tdSize.textContent = '—';
      }
      tr.appendChild(tdSize);

      // 验真
      var tdVerify = document.createElement('td');
      tdVerify.className = 'cell-verify';
      if (!a.probed) {
        tdVerify.textContent = '—';
      } else if (a.verified === true) {
        var v = 'HTTP ' + a.httpStatus + ' · ' + (Probe.KIND_LABEL[a.kind] || a.kind);
        if (a.bytes) v += ' · ' + a.bytes + ' B';
        tdVerify.textContent = v;
      } else if (a.verified === false) {
        tdVerify.textContent = '无 CORS 头';
      } else if (a.skipVerify) {
        tdVerify.textContent = '不适用';
      } else {
        tdVerify.textContent = '—';
      }
      tr.appendChild(tdVerify);

      frag.appendChild(tr);
    });

    el.attemptsBody.appendChild(frag);
    el.attemptsPanel.hidden = report.attempts.length === 0;
  }

  function renderWarnings(report) {
    el.warnList.innerHTML = '';
    if (!report.warnings || !report.warnings.length) {
      el.warnPanel.hidden = true;
      return;
    }
    var frag = document.createDocumentFragment();
    report.warnings.forEach(function (w) {
      var li = document.createElement('li');
      li.textContent = w.text;
      li.className = w.type === 'warn' ? 'is-warn' : 'is-info';
      frag.appendChild(li);
    });
    el.warnList.appendChild(frag);
    el.warnPanel.hidden = false;
  }

  function renderNotFound(report) {
    var lines = [];

    if (report.suppressed) {
      lines.push(report.origin + ' 明确声明了不提供图标。');
      lines.push('');
      lines.push('页面里写着 <link rel="icon" href="data:,"> ——这是主动抑制 favicon 的写法，');
      lines.push('目的是阻止浏览器自动请求 /favicon.ico。该站点是故意的，不是探测失败。');
      showError(lines.join('\n'));
      return;
    }

    lines.push('未能在 ' + report.origin + ' 找到任何可访问的图标。');
    lines.push('');

    if (report.reachable === false) {
      lines.push('经检测，当前环境未能连接到该站点，可能的原因：');
      lines.push('· 域名不存在或拼写有误；');
      lines.push('· DNS 解析失败；');
      lines.push('· 本机网络暂时不可达，或该站点的访问被网络策略拦截。');
      lines.push('');
      lines.push('建议先确认地址拼写，并在浏览器中直接打开该地址验证网络是否通畅。');
    } else {
      lines.push('该站点网络可达，但以下途径都没能拿到图标：');
      lines.push('· 页面声明（可能被浏览器 CORS 策略拦截，实测多数站点读不到）');
      lines.push('· Web App Manifest / browserconfig.xml');
      lines.push('· ' + Finder.DEFAULT_PATHS.length + ' 条常见默认路径');
      lines.push('');
      lines.push('注意：这不等于该站点没有图标。图标可能位于非标准路径，');
      lines.push('而页面声明又因浏览器跨域限制无法读取——这是纯前端方案的固有边界。');
    }

    showError(lines.join('\n'));
  }

  /* ---------- 主流程 ---------- */

  function readOptions() {
    return {
      parseHtml:     el.optHtml.checked,
      useManifest:   el.optManifest.checked,
      usePageImages: el.optPageImages.checked,
      useArchive:    el.optArchive.checked,
      useThirdParty: el.optThirdParty.checked
    };
  }

  function run(pageUrl) {
    var token = ++runToken;
    var originText = pageUrl.origin;
    var phaseLabel = '准备';

    clearError();
    resetOutput();

    el.submitBtn.setAttribute('aria-busy', 'true');
    el.statusPanel.hidden = false;
    el.spinner.hidden = false;
    el.statusText.textContent = '正在探测 ' + originText + ' …';

    var opts = readOptions();

    opts.onPhase = function (key) {
      if (token !== runToken) return;
      phaseLabel = PHASE_TEXT[key] || '探测';
      el.statusText.textContent = '正在' + phaseLabel + '：' + originText + ' …';
    };

    opts.onProgress = function (done, total) {
      if (token !== runToken) return;
      el.statusText.textContent =
        '正在' + phaseLabel + '：' + originText + '（' + done + ' / ' + total + '）';
    };

    Finder.findFavicons(pageUrl, opts).then(function (report) {
      // 已被更新的探测取代：直接丢弃本次结果，不碰界面
      if (token !== runToken) return;

      el.statusPanel.hidden = true;

      renderAttempts(report);
      renderWarnings(report);

      if (report.best) {
        renderResult(report);
        renderAlternatives(report);
      } else {
        renderNotFound(report);
      }
    }).catch(function (err) {
      if (token !== runToken) return;
      el.statusPanel.hidden = true;
      showError('探测过程发生意外错误：' +
        (err && err.message ? err.message : '未知错误') +
        '。请更换地址后重试。');
    }).then(function () {
      if (token !== runToken) return;
      el.submitBtn.removeAttribute('aria-busy');
      el.spinner.hidden = true;
      el.statusPanel.hidden = true;
    });
  }

  /* ---------- 事件绑定 ---------- */

  function submitCurrentInput() {
    var parsed = Url.normalizeInput(el.input.value);
    if (!parsed.ok) {
      runToken++;          // 让正在进行的探测失效
      resetOutput();
      showError(parsed.error);
      el.input.focus();
      return;
    }

    // 把归一化结果回写到输入框，让用户看到实际使用的地址
    el.input.value = parsed.url.href;
    run(parsed.url);
  }

  el.form.addEventListener('submit', function (e) {
    e.preventDefault();
    submitCurrentInput();
  });

  el.examples.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    var chip = e.target.closest('.chip');
    if (!chip) return;

    el.input.value = chip.getAttribute('data-url') || '';
    el.input.focus();
    submitCurrentInput();
  });

  el.downloadBtn.addEventListener('click', function () {
    if (currentBestItem) downloadIcon(currentBestItem, el.downloadBtn);
  });

  el.copyBtn.addEventListener('click', function () {
    if (!currentBestUrl) return;
    copyText(currentBestUrl).then(function () {
      showToast('已复制图标 URL');
    }).catch(function () {
      showToast('复制失败，请手动选择文本复制');
    });
  });

  // 输入时清掉上一次的错误提示
  el.input.addEventListener('input', function () {
    if (!el.errorBox.hidden) clearError();
  });

  // 勾选第三方来源时给出即时提醒
  [el.optArchive, el.optThirdParty].forEach(function (box) {
    box.addEventListener('change', function () {
      if (box.checked) {
        showToast(box === el.optArchive
          ? '已开启网页存档：会向 web.archive.org 发起请求'
          : '已开启第三方服务：你查询的域名会发送给 Google / DuckDuckGo');
      }
    });
  });

  if (!el.input.value) el.input.focus();

})(window, document);
