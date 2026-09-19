# 光的游戏 · 安卓外壳

把「光的游戏」（纯静态网页小游戏）打包成可离线安装的安卓 APK。
外壳是一个极简 WebView 容器，不含任何业务逻辑，网页改动会自动跟随。

- 包名：`com.xiaoxuhui.light`
- 应用名：光的游戏
- 版本：1.1.0（versionCode 1）
- minSdk 24（Android 7.0）/ targetSdk 34
- 权限：**无**（完全离线，不申请网络权限）

## 目录结构

```
android/
├── app/src/main/
│   ├── assets/                       # 由脚本从仓库根同步，不入库
│   │   ├── index.html
│   │   ├── scripts/                  # light-core / light-engine / levels / renderer / storage / app
│   │   └── styles/main.css
│   ├── java/com/xiaoxuhui/light/
│   │   └── MainActivity.kt           # WebView 外壳与 JS 桥
│   └── res/                          # 图标、主题、备份规则
├── icon-source/                      # 图标原图与去水印归档
├── tools/make-icons.py               # 图标各密度生成脚本
└── gradle/wrapper/                   # Gradle wrapper
```

## 构建

### 1. 同步网页资源（必需）

网页只在仓库根维护（`index.html` + `scripts/` + `styles/`），构建前同步进 assets：

```bash
npm run sync:android   # 同步到 android/app/src/main/assets/
npm run check:android  # 只校验是否一致，CI 用
```

### 2. 本地构建

需要 JDK 17：

```bash
cd android
./gradlew assembleDebug        # Linux / macOS（首次需 chmod +x gradlew）
gradlew.bat assembleDebug      # Windows
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`

直接用 Android Studio 打开 `android/` 目录亦可，但需先完成第 1 步。

### 3. 云构建

推送到 `main` / `feat-**` / `feat-*` 且改动涉及 `android/**` 或网页资源时自动触发，
也可在 Actions 页面手动运行 `Android APK` workflow。
产物在 workflow 的 Artifacts 中下载（含 apk-sha256.txt）。

## 说明

- **为什么用 WebViewAssetLoader**：以固定域名加载内置页面，
  `localStorage` 的 origin 才稳定，星数、每关布局与工作台快照才能跨重启保留。
- **导出功能**：网页用 Blob URL 导出关卡 JSON，WebView 不支持该下载方式。
  网页端把导出收敛在 `storage.downloadFile()` 一个函数里，该函数检测到 `LightAndroid`
  桥后把文本交给原生写入系统「下载」目录（Android 10+ 走 MediaStore，更低版本写应用外部目录），
  并弹出「已保存到…」提示。**因此外壳不需要拦截 click 的注入脚本。**
- **导入功能**：网页的 `<input type="file">` 由 `onShowFileChooser` 转发到系统文件选择器。
- **触摸操作**：网页全程使用 Pointer Events，触摸端无需额外适配；
  键盘快捷键（数字键、方向键、`Ctrl+Z`）在无物理键盘时不适用，但都有触摸等价路径。
- **旋转与返回键**：Activity 声明 `configChanges`，旋转不重建、状态不丢；
  返回键优先回退网页历史，无历史时退出。
- **图标重新生成**：把新原图放到 `icon-source/`（`icon-full.png`、`icon-foreground.png`），
  再执行 `python tools/make-icons.py`（需要 Pillow）。脚本会先做对称裁剪去掉生成水印。

## 触摸端已知限制

无。游戏交互从第一版起就是 Pointer Events（`pointerdown` / `pointermove`），
不依赖 HTML5 拖放事件，也不依赖键盘，触摸端功能与桌面端一致。
