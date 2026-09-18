# 光的游戏 · light_game

[![test](https://github.com/xiaoxuhui/light_game/actions/workflows/test.yml/badge.svg)](https://github.com/xiaoxuhui/light_game/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一个零运行时依赖、可离线运行的浏览器小游戏，主题是「光」。

> **当前状态：工程骨架**。玩法规则尚未确定，页面上的画布只是待机光晕。
> 本地服务、语法检查、ESLint、单元测试、浏览器冒烟与 CI 已经全部就位，
> 需求定稿后只需往里填玩法实现。

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| 一 | 电脑浏览器 Web 版（纯静态，无打包器） | 进行中 |
| 二 | 打包安卓 APK（WebView 外壳 + 内置资源 + 云端构建） | 未开始 |

阶段二复用已在 EML 计算台、康威生命游戏上跑通的打包方案，前提是阶段一在浏览器里完全跑通。

## 本地运行

需要 Node.js 20.19 或更高版本。

```bash
npm ci            # 安装开发依赖（仅 eslint 与 Playwright，运行时零依赖）
npm run serve     # 启动静态服务，默认 http://127.0.0.1:4174
```

端口刻意避开 4173 —— 那个端口被同目录下的 conway-life-game 占用，
两个项目同时启动时 Playwright 会连错站点。需要改端口用 `PORT=5000 npm run serve`。

也可以直接双击 `index.html` 用 `file://` 打开，项目不依赖任何构建产物。

## 质量命令

```bash
npm run check         # JavaScript 语法检查
npm run lint          # ESLint 静态检查
npm test              # 单元测试（node --test）
npm run test:browser  # Playwright 冒烟（桌面 + 移动视口）
```

## 项目结构

```
index.html                     单页入口
styles/main.css                全部样式，主题变量集中在 :root
scripts/app.js                 应用引导：画布、DPR、渲染循环（很薄的一层）
scripts/serve-static.js        零依赖本地静态服务
tests/static-app.test.js       结构与一致性断言，不需要浏览器
e2e/app.smoke.spec.js          浏览器冒烟
doc/                           需求与测试用例、设计文档、实施计划
.github/workflows/test.yml     CI：语法 + lint + 单测 + 浏览器冒烟
```

玩法实现会按依赖顺序拆成独立的 `<script defer>` 文件（如光传播、渲染、关卡），
与 `app.js` 共享全局命名空间。新增跨文件全局时记得同步 `eslint.config.js` 的 `crossScriptGlobals`。

## 设计约束

这些约束是为了让阶段二的 APK 打包不返工，请勿违反：

- **零运行时依赖**：不使用 npm 运行时包、不使用打包器、不请求 CDN。
- **相对路径引用资源**：绝对路径 `/xxx` 在安卓 WebView 里会解析到错误域名并 404 白屏。
- **不使用 `type="module"`**：`file://` 下会被 CORS 拦截；脚本按 `defer` 顺序加载。
- **不用 HTML5 拖放传交互**：安卓触摸端不触发 `dragover` / `drop`，需要 Pointer Events。
- **导出走可替换的下载函数**：WebView 不支持 `Blob` + `<a download>`，届时改由 JS 桥接管。

## 许可

[MIT](LICENSE) © 2026 xiaoxuhui
