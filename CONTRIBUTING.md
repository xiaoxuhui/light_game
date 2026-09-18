# 贡献指南

感谢你改进光的游戏。项目坚持零运行时依赖、可直接双击 `index.html` 打开、玩法与渲染分离，
以及可验证的小步提交。

## 开发环境

- Node.js 20.19 或更高版本
- npm（使用仓库中的 `package-lock.json`）
- 一个支持 Canvas、Pointer Events 和本地存储的现代浏览器

```powershell
npm ci
npm run check
npm run lint
npm test
```

## 修改流程

1. 先阅读 `doc/需求与测试用例.md`、`doc/设计文档.md` 和相关测试。
2. 对行为变化补充验收条件；修复缺陷时先添加能复现问题的测试。
3. 每个提交只处理一个逻辑单元，使用 `feat:`、`fix:`、`refactor:`、`test:`、`docs:`、`ci:` 或 `chore:` 前缀。
4. 保持零运行时依赖：不引入打包器、ES Module 或需要服务器才能运行的结构。
5. 完成后运行全部质量命令，并在 `file://` 页面检查相关交互。

## 模块边界

骨架阶段只有两个脚本，玩法实现后按下表继续拆分：

| 文件 | 职责 |
|---|---|
| `scripts/app.js` | 应用引导、画布与渲染循环、输入与舞台协调 |
| `scripts/serve-static.js` | 本地静态服务（仅开发与测试用，不属于应用） |

新增脚本一律放在 `scripts/` 下并用 `<script defer>` 按依赖顺序加载；
每新增一个跨文件全局，必须同步补进 `eslint.config.js` 的 `crossScriptGlobals`，否则 `npm run lint` 会报 `no-undef`。

不要把玩法规则复制进渲染层，也不要用期望真值代替真实计算过程。

## 为将来打包 APK 预留的约束

以下限制现在就要遵守，否则阶段二打包时会返工：

- 资源引用一律相对路径，禁止 `/xxx` 绝对路径。
- 不使用 `type="module"`。
- 不使用 HTML5 拖放（`dragover` / `drop`）承载交互，用 Pointer Events。
- 文件导出集中到一个可替换的下载函数里，便于安卓端改用 JS 桥。

## Pull Request 检查

- [ ] 变更范围和动机清楚
- [ ] 自动化测试覆盖新增或修复的行为
- [ ] `npm run check`、`npm run lint`、`npm test` 全部通过
- [ ] 涉及界面时完成桌面与窄屏浏览器检查
- [ ] 没有提交 `node_modules`、临时文件或个人数据
- [ ] 用户可见变化已更新 README、CHANGELOG 或测试报告

提交贡献即表示你有权按本项目 MIT License 提供这些内容，并同意它们按同一许可证分发。
