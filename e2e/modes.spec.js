"use strict";

const { test, expect } = require("@playwright/test");

async function ready(page) {
  await page.waitForFunction(() => window.__lightGame?.state.layout && !window.__lightGame.state.dirty &&
    (window.__lightGame.state.paused || !window.__lightGame.state.simulationPending));
}

async function openChallenge(page) {
  await page.goto("/");
  await ready(page);
  await page.getByRole("button", { name: "下一关", exact: true }).click();
  await ready(page);
}

async function place(page, type, x, y) {
  const tool = page.locator(`[data-type="${type}"]`);
  if (await tool.getAttribute("aria-pressed") !== "true") await tool.click();
  await clickCell(page, x, y);
}

async function clickCell(page, x, y) {
  await ready(page);
  const point = await page.evaluate(({ x, y }) => {
    const { layout, dpr } = window.__lightGame.state;
    const rect = document.getElementById("stage").getBoundingClientRect();
    return { x: rect.x + (layout.ox + (x + 0.5) * layout.cell) / dpr,
      y: rect.y + (layout.oy + (y + 0.5) * layout.cell) / dpr };
  }, { x, y });
  await page.mouse.click(point.x, point.y);
  await ready(page);
}

test("默认光源可擦除重放，灯泡可输出，无限画布平移缩放和负坐标刷新保留", async ({ page }) => {
  await openChallenge(page);
  await page.getByRole("button", { name: "自由模式", exact: true }).click();
  await place(page, "eraser", 0, 4);
  expect((await board(page)).filter((p) => p.type === "emitter")).toHaveLength(0);
  await place(page, "emitter", 3, 2);
  await place(page, "bulb", 5, 2);
  expect(await page.evaluate(() => window.__lightGame.state.result.targets.find((t) => t.x === 5 && t.y === 2).lit)).toBe(true);
  const before = await board(page);
  await page.getByRole("button", { name: "漫游", exact: true }).click();
  const box = await page.locator("#stage").boundingBox();
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.up();
  expect(await board(page)).toEqual(before);
  const position = await page.evaluate(() => ({ x: Math.floor(window.__lightGame.state.camera.x), y: Math.floor(window.__lightGame.state.camera.y) }));
  expect(position.x).toBeLessThan(0);
  await place(page, "wall", position.x, position.y);
  await page.getByRole("button", { name: "放大画布", exact: true }).click();
  await expect.poll(async () => (await save(page)).freeViews.t02.cell).toBe(45);
  const experiment = await board(page);
  await page.reload(); await ready(page);
  expect(await board(page)).toEqual(experiment);
  expect(await page.evaluate(() => window.__lightGame.state.camera.cell)).toBe(45);
});

test("创建命名芯片，在内部旋转 IO，外部占一格并正确收发光，刷新与文件往返保持", async ({ page }) => {
  await openChallenge(page);
  await page.getByRole("button", { name: "自由模式", exact: true }).click();
  await expect(page.locator('[data-type="inputPort"]')).toHaveCount(0);
  await page.getByRole("button", { name: "清空", exact: true }).click();
  await page.getByRole("button", { name: "确认清空？", exact: true }).click();
  await page.getByRole("button", { name: "芯片库", exact: true }).click();
  await page.getByRole("button", { name: "新建芯片", exact: true }).click();
  await page.getByRole("textbox", { name: "芯片名称", exact: true }).fill("左通");
  await clickCell(page, 0, 0);
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await clickCell(page, 0, 0);
  await expect(page.locator('[data-type="inputPort"]')).toBeVisible();
  for (const x of [2, 0]) {
    await place(page, "inputPort", x, 0);
    for (let i = 0; i < (x === 2 ? 3 : 1); i++) await clickCell(page, x, 0);
  }
  await page.getByRole("button", { name: "保存并返回外层网格", exact: true }).click();
  await page.getByRole("button", { name: "保存并返回实验板", exact: true }).click();
  await expect(page.locator('[data-type="inputPort"]')).toHaveCount(0);
  await page.getByRole("button", { name: "芯片库", exact: true }).click();
  await page.getByRole("button", { name: "放置 左通", exact: true }).click();
  await clickCell(page, 3, 2);
  expect((await board(page)).filter((p) => p.type === "chip")).toHaveLength(1);
  await place(page, "directionalEmitter", 5, 2);
  for (let i = 0; i < 3; i++) await clickCell(page, 5, 2);
  await place(page, "bulb", 1, 2);
  const lit = () => page.evaluate(() => window.__lightGame.state.result.targets[0].lit);
  expect(await lit()).toBe(true);
  await clickCell(page, 3, 2);
  expect(await lit()).toBe(false);
  for (let i = 0; i < 3; i++) await clickCell(page, 3, 2);
  expect(await lit()).toBe(true);
  await page.reload(); await ready(page);
  expect(await lit()).toBe(true);
  expect((await save(page)).chips[0].name).toBe("左通");
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const file = await (await downloaded).path();
  await page.getByRole("button", { name: "关卡模式", exact: true }).click();
  await page.locator("#file-import").setInputFiles(file);
  await expect(page.locator("#btn-mode")).toHaveAttribute("aria-pressed", "true");
  await ready(page);
  expect(await lit()).toBe(true);
});

const board = (page) => page.evaluate(() => window.__lightGame.state.placement);
const optics = (items) => items.filter((p) => ["mirror", "splitter", "prism"].includes(p.type));
const save = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("light-game/save")));

test("棱镜左键旋转后可从右边输入，换色不转输入面，撤销及刷新保留输入朝向", async ({ page }) => {
  await openChallenge(page);
  await page.getByRole("button", { name: "自由模式", exact: true }).click();
  await page.getByRole("button", { name: "清空", exact: true }).click();
  await page.getByRole("button", { name: "确认清空？", exact: true }).click();
  await place(page, "directionalEmitter", 5, 2);
  for (let i = 0; i < 3; i++) await clickCell(page, 5, 2);
  await place(page, "bulb", 1, 2);
  await place(page, "prism", 3, 2);
  const input = () => page.evaluate(() => window.__lightGame.state.result.targets[0].incoming);
  expect(await input()).toBe(0);
  await clickCell(page, 3, 2);
  expect(await input()).toBe(0);
  await clickCell(page, 3, 2);
  expect(await input()).toBe(2);
  await page.getByRole("button", { name: "棱镜换色", exact: true }).click();
  expect(await page.evaluate(() => window.__lightGame.state.result.targets[0].rawIncoming)).toBe(4);
  await ready(page);
  expect(await input()).toBe(4);
  expect((await board(page)).find((p) => p.type === "prism")).toMatchObject({ facing: 2, orient: 1 });
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await ready(page);
  expect(await input()).toBe(2);
  await page.reload(); await ready(page);
  expect(await input()).toBe(2);
  expect((await board(page)).find((p) => p.type === "prism")).toMatchObject({ facing: 2, orient: 0 });
});

test("芯片库删除可取消、可撤销，确认后清理其他实验板和工作台引用，刷新不复活", async ({ page }) => {
  await page.goto("/"); await ready(page);
  await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem("light-game/save"));
    const a = { type: "chip", chipId: "delete-me", x: 2, y: 2, orient: 0 };
    const b = { type: "chip", chipId: "keep-me", x: 3, y: 2, orient: 0 };
    const mirror = { type: "mirror", x: 1, y: 1, orient: 0 };
    data.chips = [{ id: "delete-me", name: "待删", placement: [] }, { id: "keep-me", name: "保留", placement: [] }];
    data.freeBoards = { t02: [a, b, mirror], t03: [a] };
    data.freeBoardVersions = { t02: 2, t03: 2 };
    data.session = { levelId: "t02", mode: "free" };
    data.snapshots = [{ name: "混合布局", levelId: "free:t02", sceneVersion: 2, placement: [a, mirror] }];
    localStorage.setItem("light-game/save", JSON.stringify(data));
  });
  await page.reload(); await ready(page);
  const original = await board(page);
  await page.getByRole("button", { name: "芯片库", exact: true }).click();
  await page.getByRole("button", { name: "删除 待删", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("2 个实例");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect((await save(page)).chips).toHaveLength(2);
  expect(await board(page)).toEqual(original);
  await page.getByRole("button", { name: "删除 待删", exact: true }).click();
  await page.getByRole("button", { name: "确认删除芯片", exact: true }).click();
  await expect(page.getByRole("button", { name: "删除 待删", exact: true })).toHaveCount(0);
  expect((await board(page)).some((p) => p.chipId === "delete-me")).toBe(false);
  expect((await save(page)).freeBoards.t03).toEqual([]);
  expect((await save(page)).snapshots[0].placement).toEqual([{ type: "mirror", x: 1, y: 1, orient: 0 }]);
  await page.getByRole("button", { name: "撤销删除芯片", exact: true }).click();
  expect(await board(page)).toEqual(original);
  expect((await save(page)).freeBoards.t03).toHaveLength(1);
  await expect(page.getByRole("button", { name: "删除 待删", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "删除 待删", exact: true }).click();
  await page.getByRole("button", { name: "确认删除芯片", exact: true }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.reload(); await ready(page);
  expect((await save(page)).chips.map((chip) => chip.name)).toEqual(["保留"]);
  expect((await board(page)).filter((p) => p.type === "chip").map((p) => p.chipId)).toEqual(["keep-me"]);
});

test("自由与关卡双向切换，独立存档、刷新恢复及清空后仍保留空布局", async ({ page }) => {
  await openChallenge(page);
  await place(page, "mirror", 1, 1);
  const original = await board(page);
  await page.getByRole("button", { name: "自由模式", exact: true }).click();
  expect(optics(await board(page))).toEqual(original);
  await place(page, "prism", 2, 2);
  const experiment = await board(page);
  await page.getByRole("button", { name: "关卡模式", exact: true }).click();
  expect(await board(page)).toEqual(original);
  await page.getByRole("button", { name: "自由模式", exact: true }).click();
  expect(await board(page)).toEqual(experiment);
  await page.reload();
  await ready(page);
  await expect(page.getByRole("button", { name: "关卡模式", exact: true })).toBeVisible();
  expect(await board(page)).toEqual(experiment);
  await page.getByRole("button", { name: "清空", exact: true }).click();
  await page.getByRole("button", { name: "确认清空？", exact: true }).click();
  await page.getByRole("button", { name: "关卡模式", exact: true }).click();
  await page.getByRole("button", { name: "自由模式", exact: true }).click();
  expect(await board(page)).toEqual([]);
  expect((await save(page)).boards.t02).toEqual(original);
});

test("自由解题不计星，应用回关卡才通关，且可撤销应用", async ({ page }) => {
  await openChallenge(page);
  await page.getByRole("button", { name: "自由模式", exact: true }).click();
  await place(page, "mirror", 6, 4);
  expect(await page.evaluate(() => window.__lightGame.state.result.allLit)).toBe(true);
  expect((await save(page)).stars.t02).toBeUndefined();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.locator("#btn-next")).toBeHidden();
  await page.getByRole("button", { name: "应用到关卡", exact: true }).click();
  await expect(page.getByRole("heading", { name: "通关", exact: true })).toBeVisible();
  expect((await save(page)).stars.t02).toBe(3);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  expect(await board(page)).toEqual([]);
});

test("超配额布局拒绝带回且不丢数据，自由模式可通过关卡列表返回", async ({ page }) => {
  await openChallenge(page);
  await page.getByRole("button", { name: "自由模式", exact: true }).click();
  await place(page, "prism", 2, 2);
  const experiment = await board(page);
  await page.getByRole("button", { name: "应用到关卡", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("超出关卡配额");
  expect(await board(page)).toEqual(experiment);
  expect((await save(page)).boards.t02).toBeUndefined();
  await page.getByRole("button", { name: "知道了", exact: true }).click();
  await page.getByRole("button", { name: "关卡", exact: true }).click();
  await page.getByRole("button", { name: "第一束光" }).click();
  await expect(page.getByRole("button", { name: "自由模式", exact: true })).toBeVisible();
  expect((await save(page)).freeBoards.t02).toEqual(experiment);
});

test("关卡复制到已有自由布局，替换可撤销，两边布局保持独立", async ({ page }) => {
  await openChallenge(page);
  await place(page, "mirror", 1, 1);
  const original = await board(page);
  await page.getByRole("button", { name: "自由模式", exact: true }).click();
  const freeOriginal = await board(page);
  await place(page, "splitter", 2, 2);
  const experiment = await board(page);
  await page.getByRole("button", { name: "从关卡复制", exact: true }).click();
  await page.getByRole("button", { name: "复制布局", exact: true }).click();
  expect(await board(page)).toEqual(freeOriginal);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  expect(await board(page)).toEqual(experiment);
  expect((await save(page)).boards.t02).toEqual(original);
});

test("白光四向光源和墙可放置、擦除、撤销，刷新后与导入后保持一致", async ({ page }) => {
  await openChallenge(page);
  await page.getByRole("button", { name: "自由模式", exact: true }).click();
  await expect(page.getByRole("button", { name: "四面光源 不限", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "墙壁 不限", exact: true })).toBeVisible();
  await expect(page.locator('[data-type="eraser"]')).toBeVisible();
  expect(await page.evaluate(() => window.__lightGame.state.result.grid.cells.filter((c) => c?.type === "emitter")
    .every((c) => c.omni && c.color === 7))).toBe(true);
  await place(page, "emitter", 3, 2);
  const rays = () => page.evaluate(() => window.__lightGame.state.result.segments
    .filter((s) => s.from.x === 3 && s.from.y === 2));
  expect((await rays()).length).toBe(4);
  expect((await rays()).every((s) => s.color === 7)).toBe(true);
  await place(page, "wall", 4, 2);
  const experiment = await board(page);
  await place(page, "eraser", 4, 2);
  expect((await board(page)).some((p) => p.type === "wall")).toBe(false);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  expect(await board(page)).toEqual(experiment);
  await page.reload();
  await ready(page);
  expect(await board(page)).toEqual(experiment);
  expect((await rays()).length).toBe(4);
  // 文件往返经过真实的下载、上传路径，验证自由模式文件不会进入关卡计星流程。
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出", exact: true }).click();
  const filePath = await (await downloaded).path();
  await page.getByRole("button", { name: "关卡模式", exact: true }).click();
  await page.locator("#file-import").setInputFiles(filePath);
  await expect(page.locator("#btn-mode")).toHaveAttribute("aria-pressed", "true");
  expect(await board(page)).toEqual(experiment);
  await place(page, "eraser", 3, 2);
  expect((await rays()).length).toBe(0);
  await page.getByRole("button", { name: "关卡模式", exact: true }).click();
  expect(await board(page)).toEqual([]);
  await expect(page.locator('[data-type="emitter"]')).toHaveCount(0);
});
