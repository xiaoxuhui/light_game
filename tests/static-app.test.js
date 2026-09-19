"use strict";

// 结构性单测：不依赖浏览器，只校验「文件是否自洽」。
// 覆盖三类最容易悄悄坏掉的东西：
//   1. 版本号漂移（package.json / index.html / CHANGELOG 必须一致）
//   2. 资源引用写错（少文件、绝对路径 —— 绝对路径会让将来的安卓 WebView 直接 404 白屏）
//   3. 工程门禁文件缺失（CI、eslint、gitignore）

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const readFile = (relative) => fs.readFileSync(path.join(projectRoot, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(projectRoot, relative));

const packageJson = JSON.parse(readFile("package.json"));
const indexHtml = readFile("index.html");

/** 取出入口页里所有 src/href 引用 */
function collectAssetRefs(html) {
  return [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
}

test("index.html 使用中文语言声明与 UTF-8 编码", () => {
  assert.match(indexHtml, /<html lang="zh-CN">/);
  assert.match(indexHtml, /<meta charset="UTF-8"/);
  assert.match(indexHtml, /<title>光的游戏/);
});

test("index.html 不含编辑器注入的预览属性", () => {
  // 编辑器的可视化预览会往每个标签上追加 data-page-node-id，这个属性会污染 diff，
  // 还会让上面那些要求标签结构干净的正则失效。它已经混进来过四次，所以在这里拦住，
  // 免得靠提交前手工 sed 清理。
  const injected = indexHtml.match(/data-page-node-id="[^"]*"/g) || [];
  assert.equal(
    injected.length,
    0,
    `index.html 里有 ${injected.length} 处编辑器注入的 data-page-node-id，提交前请清理`,
  );
});

test("页面版本号与 package.json 保持一致", () => {
  const version = packageJson.version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.ok(
    indexHtml.includes(`v${version}`),
    `index.html 里应出现 v${version}（data-app-version 展示用），实际未找到`,
  );
  assert.ok(
    readFile("CHANGELOG.md").includes(version),
    `CHANGELOG.md 应包含 ${version} 条目`,
  );
});

test("入口页引用的本地资源全部存在，且不使用绝对路径", () => {
  const refs = collectAssetRefs(indexHtml).filter((ref) => !ref.startsWith("data:"));
  assert.ok(refs.length >= 2, "入口页至少应引用样式表与入口脚本");

  for (const ref of refs) {
    assert.ok(!ref.startsWith("/"), `资源引用不得使用绝对路径（安卓 WebView 会 404）：${ref}`);
    assert.ok(!/^https?:/.test(ref), `资源应全部本地化，不依赖网络：${ref}`);
    assert.ok(exists(ref), `引用的文件不存在：${ref}`);
  }
});

test("入口脚本按 defer 顺序加载、不使用 ES module", () => {
  const scriptTags = [...indexHtml.matchAll(/<script[^>]*>/g)].map((match) => match[0]);
  assert.ok(scriptTags.length >= 1, "至少应有一个脚本标签");

  for (const tag of scriptTags) {
    assert.match(tag, /\bdefer\b/, `脚本应为 defer 加载以保证 DOM 就绪顺序：${tag}`);
    assert.ok(!/type="module"/.test(tag), `暂不使用 ES module（file:// 下会被 CORS 拦截）：${tag}`);
  }
});

test("页面样式表存在且定义了舞台与主题变量", () => {
  const css = readFile("styles/main.css");
  assert.match(css, /:root\s*\{/);
  assert.match(css, /\.stage\s*\{/);
  // 安全区变量：手机刘海 / 手势条适配
  assert.match(css, /env\(safe-area-inset-top/);
});

test("入口页提供常驻的通关状态行与「下一关」入口", () => {
  // 结算浮层会被关掉，通关后必须还有常驻入口，否则玩家会卡在已通关的关卡里出不去
  assert.match(indexHtml, /id="btn-next"/, "顶栏应有常驻的下一关按钮");
  assert.match(indexHtml, /id="level-status"/, "舞台下方应有常驻的通关状态行");

  const app = readFile("scripts/app.js");
  assert.match(app, /getElementById\("btn-next"\)/, "app.js 应接管下一关按钮");
  assert.match(app, /getElementById\("level-status"\)/, "app.js 应接管通关状态行");
});

test("应用脚本提供待机渲染与渲染循环", () => {
  const app = readFile("scripts/app.js");
  assert.match(app, /requestAnimationFrame/);
  assert.match(app, /ResizeObserver/);
  assert.match(app, /devicePixelRatio/);
  assert.match(app, /prefers-reduced-motion/);
});

test("package.json 的脚本入口齐全", () => {
  for (const name of ["serve", "test", "test:browser", "check", "lint"]) {
    assert.ok(packageJson.scripts[name], `package.json 缺少 ${name} 脚本`);
  }
  assert.equal(packageJson.private, true, "本项目不发布 npm 包，应保持 private: true");
  assert.equal(packageJson.license, "MIT");
});

test("工程门禁文件齐全", () => {
  for (const file of [
    "LICENSE",
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "SECURITY.md",
    ".gitignore",
    ".gitattributes",
    "eslint.config.js",
    "playwright.config.js",
    ".github/workflows/test.yml",
  ]) {
    assert.ok(exists(file), `缺少文件：${file}`);
  }
});

test("gitignore 忽略依赖、构建产物与测试报告", () => {
  const ignore = readFile(".gitignore");
  for (const entry of ["node_modules/", "playwright-report/", "test-results/"]) {
    assert.ok(ignore.includes(entry), `.gitignore 应忽略 ${entry}`);
  }
});

test("本地服务端口与 Playwright 配置一致，且与 conway-life-game 错开", () => {
  const serve = readFile("scripts/serve-static.js");
  const playwright = readFile("playwright.config.js");
  const servePort = serve.match(/PORT \|\| (\d+)/)?.[1];
  const configPort = playwright.match(/127\.0\.0\.1:(\d+)/)?.[1];

  assert.ok(servePort, "serve-static.js 应提供默认端口");
  assert.ok(configPort, "playwright.config.js 应提供 baseURL 端口");
  assert.equal(servePort, configPort, "两处端口必须一致，否则 e2e 会连错服务");
  assert.notEqual(servePort, "4173", "4173 已被 conway-life-game 占用，本项目须错开");
});

test("CI 工作流覆盖语法检查、lint、单测与浏览器冒烟", () => {
  const workflow = readFile(".github/workflows/test.yml");
  for (const step of ["npm run check", "npm run lint", "npm test", "npm run test:browser"]) {
    assert.ok(workflow.includes(step), `CI 应包含步骤：${step}`);
  }
});
