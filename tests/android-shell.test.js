/**
 * 安卓外壳的结构性校验（通用版）。
 *
 * 这些用例不需要 Android 工具链即可运行，用于在 CI 里守住：
 * 应用身份（包名/版本/SDK）、离线要求（无网络权限）、
 * 网页资源同步（U03）、图标与关键 WebView 配置不丢失。
 *
 * 新项目接入时只需修改下面的 EXPECT 常量与 packageDir。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { buildPlan, ASSETS_ROOT, ROOT } from "../scripts/sync-android-assets.mjs";
import { ENTRY_PAGE } from "../scripts/android-assets.config.mjs";

const ANDROID = path.join(ROOT, "android");
const APP = path.join(ANDROID, "app", "src", "main");

/** ===== 按项目替换 ===== */
const EXPECT = {
  applicationId: "com.xiaoxuhui.light",
  namespace: "com.xiaoxuhui.light",
  minSdk: 24,
  targetSdk: 34,
  versionCode: 1,
  versionName: "1.1.0",
  appName: "光的游戏",
  /** MainActivity.kt 所在包路径（对应 java/ 下的目录层级） */
  packageDir: ["com", "xiaoxuhui", "light"],
  /** 网页调用的原生桥名称（addJavascriptInterface 的第二个参数） */
  bridgeName: "LightAndroid",
};

const read = (file) => readFile(file, "utf8");
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * assets 是本地产物（见 android/.gitignore），CI 上的 web 测试跑之前并不会同步它。
 *
 * 「目录不存在」不等于「内容不一致」—— 这两条断言要抓的是「改了网页忘了同步」，
 * 只在同步过之后才有意义。目录不在时跳过，不要误报成失败。
 * （APK 侧的 U03 由 android-apk.yml 校验，那里一定会先同步。）
 */
const SKIP_NO_ASSETS = existsSync(ASSETS_ROOT)
  ? false
  : "assets 尚未同步（npm run sync:android），本次跳过";

test("U03 assets 中的网页与源产物字节一致", { skip: SKIP_NO_ASSETS }, async () => {
  const items = await buildPlan();
  assert.ok(items.length > 0, "同步清单为空，请检查 android-assets.config.mjs");
  for (const item of items) {
    assert.ok(existsSync(item.to), `缺少 ${item.rel}，请先执行同步命令`);
    const [source, target] = await Promise.all([
      readFile(item.from),
      readFile(item.to),
    ]);
    assert.equal(Buffer.compare(source, target), 0, `${item.rel} 与源不一致`);
  }
});

test("入口页存在于 assets 中", { skip: SKIP_NO_ASSETS }, () => {
  assert.ok(
    existsSync(path.join(ASSETS_ROOT, ENTRY_PAGE)),
    `缺少入口页 ${ENTRY_PAGE}（需与 MainActivity 的 ASSET_FILE 一致）`
  );
});

test("应用身份与需求一致（包名/SDK/版本）", async () => {
  const gradle = await read(path.join(ANDROID, "app", "build.gradle.kts"));
  assert.match(gradle, new RegExp(`applicationId\\s*=\\s*"${escape(EXPECT.applicationId)}"`));
  assert.match(gradle, new RegExp(`namespace\\s*=\\s*"${escape(EXPECT.namespace)}"`));
  assert.match(gradle, new RegExp(`minSdk\\s*=\\s*${EXPECT.minSdk}`));
  assert.match(gradle, new RegExp(`targetSdk\\s*=\\s*${EXPECT.targetSdk}`));
  assert.match(gradle, new RegExp(`versionCode\\s*=\\s*${EXPECT.versionCode}`));
  assert.match(gradle, new RegExp(`versionName\\s*=\\s*"${escape(EXPECT.versionName)}"`));
});

test("应用显示名正确", async () => {
  const strings = await read(path.join(APP, "res", "values", "strings.xml"));
  assert.match(
    strings,
    new RegExp(`<string name="app_name">${escape(EXPECT.appName)}</string>`)
  );
});

test("清单声明启动入口且不申请任何权限（离线运行）", async () => {
  const manifest = await read(path.join(APP, "AndroidManifest.xml"));
  assert.match(manifest, /android\.intent\.category\.LAUNCHER/);
  assert.match(manifest, /android:name="\.MainActivity"/);
  assert.doesNotMatch(manifest, /uses-permission/, "外壳不应申请任何权限");
  assert.doesNotMatch(
    manifest,
    /android\.permission\.INTERNET/,
    "应用必须完全离线，不得声明网络权限"
  );
});

test("旋转屏幕不重建 Activity 且不锁定方向", async () => {
  const manifest = await read(path.join(APP, "AndroidManifest.xml"));
  const configChanges = manifest.match(/android:configChanges="([^"]+)"/);
  assert.ok(configChanges, "MainActivity 应声明 configChanges");
  for (const flag of ["orientation", "screenSize", "keyboardHidden"]) {
    assert.ok(
      configChanges[1].includes(flag),
      `configChanges 应包含 ${flag}，以保证旋转时状态不丢失`
    );
  }
  assert.doesNotMatch(
    manifest,
    /android:screenOrientation/,
    "不应锁定屏幕方向，需同时支持手机竖屏与平板横屏"
  );
});

test("WebView 关键配置齐备（JS/本地存储/离线资源/返回键）", async () => {
  const activity = await read(
    path.join(APP, "java", ...EXPECT.packageDir, "MainActivity.kt")
  );
  assert.match(activity, /javaScriptEnabled\s*=\s*true/, "需启用 JavaScript");
  assert.match(activity, /domStorageEnabled\s*=\s*true/, "需启用 localStorage");
  assert.match(activity, /WebViewAssetLoader/, "需通过资产加载器提供本地页面（离线）");
  assert.match(activity, /allowFileAccess\s*=\s*false/, "不应开放文件系统访问");
  assert.match(activity, /onBackPressedDispatcher/, "需处理返回键");
  assert.match(activity, /canGoBack\(\)/, "返回键需优先回退网页历史");
  assert.match(activity, /setOnApplyWindowInsetsListener/, "需处理系统栏遮挡");
  assert.match(activity, /appassets\.androidplatform\.net/, "应以固定域名加载，保证存储 origin 稳定");
  assert.match(activity, /addJavascriptInterface\(/, "需注册 JS 桥（导出/保存功能）");
  assert.match(
    activity,
    new RegExp(`"${escape(EXPECT.bridgeName)}"`),
    `JS 桥名称应为 ${EXPECT.bridgeName}`
  );
  assert.match(activity, /onShowFileChooser/, "需支持网页选择文件（导入功能）");
});

test("图标资源齐全（各密度传统图标 + 自适应图标前景）", () => {
  const densities = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"];
  for (const density of densities) {
    assert.ok(
      existsSync(path.join(APP, "res", `mipmap-${density}`, "ic_launcher.png")),
      `缺少 mipmap-${density}/ic_launcher.png`
    );
    assert.ok(
      existsSync(path.join(APP, "res", `mipmap-${density}`, "ic_launcher_foreground.png")),
      `缺少 mipmap-${density}/ic_launcher_foreground.png`
    );
  }
  assert.ok(existsSync(path.join(APP, "res", "mipmap-anydpi-v26", "ic_launcher.xml")));
  assert.ok(existsSync(path.join(APP, "res", "mipmap-anydpi-v33", "ic_launcher.xml")));
  assert.ok(existsSync(path.join(APP, "res", "drawable", "ic_launcher_background.xml")));
});

test("index.html 引用的本地资源都已在同步清单内（防止漏同步导致白屏）", async () => {
  const html = await readFile(path.join(ROOT, "index.html"), "utf8");

  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((ref) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref));

  assert.ok(
    refs.length >= 7,
    `index.html 只解析出 ${refs.length} 个本地资源，正则可能失效了`
  );

  const plan = await buildPlan();
  const synced = new Set(plan.map((item) => item.rel.split(path.sep).join("/")));

  for (const ref of refs) {
    assert.ok(
      synced.has(ref),
      `index.html 引用了 ${ref}，但它不在 SYNC_ITEMS 里 —— APK 会缺这个文件`
    );
  }
});

test("开发工具脚本没有被同步进 assets", async () => {
  const plan = await buildPlan();
  const rels = plan.map((item) => item.rel.split(path.sep).join("/"));
  for (const tool of [
    "scripts/serve-static.js",
    "scripts/sync-android-assets.mjs",
    "scripts/android-assets.config.mjs",
  ]) {
    assert.ok(!rels.includes(tool), `${tool} 是开发工具，不应进 APK`);
  }
});

test("资源 XML 的注释里不含连续两个减号（AAPT 会直接拒绝）", async () => {
  // XML 规范不允许注释里出现 `--`，而 CSS 变量名恰好长这样（--bg-deep）。
  // 这个错误只有真正跑 aapt 时才会暴露，本机没有 Android 工具链，
  // 所以放在这里当轻量守卫 —— 别等 CI 构建五分钟才发现。
  const dir = path.join(APP, "res");
  const entries = await readdir(dir, { recursive: true });
  const xmlFiles = entries.filter((entry) => entry.endsWith(".xml"));
  assert.ok(xmlFiles.length > 0, "没有找到任何资源 XML，路径可能不对");

  for (const rel of xmlFiles) {
    const text = await readFile(path.join(dir, rel), "utf8");
    for (const comment of text.matchAll(/<!--([\s\S]*?)-->/g)) {
      assert.ok(
        !comment[1].includes("--"),
        `${rel} 的注释里有连续两个减号，aapt 会报 ` +
          `The string "--" is not permitted within comments`
      );
    }
  }
});
