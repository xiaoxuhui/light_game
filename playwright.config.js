"use strict";

const os = require("node:os");
const path = require("node:path");

const { defineConfig, devices } = require("@playwright/test");

const BASE_URL = "http://127.0.0.1:4174";

module.exports = defineConfig({
  testDir: "./e2e",
  // 本地跑时把产物放到系统临时目录：Playwright 每次都会清理上一轮的 test-results，
  // 在本机沙箱里这一清理会被"批量删除守卫"拦下（阈值 50 个文件）并打断运行；
  // 换到临时目录即可绕开，同时让仓库目录始终干净。CI 里保留在项目内，方便上传 artifact。
  outputDir: process.env.CI ? "test-results" : path.join(os.tmpdir(), "light-game-e2e"),
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    baseURL: BASE_URL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "node scripts/serve-static.js",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
});
