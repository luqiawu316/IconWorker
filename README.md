# 网站图标获取器 · Favicon Finder

一个纯前端的 favicon 工具。输入网址即可自动探测网站图标，也可以粘贴网页源码，由浏览器在本机解析出其中声明的图标地址。解析出的图标可以预览、下载或复制地址。

## 主要功能

### 自动探测网站
输入域名或完整网址（可省略 `https://`），工具会按以下顺序寻找图标：

1. **页面声明**：读取页面中的 `link rel="icon"`、`apple-touch-icon` 等声明。
2. **Web App Manifest**：读取 `site.webmanifest` 与 `browserconfig.xml`。
3. **常见默认路径**：探测 `/favicon.ico` 等约定路径。
4. **页面图片兜底**：前面全部落空时，用页面中的 logo / `og:image` 作为参考（会标明它不是图标）。
5. **可选来源**（默认关闭，需手动开启）：
   - **存档快照**：向 `web.archive.org` 请求该站点的历史快照。
   - **第三方服务**：把域名发送给 Google S2 / DuckDuckGo 获取图标。

每个候选都会展示探测明细，并尝试 CORS 验真（读取真实尺寸、格式与字节数）。

### 网页源码解析
粘贴网页源码并填写页面地址（用于补全相对路径），工具在本机解析出所有图标地址，按来源分组展示，并直接加载为预览图。解析本身不发起任何网络请求，只有预览图加载会访问这些地址。

### 下载图标
下载分为三级，越靠后越可靠：

1. `data:` 内联图标：本机解码，不联网。
2. 同源或已开放 CORS 的地址：浏览器直接取字节。
3. 其余跨域地址：经同源代理 `/api/icon` 由服务端代取，并以附件形式返回。

### 代理环境检测
页面右下角的胶囊会检测当前网络是否处于代理环境，采用双重检测，任一命中即判定为代理：

- **Google 访问检测**：能访问 Google 即视为可达。
- **系统代理检测**：浏览器无法读取系统代理设置，因此比对 Cloudflare 看到的出口时区与本机时区。

颜色含义：**绿点 = 代理环境，红点 = 当前未链接到代理**。点击胶囊可重新检测。

> 限制：在本身能直连 Google 的地区，Google 检测会恒为「可达」，属于固有误报；时区比对只是启发式判断，同时区内的代理检测不出来。本地双击打开时无法执行系统代理检测，会显示为「无法判断」。

## 已知限制

- **浏览器跨域策略（CORS）是最大的限制。** 多数站点不返回 `Access-Control-Allow-Origin`，因此常常拿不到 HTTP 状态码，只能以「图片能否显示」作为判据。读不到状态码时，无法区分「404 错误页」与「真的没有图标」。
- **下载需要拿到字节。** 跨域地址上的 `download` 属性会被浏览器忽略，所以字节先尝试直连，被拦截时改走 `/api/icon` 代理。本地双击打开或平台不支持 Functions 时没有代理，只能复制地址后另存。
- **扩展名与 `Content-Type` 都不可信。** 部分站点的 `/favicon.ico` 实际内容是 PNG；部分站点对任意路径都返回 200 页面，仅看状态码会误报。工具按文件头（魔数）识别格式。

## 项目结构

```
index.html            页面骨架
css/style.css         样式（浅色主题）
js/
  url-utils.js        网址归一化
  icon-probe.js       图片加载、尺寸与格式探测
  icon-parse.js       源码解析（本机）
  favicon-finder.js   自动探测流程编排
  download.js         下载（直连 → 代理）
  app.js              自动探测页的界面装配
  source-tool.js      网页源码解析页
  proxy-check.js      代理环境检测胶囊
functions/api/
  icon.js             下载代理 Function（路由 /api/icon）
  net-check.js        出口信息 Function（路由 /api/net-check）
docs/                 设计与部署说明
wrangler.toml         Cloudflare Pages 配置
.assetsignore         部署时排除的开发文件
```

## 部署方式

项目是纯静态前端，外加两个 Cloudflare Pages Functions。部署时必须保留 `functions/` 目录，否则下载代理和代理环境检测的系统代理项不可用。

### 方式一：Wrangler 命令行（推荐）

```bash
npx wrangler login
npx wrangler pages deploy . --project-name=favicon-finder
```

`wrangler.toml` 已声明输出目录为 `.`，因此也可以直接执行 `npx wrangler pages deploy`。部署后的地址形如 `https://favicon-finder.pages.dev`。

### 方式二：Git 集成

在 Cloudflare Dashboard 中连接仓库，并使用以下设置：

| 设置项 | 值 |
| --- | --- |
| 构建命令 | 留空 |
| 构建输出目录 | `.` |
| 生产分支 | `main` |

### 本地预览

```bash
npx wrangler pages dev .
```

直接双击 `index.html` 也能打开页面，但没有 Functions，下载会降级为「复制地址后另存」，代理环境检测的系统代理项会显示为「无法判断」。

### 部署后自检

| 请求 | 预期 |
| --- | --- |
| `/api/icon?url=https://github.com/favicon.ico` | 直接下载文件，响应头含 `x-icon-proxy: 1` 与 `content-disposition: attachment` |
| `/api/icon?url=http://127.0.0.1/x.png` | 文本「不允许访问内网或本机地址」 |
| `/api/icon?url=file:///etc/passwd` | 文本「仅支持 http / https」 |
| `/api/net-check` | JSON，含 `country`、`timezone`、`asn`、`asOrganization` 字段 |
| 页面上点「下载图标」 | 开始下载，页面不发生跳转 |

更详细的部署说明见 [docs/部署到 Cloudflare Pages.md](docs/部署到 Cloudflare Pages.md)。
