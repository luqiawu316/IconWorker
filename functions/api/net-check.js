/* ==========================================================================
   Cloudflare Pages Function：GET /api/net-check

   用途：代理环境检测（系统代理一项）。浏览器无法读取操作系统的代理设置，
   因此由这里返回 Cloudflare 看到的出口信息（国家 / 时区 / ASN），
   前端再与本机时区比对：出口时区与本机时区不一致，通常说明流量经过了远端出口。

   本地双击打开 index.html 时没有本 Function，前端会如实显示「无法判断」。
   不记录、不缓存任何请求内容。
   ========================================================================== */

export async function onRequest(context) {
  const cf = context.request.cf || {};
  const body = {
    country: cf.country || null,
    timezone: cf.timezone || null,
    asn: cf.asn || null,
    asOrganization: cf.asOrganization || null,
  };
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
