# 变更日志

本文件记录重要的用户可见变化。版本号遵循语义化版本；发布日期在正式发布时填写。

## [0.1.0] - 2026-09-19

工程骨架建立，尚无可玩玩法。

### Added

- 项目脚手架：单页入口 `index.html`、`styles/main.css`、`scripts/app.js`，纯静态、零运行时依赖，
  可 `file://` 直接打开，也可通过 `npm run serve` 在 127.0.0.1:4174 访问。
- 应用引导层：按 `devicePixelRatio` 初始化画布（封顶 2 倍）、`ResizeObserver` 跟随窗口变化、
  页面隐藏时暂停渲染循环、响应 `prefers-reduced-motion`。
- 待机光晕占位渲染，用于验证画布与渲染链路，玩法定稿后由真实场景替换。
- 工程门禁：ESLint 扁平配置、`node --test` 结构断言、Playwright 浏览器冒烟（桌面 + 移动视口）、
  GitHub Actions CI（Node 20.19 / 22.13 / 24 矩阵 + 浏览器冒烟）。
- 许可证与协作文件：MIT License、贡献指南、行为准则、安全策略、`doc/` 三份规划文档。
- `.gitattributes` 换行规范，为后续安卓构建脚本（`gradlew` 必须 LF）预留。
