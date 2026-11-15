"use strict";
const { test, expect } = require("@playwright/test");

async function frame(page) {
  await page.waitForFunction(() => window.__lightGame?.state.layout && !window.__lightGame.state.dirty);
}
async function click(page, x, y, button = "left") {
  await frame(page);
  const point = await page.evaluate(({ x, y }) => {
    const { layout, dpr } = window.__lightGame.state;
    const box = document.getElementById("stage").getBoundingClientRect();
    return { x: box.x + (layout.ox + (x + 0.5) * layout.cell) / dpr,
      y: box.y + (layout.oy + (y + 0.5) * layout.cell) / dpr };
  }, { x, y });
  await page.mouse.click(point.x, point.y, { button }); await frame(page);
}
async function tool(page, type) {
  const button = page.locator('[data-type="' + type + '"]');
  if (await button.getAttribute("aria-pressed") !== "true") await button.click();
}
async function fixture(page, chips = [], placement = []) {
  await page.goto("/"); await frame(page);
  await page.evaluate(({ chips, placement }) => {
    const save = JSON.parse(localStorage.getItem("light-game/save"));
    Object.assign(save, { chips, freeBoards: { t02: placement }, freeBoardVersions: { t02: 2 },
      freeViews: { t02: { x: 3, y: 2, cell: 32 } }, session: { levelId: "t02", mode: "free" } });
    localStorage.setItem("light-game/save", JSON.stringify(save));
  }, { chips, placement });
  await page.reload(); await frame(page);
  await page.getByRole("button", { name: "暂停（空格）", exact: true }).click();
}

test("创建进入独立无限网格，点击翻转，下一步后独立设计各格并可最后命名", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "芯片库", exact: true }).click();
  await page.getByRole("button", { name: "新建芯片", exact: true }).click();
  await expect(page.locator("#level-title")).toHaveText("绘制芯片形状");
  await expect(page.getByRole("button", { name: "下一步", exact: true })).toBeDisabled();
  await expect(page.getByRole("spinbutton", { name: "外观宽度", exact: true })).toHaveCount(0);
  await expect(page.locator("#toolbar")).toBeHidden();
  for (const [x, y] of [[0, 0], [1, 0], [0, 1]]) await click(page, x, y);
  await click(page, 1, 0);
  expect(await page.evaluate(() => window.__lightGame.state.placement.length)).toBe(2);
  await click(page, 1, 0);
  await expect(page.locator("#level-title")).toHaveText("绘制芯片形状");
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await expect(page.locator("#level-title")).toContainText("外层网格");
  await click(page, 0, 0);
  await expect(page.locator("#level-title")).toContainText("编辑格子 (0,0)");
  await tool(page, "inputPort"); await click(page, 2, 2); await click(page, 2, 2);
  await tool(page, "mirror"); await click(page, 4, 2); await click(page, 4, 2);
  await tool(page, "inputPort"); await click(page, 4, 3);
  await page.getByRole("button", { name: "本格外观", exact: true }).click();
  await page.getByRole("textbox", { name: "格子文字", exact: true }).fill("钟");
  await page.getByRole("checkbox", { name: "绿色朝上箭头", exact: true }).check();
  await page.getByRole("button", { name: "应用本格外观", exact: true }).click();
  await page.getByRole("button", { name: "保存并返回外层网格", exact: true }).click();
  await click(page, 0, 1);
  expect(await page.evaluate(() => window.__lightGame.state.placement)).toEqual([]);
  await tool(page, "inputPort"); await click(page, 3, 1); await click(page, 3, 1); await click(page, 3, 1);
  await tool(page, "mirror"); await click(page, 3, 3); await click(page, 3, 3);
  await tool(page, "inputPort"); await click(page, 4, 3); await click(page, 4, 3); await click(page, 4, 3); await click(page, 4, 3);
  await page.getByRole("button", { name: "保存并返回外层网格", exact: true }).click();
  await page.locator("#chip-name").fill("大 L 时钟");
  await page.getByRole("button", { name: "保存并返回实验板", exact: true }).click();
  await page.getByRole("button", { name: "芯片库", exact: true }).click();
  await page.getByRole("button", { name: "放置 大 L 时钟", exact: true }).click(); await click(page, 3, 2);
  await tool(page, "directionalEmitter"); await click(page, 0, 2); await click(page, 0, 2);
  await tool(page, "bulb"); await click(page, 6, 2); await click(page, 6, 3);
  await page.keyboard.press("N"); await frame(page);
  expect(await page.evaluate(() => window.__lightGame.state.result.targets.map((target) => target.rawIncoming))).toEqual([0, 7]);
  await page.keyboard.press("N"); await frame(page);
  expect(await page.evaluate(() => window.__lightGame.state.result.targets.map((target) => target.lit))).toEqual([false, true]);
  expect(await page.evaluate(() => window.__lightGame.state.result.grid.byPosition.has("4,3"))).toBe(false);
  await click(page, 4, 2, "middle");
  await click(page, 0, 0, "middle");
  await expect(page.locator("#level-title")).toHaveText("运行过程 · 格 0,0");
  expect(await page.evaluate(() => window.__lightGame.state.result.grid.cells.find((cell) => cell.type === "inputPort" && cell.x === 4 && cell.y === 3).outputColor)).toBe(7);
  await page.getByRole("button", { name: "返回上层芯片", exact: true }).click();
  await page.getByRole("button", { name: "返回实验板", exact: true }).click();
  await click(page, 4, 2);
  expect(await page.evaluate(() => window.__lightGame.state.placement.find((cell) => cell.type === "chip").orient)).toBe(1);
  await click(page, 2, 2, "right");
  await page.keyboard.press("Control+z"); await frame(page);
  expect(await page.evaluate(() => window.__lightGame.state.result.grid.byPosition.get("2,2").type)).toBe("chipPart");
  await page.reload(); await frame(page);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("light-game/save")).chips[0]);
  expect(saved.appearance.shape).toHaveLength(3);
  expect(saved.appearance.cells.find((cell) => cell.text === "钟")).toMatchObject({ x: 0, y: 0 });
  expect(saved.circuits.find((cell) => cell.x === 0 && cell.y === 0).placement).toHaveLength(3);
  expect(saved.circuits.find((cell) => cell.x === 0 && cell.y === 1).placement).toHaveLength(3);
});

test("无限形状页支持清空撤销、平移后负坐标及超过十六格跨度，保存后仍为稀疏形状", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "芯片库", exact: true }).click();
  await page.getByRole("button", { name: "新建芯片", exact: true }).click();
  await page.locator("#chip-shape-name").fill("任意形状");
  const points = [[0, 0], [1, 0], [2, 0], [3, 0], [1, 1], [1, 2], [1, 3]];
  for (const [x, y] of points) await click(page, x, y);
  expect(await page.evaluate(() => window.__lightGame.state.placement.length)).toBe(7);
  await page.getByRole("button", { name: "清空形状", exact: true }).click();
  await expect(page.getByRole("button", { name: "下一步", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "撤销", exact: true }).click(); await frame(page);
  expect(await page.evaluate(() => window.__lightGame.state.placement.length)).toBe(7);
  const box = await page.locator("#stage").boundingBox();
  for (let i = 0; i < 2; i++) {
    await page.mouse.move(box.x + 20, box.y + box.height * 0.6); await page.mouse.down();
    await page.mouse.move(box.x + 20 + Math.min(300, box.width - 60), box.y + box.height * 0.6, { steps: 8 });
    await page.mouse.up(); await frame(page);
  }
  const x = await page.evaluate(() => Math.floor(window.__lightGame.state.camera.x));
  expect(x).toBeLessThan(-16);
  await click(page, x, 0);
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("button", { name: "保存并返回实验板", exact: true }).click();
  await page.getByRole("button", { name: "芯片库", exact: true }).click();
  await page.getByRole("button", { name: "放置 任意形状", exact: true }).click(); await click(page, 3, 2);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("light-game/save")).chips[0]);
  expect(saved.appearance.shape).toHaveLength(8);
  expect(saved.appearance.cols).toBeGreaterThan(16);
  expect(saved.appearance.shape).toContainEqual({ x, y: 0 });
  expect(await page.evaluate(() => window.__lightGame.state.result.grid.cells.length)).toBe(8);
});

test("编辑形状发生重叠时保留草稿，取消恢复原板和独立格内线路", async ({ page }) => {
  const chip = { id: "shape", name: "外形测试", placement: [], appearance: { cols: 2, rows: 1, cells: [] },
    circuits: [{ x: 0, y: 0, placement: [{ type: "io", x: -4, y: 10, orient: 1 }] }] };
  const board = [{ type: "chip", x: 3, y: 2, orient: 0, chipId: chip.id }, { type: "wall", x: 3, y: 3, orient: 0 }];
  await fixture(page, [chip], board);
  await page.getByRole("button", { name: "芯片库", exact: true }).click();
  await page.getByRole("button", { name: "形状 外形测试", exact: true }).click();
  await click(page, 0, 1);
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("形状发生重叠");
  await page.keyboard.press("Escape");
  await expect(page.locator("#level-title")).toHaveText("绘制芯片形状");
  expect(await page.evaluate(() => window.__lightGame.state.placement.length)).toBe(3);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect(await page.evaluate(() => window.__lightGame.state.placement)).toEqual(board);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("light-game/save")).chips[0].circuits)).toEqual(chip.circuits);
});
