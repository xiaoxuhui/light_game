"use strict";

// 浏览器冒烟：验证「页面能开、画布能画、控制台干净、窗口变化不炸」。
// 桌面与移动两个项目都会跑（见 playwright.config.js）。
// 玩法相关的验收用例待需求确定后另开 spec，不要往这里堆。

const { expect, test } = require("@playwright/test");
const { version } = require("../package.json");

test("页面加载成功，标题与版本正确", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/光的游戏/);
  await expect(page.locator("[data-app-version]")).toHaveText(`v${version}`);
  await expect(page.locator("#stage")).toBeVisible();
});

test("画布按设备像素比初始化，且已绘制内容", async ({ page }) => {
  await page.goto("/");

  const canvas = page.locator("#stage");
  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();
  expect(box.width).toBeGreaterThan(80);
  expect(box.height).toBeGreaterThan(80);

  const metrics = await canvas.evaluate((element) => ({
    width: element.width,
    height: element.height,
    dpr: window.devicePixelRatio,
  }));

  expect(metrics.width).toBeGreaterThan(0);
  expect(metrics.height).toBeGreaterThan(0);
  // 后备缓冲应等于 CSS 尺寸 × dpr（dpr 封顶 2），允许 1px 取整误差
  expect(Math.abs(metrics.width - box.width * Math.min(metrics.dpr, 2))).toBeLessThanOrEqual(1);
});

test("待机场景真的画出了非背景像素", async ({ page }) => {
  await page.goto("/");
  // 等两帧，确保渲染循环已经跑起来
  await page.waitForTimeout(300);

  const centerPixel = await page.locator("#stage").evaluate((element) => {
    const ctx = element.getContext("2d");
    const data = ctx.getImageData(
      Math.floor(element.width / 2),
      Math.floor(element.height / 2),
      1,
      1,
    ).data;
    return { r: data[0], g: data[1], b: data[2] };
  });

  // 画布中心是暖色光核，不应仍是深色背景 #08090c
  expect(centerPixel.r).toBeGreaterThan(120);
});

test("窗口尺寸变化后画布跟随重算", async ({ page }) => {
  await page.goto("/");
  const canvas = page.locator("#stage");

  const before = await canvas.evaluate((element) => element.width);
  await page.setViewportSize({ width: 900, height: 640 });
  await page.waitForTimeout(200);
  const after = await canvas.evaluate((element) => element.width);

  expect(after).toBeGreaterThan(0);
  expect(after).not.toBe(before);
});

test("运行期间控制台无报错", async ({ page }) => {
  const problems = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });

  await page.goto("/");
  await page.waitForTimeout(400);
  await page.setViewportSize({ width: 480, height: 800 });
  await page.waitForTimeout(200);

  expect(problems).toEqual([]);
});

test("调试手柄可用", async ({ page }) => {
  await page.goto("/");

  const hasHandle = await page.evaluate(() => typeof window.__lightGame === "object");
  expect(hasHandle).toBe(true);

  const stopped = await page.evaluate(() => {
    window.__lightGame.stop();
    return window.__lightGame.state.running;
  });
  expect(stopped).toBe(false);

  const restarted = await page.evaluate(() => {
    window.__lightGame.start();
    return window.__lightGame.state.running;
  });
  expect(restarted).toBe(true);
});
