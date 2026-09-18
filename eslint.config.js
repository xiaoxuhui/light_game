// ESLint 扁平配置：只做基础静态检查，不强制代码风格。
// 这些脚本以 <script defer> 顺序加载，跨文件全局在此显式声明，避免 no-undef 误报。
// 每新增一个跨文件全局（如 LightEngine / Renderer），都要补到这里。
// 运行：npm run lint（本地开发用，CI 中作为门禁）
const crossScriptGlobals = {
  LightCore: "readonly",
  LightEngine: "readonly",
  LightLevels: "readonly",
  LightRenderer: "readonly",
  LightStorage: "readonly",
};

module.exports = [
  {
    files: ["scripts/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...crossScriptGlobals,
        globalThis: "readonly",
        __dirname: "readonly",
        module: "readonly",
        require: "readonly",
        window: "readonly",
        document: "readonly",
        console: "readonly",
        process: "readonly",
        performance: "readonly",
        AbortController: "readonly",
        Blob: "readonly",
        URL: "readonly",
        TextEncoder: "readonly",
        HTMLCanvasElement: "readonly",
        ResizeObserver: "readonly",
        devicePixelRatio: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        Intl: "readonly",
        Map: "readonly",
        Set: "readonly",
        Math: "readonly",
        Number: "readonly",
        String: "readonly",
        Object: "readonly",
        Array: "readonly",
        JSON: "readonly",
        Error: "readonly",
        RegExp: "readonly",
        Boolean: "readonly",
        parseInt: "readonly",
        parseFloat: "readonly",
        isNaN: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "warn",
      "no-duplicate-case": "error",
      "no-var": "warn",
      "prefer-const": "warn",
      eqeqeq: ["warn", "smart"],
    },
  },
];
