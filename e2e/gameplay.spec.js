"use strict";

// 玩法验收：对应 doc/需求与测试用例.md 的 U01 / U02 / U03 / U09。
// 跑在真实浏览器里，桌面与移动两个项目各跑一遍（见 playwright.config.js）。
//
// 交互一律走真实输入（键盘、指针），不直接调内部函数改状态 ——
// 否则测的就不是玩家真正走的路径了。

const fs = require("node:fs");

const { expect, test } = require("@playwright/test");

/** 等待渲染循环画完一帧（dirty 由 true 落回 false） */
async function settle(page) {
  await page.waitForFunction(() => {
    const game = window.__lightGame;
    return Boolean(game) && game.state.layout !== null && game.state.result !== null && game.state.dirty === false;
  });
}

async function openLevel(page, id) {
  await page.goto("/");
  await settle(page);
  await page.evaluate((levelId) => window.__lightGame.selectLevel(levelId), id);
  await settle(page);
}

async function readState(page) {
  return page.evaluate(() => {
    const state = window.__lightGame.state;
    return {
      levelId: state.levelId,
      allLit: state.result ? state.result.allLit : null,
      placedCount: state.result ? state.result.placedCount : null,
      segments: state.result ? state.result.segments.length : 0,
      overlayOpen: !document.getElementById("overlay").hidden,
      title: document.getElementById("level-title").textContent,
      stars: document.getElementById("level-stars").textContent,
      hint: document.getElementById("level-hint").textContent,
    };
  });
}

/** 格坐标 → 页面上可点击的 CSS 像素点 */
async function pointOf(page, cellX, cellY) {
  const metrics = await page.evaluate(() => {
    const layout = window.__lightGame.state.layout;
    return {
      cell: layout.cell,
      ox: layout.ox,
      oy: layout.oy,
      dpr: window.__lightGame.state.dpr,
    };
  });
  const box = await page.locator("#stage").boundingBox();

  return {
    x: box.x + (metrics.ox + (cellX + 0.5) * metrics.cell) / metrics.dpr,
    y: box.y + (metrics.oy + (cellY + 0.5) * metrics.cell) / metrics.dpr,
  };
}

// ---------- U01 ----------

test("U01 打开页面即进入可玩状态，且不发起任何外部请求", async ({ page }) => {
  const external = [];
  page.on("request", (request) => {
    const url = request.url();
    const isLocal =
      url.startsWith("http://127.0.0.1:4174") ||
      url.startsWith("data:") ||
      url.startsWith("blob:") ||
      url.startsWith("about:");
    if (!isLocal) external.push(url);
  });

  await page.goto("/");
  await settle(page);

  const state = await readState(page);
  expect(state.levelId).toBe("t01");
  expect(state.title).toBe("第一束光");
  expect(state.segments).toBeGreaterThan(0);
  expect(state.allLit).toBe(true);
  expect(state.overlayOpen).toBe(false);
  expect(state.hint.length).toBeGreaterThan(0);
  expect(external).toEqual([]);
});

// ---------- U02 键盘 ----------

test("U02 只用键盘就能选元件、移动光标、放置并通关", async ({ page }) => {
  await openLevel(page, "t02");
  expect((await readState(page)).allLit).toBe(false);

  await page.keyboard.press("1"); // 选中唯一的可用元件：反射镜
  for (let i = 0; i < 6; i += 1) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < 4; i += 1) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await settle(page);

  const state = await readState(page);
  expect(state.placedCount).toBe(1);
  expect(state.allLit).toBe(true);
  expect(state.overlayOpen).toBe(true);
  expect(state.stars).toBe("★★★");
});

test("U02 按 R 旋转元件能改变光路（分光镜关卡）", async ({ page }) => {
  await openLevel(page, "t03");

  await page.keyboard.press("1"); // 分光镜
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await settle(page);

  expect((await readState(page)).allLit).toBe(false, "默认朝向的光分不出第二束光");

  await page.keyboard.press("R");
  await settle(page);

  const state = await readState(page);
  expect(state.allLit).toBe(true, "旋转一次后两束光分别命中两个目标");
  expect(state.overlayOpen).toBe(true);
});

test("U02 Delete 键能删掉光标处的元件", async ({ page }) => {
  await openLevel(page, "t02");

  await page.keyboard.press("1");
  for (let i = 0; i < 6; i += 1) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < 4; i += 1) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await settle(page);
  expect((await readState(page)).placedCount).toBe(1);

  await page.keyboard.press("Escape"); // 先关掉通关浮层
  await page.keyboard.press("Delete");
  await settle(page);

  const state = await readState(page);
  expect(state.placedCount).toBe(0);
  expect(state.allLit).toBe(false);
});

// ---------- U02 指针 ----------

test("U02 指针点击能放置、旋转、再用橡皮删除", async ({ page }) => {
  await openLevel(page, "t02");

  await page.locator("#toolbar .tool").first().click();
  const point = await pointOf(page, 6, 4);

  await page.mouse.click(point.x, point.y);
  await settle(page);
  let state = await readState(page);
  expect(state.placedCount).toBe(1);
  expect(state.allLit).toBe(true);

  // 通关浮层会盖住画布，先关掉再做后续操作
  await page.keyboard.press("Escape");

  // 再点同一格 → 旋转 90°，不再是解
  await page.mouse.click(point.x, point.y);
  await settle(page);
  state = await readState(page);
  expect(state.placedCount).toBe(1);
  expect(state.allLit).toBe(false);

  // 橡皮删除
  await page.locator('#toolbar .tool[data-type="eraser"]').click();
  await page.mouse.click(point.x, point.y);
  await settle(page);
  state = await readState(page);
  expect(state.placedCount).toBe(0);
});

test("U02 点击关卡预设的元件不会把它覆盖掉", async ({ page }) => {
  await openLevel(page, "t02");

  await page.locator("#toolbar .tool").first().click();
  const emitter = await pointOf(page, 0, 4); // 光源所在格
  await page.mouse.click(emitter.x, emitter.y);
  await settle(page);

  const state = await readState(page);
  expect(state.placedCount).toBe(0, "预设元件格不应接受放置");
});

// ---------- U09 ----------

test("U09 窄屏下工具栏完整可点，画布仍可交互", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openLevel(page, "t04");

  const tools = page.locator("#toolbar .tool");
  await expect(tools).toHaveCount(2); // 红二向色镜 + 橡皮
  await expect(tools.nth(0)).toBeVisible();
  await expect(tools.nth(1)).toBeVisible();
  await expect(page.locator("#stage")).toBeVisible();
  await expect(page.locator("#level-hint")).toBeVisible();

  await tools.nth(0).click();
  const point = await pointOf(page, 3, 3);
  await page.mouse.click(point.x, point.y);
  await settle(page);

  const state = await readState(page);
  expect(state.allLit).toBe(true);
});

// ---------- 通关反馈与关卡推进 ----------

test("U01 教学第 1 关进关即通关，不弹浮层但给出常驻的下一关入口", async ({ page }) => {
  await page.goto("/");
  await settle(page);

  const state = await readState(page);
  expect(state.levelId).toBe("t01");
  expect(state.allLit).toBe(true);
  expect(state.overlayOpen).toBe(false); // 静默通关：不打断玩家看图

  await expect(page.locator("#level-status")).toContainText("已通关");
  await expect(page.locator("#btn-next")).toBeEnabled();
  // 这一关一个元件都不发，工具栏应为空，而不是只剩一个永远禁用的橡皮
  await expect(page.locator("#toolbar .tool")).toHaveCount(0);

  await page.locator("#btn-next").click();
  await settle(page);
  expect((await readState(page)).levelId).toBe("t02");
});

test("U01 结算浮层被关掉后，仍能从顶栏进入下一关", async ({ page }) => {
  await openLevel(page, "t02");

  await page.locator("#toolbar .tool").first().click();
  const point = await pointOf(page, 6, 4);
  await page.mouse.click(point.x, point.y);
  await settle(page);
  expect((await readState(page)).overlayOpen).toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.locator("#overlay")).toBeHidden();
  await expect(page.locator("#level-status")).toContainText("已通关");
  await expect(page.locator("#btn-next")).toBeEnabled();

  await page.locator("#btn-next").click();
  await settle(page);
  expect((await readState(page)).levelId).toBe("t03");
});

// ---------- U07 撤销 / 重做 ----------

/** 用键盘在 t02 放一面能通关的镜子 */
async function placeSolvingMirror(page) {
  await page.keyboard.press("1");
  for (let i = 0; i < 6; i += 1) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < 4; i += 1) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await settle(page);
}

test("U07 撤销与重做按钮按操作序列回退与前进", async ({ page }) => {
  await openLevel(page, "t02");

  const undo = page.locator("#btn-undo");
  const redo = page.locator("#btn-redo");
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();

  await placeSolvingMirror(page);
  expect((await readState(page)).placedCount).toBe(1);
  await page.keyboard.press("Escape");

  await expect(undo).toBeEnabled();
  await undo.click();
  await settle(page);
  let state = await readState(page);
  expect(state.placedCount).toBe(0);
  expect(state.allLit).toBe(false);
  await expect(redo).toBeEnabled();

  await redo.click();
  await settle(page);
  state = await readState(page);
  expect(state.placedCount).toBe(1);
  expect(state.allLit).toBe(true);
});

test("U07 Ctrl+Z 与 Ctrl+Shift+Z 走同一条撤销重做路径", async ({ page }) => {
  await openLevel(page, "t02");
  await placeSolvingMirror(page);
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+z");
  await settle(page);
  expect((await readState(page)).placedCount).toBe(0);

  await page.keyboard.press("Control+Shift+z");
  await settle(page);
  const state = await readState(page);
  expect(state.placedCount).toBe(1);
  expect(state.allLit).toBe(true);
});

test("U07 新操作会砍掉原来的重做分支", async ({ page }) => {
  await openLevel(page, "t02");

  await page.locator("#toolbar .tool").first().click();
  const solving = await pointOf(page, 6, 4);
  await page.mouse.click(solving.x, solving.y);
  await settle(page);
  expect((await readState(page)).placedCount).toBe(1);
  await page.keyboard.press("Escape");

  await page.locator("#btn-undo").click();
  await settle(page);
  expect((await readState(page)).placedCount).toBe(0);
  await expect(page.locator("#btn-redo")).toBeEnabled();

  // 撤销之后换个位置再放一个元件，重做链应当作废
  const elsewhere = await pointOf(page, 6, 3);
  await page.mouse.click(elsewhere.x, elsewhere.y);
  await settle(page);

  expect((await readState(page)).placedCount).toBe(1);
  await expect(page.locator("#btn-redo")).toBeDisabled();
});

// ---------- 清空确认 ----------

test("U02 清空要点两次才生效，第一次只切换到确认态", async ({ page }) => {
  await openLevel(page, "t02");
  await placeSolvingMirror(page);
  await page.keyboard.press("Escape");

  const clear = page.locator("#btn-clear");
  await clear.click();
  await expect(clear).toHaveText("确认清空？");
  expect((await readState(page)).placedCount).toBe(1, "第一次点击不该真的清空");

  await clear.click();
  await settle(page);
  expect((await readState(page)).placedCount).toBe(0);
  await expect(clear).toHaveText("清空");
});

// ---------- 关卡导航 ----------

test("关卡列表能切换到已解锁的关卡，未解锁的不可点", async ({ page }) => {
  await page.goto("/");
  await settle(page);

  await page.locator("#btn-levels").click();
  const items = page.locator("#sheet-body .level-item");
  await expect(items).toHaveCount(16);

  // 第 1 关进关即通关，所以第 2 关在开局就应解锁；第 3 关起仍锁着
  await expect(items.nth(0)).toBeEnabled();
  await expect(items.nth(1)).toBeEnabled();
  await expect(items.nth(2)).toBeDisabled();
  await expect(items.nth(3)).toBeDisabled();

  await items.nth(0).click();
  await settle(page);
  expect((await readState(page)).levelId).toBe("t01");
});

test("清空按钮只有在放了元件后才可用，且需要二次确认", async ({ page }) => {
  await openLevel(page, "t02");

  const clear = page.locator("#btn-clear");
  await expect(clear).toBeDisabled();

  await placeSolvingMirror(page);
  await expect(clear).toBeEnabled();
  await page.keyboard.press("Escape");

  await clear.click();
  expect((await readState(page)).placedCount).toBe(1, "第一次点击只是确认，不该真的清空");
  await clear.click();
  await settle(page);

  expect((await readState(page)).placedCount).toBe(0);
});

// ---------- U03 离线 ----------

test("U03 拦掉一切外部请求后，玩法与联网时完全一致", async ({ page }) => {
  const blocked = [];
  await page.route("**/*", (route) => {
    const url = route.request().url();
    const isLocal =
      url.startsWith("http://127.0.0.1:4174") || url.startsWith("data:") || url.startsWith("blob:");
    if (isLocal) {
      route.continue();
      return;
    }
    blocked.push(url);
    route.abort();
  });

  await page.goto("/");
  await settle(page);
  await openLevel(page, "t02");

  await page.locator("#toolbar .tool").first().click();
  const point = await pointOf(page, 6, 4);
  await page.mouse.click(point.x, point.y);
  await settle(page);

  const state = await readState(page);
  expect(state.allLit).toBe(true);
  expect(state.overlayOpen).toBe(true);
  expect(blocked).toEqual([], "页面不应请求任何外部资源");
});

// ---------- U08 存档 ----------

test("U08 通关成绩写入存档，刷新页面后仍在", async ({ page }) => {
  await openLevel(page, "t02");
  await placeSolvingMirror(page);
  await settle(page);
  expect((await readState(page)).overlayOpen).toBe(true);

  await page.reload();
  await settle(page);

  await page.locator("#btn-levels").click();
  await expect(page.locator("#sheet-body .level-item").nth(1)).toContainText("★★★");
  await expect(page.locator("#sheet-body .level-item").nth(0)).toContainText("★★★");
});

test("U08 关卡的元件布局会被自动存下来，重新进关即恢复", async ({ page }) => {
  await openLevel(page, "t02");

  await page.locator("#toolbar .tool").first().click();
  const point = await pointOf(page, 1, 1);
  await page.mouse.click(point.x, point.y);
  await settle(page);
  expect((await readState(page)).placedCount).toBe(1);

  await page.reload();
  await settle(page);
  await openLevel(page, "t02");

  expect((await readState(page)).placedCount).toBe(1, "重新进入关卡时应恢复上次的布局");
});

// ---------- U10 / U11 导入导出 ----------

test("U10 导出的关卡文件重新导入后，布局与元件朝向完全一致", async ({ page }) => {
  await openLevel(page, "t03");

  // 摆一个带朝向信息的布局：放一个分光镜再转 90°
  await page.locator("#toolbar .tool").first().click();
  const spot = await pointOf(page, 2, 2);
  await page.mouse.click(spot.x, spot.y);
  await settle(page);
  await page.keyboard.press("Escape");
  await page.mouse.click(spot.x, spot.y);
  await settle(page);

  const before = await page.evaluate(() => window.__lightGame.state.placement);
  expect(before.length).toBe(1);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#btn-export").click(),
  ]);
  const text = fs.readFileSync(await download.path(), "utf8");

  // 清空之后再把文件导回来。
  // 这里不能按 Escape：此时既没开浮层也没选中元件，Escape 会打开关卡列表把底栏盖住。
  const clear = page.locator("#btn-clear");
  await clear.click();
  await clear.click();
  await settle(page);
  expect((await readState(page)).placedCount).toBe(0);

  await page.locator("#file-import").setInputFiles({
    name: "t03.json",
    mimeType: "application/json",
    buffer: Buffer.from(text, "utf8"),
  });
  await settle(page);

  const after = await page.evaluate(() => window.__lightGame.state.placement);
  expect(after).toEqual(before);
});

test("U11 导入被篡改的文件时给出错误提示，且不改变当前关卡", async ({ page }) => {
  await openLevel(page, "t02");

  await page.locator("#file-import").setInputFiles({
    name: "broken.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({ schema: "light-game/level", version: 1, id: "x", cols: 999 }),
      "utf8",
    ),
  });
  await settle(page);

  await expect(page.locator("#sheet-title")).toHaveText(/导入失败/);
  await expect(page.locator("#sheet-body .error-list li").first()).toBeVisible();

  await page.keyboard.press("Escape");
  await settle(page);
  expect((await readState(page)).levelId).toBe("t02", "被拒的导入不该切换关卡");
  expect((await readState(page)).placedCount).toBe(0);
});

// ---------- 工作台快照 ----------

test("U08 工作台可以保存当前布局并重新载入", async ({ page }) => {
  await openLevel(page, "t02");

  await page.locator("#toolbar .tool").first().click();
  const point = await pointOf(page, 1, 1);
  await page.mouse.click(point.x, point.y);
  await settle(page);

  await page.locator("#btn-snapshots").click();
  await page.locator("#sheet-actions .btn", { hasText: "保存当前布局" }).click();
  await page.locator("#snapshot-name").fill("试一下");
  await page.locator("#sheet-actions .btn", { hasText: "保存" }).click();

  await expect(page.locator('#sheet-body [data-snapshot="试一下"]')).toBeVisible();

  // 换个布局，再把快照载回来
  await page.keyboard.press("Escape");
  const clear = page.locator("#btn-clear");
  await clear.click();
  await clear.click();
  await settle(page);
  expect((await readState(page)).placedCount).toBe(0);

  await page.locator("#btn-snapshots").click();
  await page.locator('#sheet-body [data-snapshot="试一下"]').click();
  await settle(page);

  expect((await readState(page)).placedCount).toBe(1);
});
