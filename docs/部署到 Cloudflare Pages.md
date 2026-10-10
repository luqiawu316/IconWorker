# 部署到 Cloudflare Pages

## 一条命令

```bash
cd D:/VibeCoding/Icon
npx wrangler login          # 首次
npx wrangler pages deploy .  --project-name=favicon-finder
```

部署后地址形如 `https://favicon-finder.pages.dev`。

## 关键：别丢掉 `functions/`

| 目录 / 文件 | 作用 |
| --- | --- |
| `index.html` `css/` `js/` | 前端本体，纯静态 |
| `functions/api/icon.js` | 下载代理，路由 `/api/icon`；跨域图标的字节由它代取 |
| `wrangler.toml` | 声明输出目录为 `.`，让无参 `pages deploy` 可用 |
| `.assetsignore` | 排除 `.workbuddy/` 等开发文件，不上传 |

只上传前端而丢掉 `functions/`：页面能打开、图标能显示，但「下载」会退化为「复制地址后另存」（端口没有代理可用）。

## Git 集成方式（如走 Dashboard 连接仓库）

| 设置项 | 值 |
| --- | --- |
| 构建命令 | 留空 |
| 构建输出目录 | `.` |
| 生产分支 | main |

## 本地预览（含 Function）

```bash
npx wrangler pages dev .
```

直接双击 `index.html` 也能跑，但没有 Function，下载会降级。

## 部署后自检

| 请求 | 预期 |
| --- | --- |
| `/api/icon?url=https://github.com/favicon.ico` | 直接下载文件，响应头含 `x-icon-proxy: 1` 与 `content-disposition: attachment` |
| `/api/icon?url=http://127.0.0.1/x.png` | 文本「不允许访问内网或本机地址」 |
| `/api/icon?url=file:///etc/passwd` | 文本「仅支持 http / https」 |
| 页面上点「下载图标」 | 开始下载，页面不发生跳转 |

## 下载链路（三级）

1. `data:` 内联图标 —— 本机解码，不联网。
2. 同源或已开放 CORS 的地址 —— 浏览器直连取字节，不经过服务器。
3. 其余跨域地址 —— 走 `/api/icon`，由 Function 代取并以附件返回（上限 2 MB / 8 秒，只允许图片魔数）。
