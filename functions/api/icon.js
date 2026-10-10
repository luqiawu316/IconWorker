/* ==========================================================================
   Cloudflare Pages Function：GET /api/icon?url=<图标地址>

   用途：仅服务于「下载图标」。浏览器因 CORS 无法读取的站点，由这里代为取回，
   校验为真实图片后，以附件形式原样返回。不做缓存以外的任何处理，不记录内容。

   部署方式（Cloudflare Pages）：
     1. 在项目根目录执行  npx wrangler pages deploy .   （本文件所在目录会被自动识别）
     2. 或在 Git 集成里把「构建输出目录」设为 .，构建命令留空
   本地预览（不依赖 wrangler）：直接双击 index.html —— 此时没有本 Function，
   下载会自动降级为「复制地址后另存」，页面会如实提示。

   文件位置即路由：functions/api/icon.js → /api/icon

   安全约束：
     · 只允许 http / https；拒绝 localhost、内网与保留地址段（SSRF 基础防护）；
     · 拒绝跨站调用（sec-fetch-site: cross-site），避免被别的站点当成免费图床代理；
     · 重定向逐跳校验，最多 4 跳；若运行时不给读 Location，则退回自动跟随并复核落点主机；
     · 单个文件最大 2 MB，超时 8 秒；
     · 按文件头（魔数）识别图片，不信任上游 Content-Type；非图片一律拒绝。
   已知限制：未做 DNS 解析后的内网校验（DNS 重绑定），如需更严格，请在 Cloudflare 侧配置限速或访问规则。
   ========================================================================== */

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 8000;
const MAX_HOPS = 4;

function reply(status, text, extraHeaders) {
  const headers = Object.assign({
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-icon-proxy': '1',
  }, extraHeaders || {});
  return new Response(text, { status, headers });
}

/** 判断主机名是否指向本机或内网 / 保留地址 */
function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }
  if (h.includes(':')) {
    // IPv6 字面量：回环、未指定、唯一本地、链路本地、IPv4 映射
    return h === '::1' || h === '::' || /^f[cd]/.test(h) || h.startsWith('fe80') || h.startsWith('::ffff:');
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function ascii(bytes, start, len) {
  let s = '';
  for (let i = start; i < start + len && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** 按文件头识别图片格式；无法识别返回 null */
function sniff(bytes) {
  const n = bytes.length;
  if (n >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') return { type: 'image/png', ext: 'png' };
  if (n >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return { type: 'image/x-icon', ext: 'ico' };
  if (n >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (n >= 4 && ascii(bytes, 0, 4) === 'GIF8') return { type: 'image/gif', ext: 'gif' };
  if (n >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return { type: 'image/webp', ext: 'webp' };
  if (n >= 12 && ascii(bytes, 4, 4) === 'ftyp' && /^av(if|is)/.test(ascii(bytes, 8, 4))) return { type: 'image/avif', ext: 'avif' };
  if (n >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return { type: 'image/bmp', ext: 'bmp' };

  // SVG 是文本：前 4 KB 里出现 <svg 且不像完整 HTML 页面，才认为是 SVG
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 4096)).toLowerCase();
  if (/<svg[\s>]/.test(head) && !/<!doctype html|<html[\s>]/.test(head)) {
    return { type: 'image/svg+xml', ext: 'svg' };
  }
  return null;
}

/** 生成附件文件名：<主机>-<原文件名>.<ext> */
function fileNameFor(target, ext) {
  const seg = target.pathname.split('/').filter(Boolean).pop() || 'icon';
  let base = seg.replace(/\.[a-z0-9]+$/i, '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  const host = target.hostname.replace(/[^\w.-]+/g, '_');
  return (host || 'icon') + '-' + (base || 'icon') + '.' + ext;
}

async function fetchFollowing(start) {
  let current = start;
  const init = () => ({
    headers: {
      accept: 'image/*,*/*;q=0.5',
      'user-agent': 'Mozilla/5.0 (compatible; IconDownloader/1.0)',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await fetch(current.href, Object.assign({ redirect: 'manual' }, init()));
    const loc = res.headers.get('location');
    const isRedirect = (res.status >= 300 && res.status < 400) || res.status === 0;

    if (!isRedirect) return res;

    if (!loc) {
      // 运行时把 3xx 折成 opaqueredirect（读不到 Location）时，退回自动跟随，
      // 再用 response.url 复核最终落点，避免跟随到内网/保留地址。
      const followed = await fetch(current.href, Object.assign({ redirect: 'follow' }, init()));
      let finalHost = '';
      try { finalHost = new URL(followed.url || current.href).hostname; } catch (e) { finalHost = ''; }
      if (finalHost && isPrivateHost(finalHost)) {
        throw Object.assign(new Error('redirect blocked'), { code: 'blocked' });
      }
      return followed;
    }

    if (hop === MAX_HOPS) throw Object.assign(new Error('too many redirects'), { code: 'redirects' });
    const next = new URL(loc, current);
    if (!/^https?:$/.test(next.protocol) || isPrivateHost(next.hostname)) {
      throw Object.assign(new Error('redirect blocked'), { code: 'blocked' });
    }
    current = next;
  }
  throw new Error('unreachable');
}

export async function onRequestGet({ request }) {
  // 只服务本站页面发起的下载：跨站调用直接拒绝，避免被当成免费图床代理
  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    return reply(403, '仅限本站页面调用');
  }

  const raw = new URL(request.url).searchParams.get('url') || '';

  let target;
  try {
    target = new URL(raw);
  } catch (e) {
    return reply(400, '地址无效');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return reply(400, '仅支持 http / https');
  if (target.username || target.password) return reply(400, '地址不允许包含账号信息');
  if (isPrivateHost(target.hostname)) return reply(400, '不允许访问内网或本机地址');

  let upstream;
  try {
    upstream = await fetchFollowing(target);
  } catch (e) {
    if (e && e.code === 'blocked') return reply(400, '重定向目标不允许访问');
    if (e && e.code === 'redirects') return reply(502, '重定向次数过多');
    return reply(502, '源站请求失败或超时');
  }

  if (!upstream.ok) {
    return reply(upstream.status, '源站返回 HTTP ' + upstream.status, {
      'x-upstream-status': String(upstream.status),
    });
  }

  const declared = Number(upstream.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) return reply(413, '图标文件过大（超过 2 MB）');

  let buf;
  try {
    buf = await upstream.arrayBuffer();
  } catch (e) {
    return reply(502, '读取源站内容失败');
  }
  if (buf.byteLength > MAX_BYTES) return reply(413, '图标文件过大（超过 2 MB）');

  const kind = sniff(new Uint8Array(buf));
  if (!kind) return reply(415, '源站返回的内容不是可识别的图片格式');

  const filename = fileNameFor(target, kind.ext);
  return new Response(buf, {
    status: 200,
    headers: {
      'content-type': kind.type,
      'content-disposition': 'attachment; filename="' + filename + '"; filename*=UTF-8\'\'' + encodeURIComponent(filename),
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
      'x-icon-proxy': '1',
    },
  });
}
