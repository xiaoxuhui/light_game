"use strict";
const { test, expect } = require("@playwright/test");

async function frame(page) {
  await page.waitForFunction(() => window.__lightGame?.state.layout && !window.__lightGame.state.dirty);
}
async function point(page, x, y) {
  await frame(page);
  return page.evaluate(({ x, y }) => {
    const s = window.__lightGame.state;
    const b = document.getElementById("stage").getBoundingClientRect();
    return { x: b.x + (s.layout.ox + (x + 0.5) * s.layout.cell) / s.dpr,
      y: b.y + (s.layout.oy + (y + 0.5) * s.layout.cell) / s.dpr };
  }, { x, y });
}
async function click(page, x, y, button = "left", ctrl = false) {
  const p = await point(page, x, y);
  if (ctrl) await page.keyboard.down("Control");
  await page.mouse.click(p.x, p.y, { button });
  if (ctrl) await page.keyboard.up("Control");
  await frame(page);
}
async function fixture(page, placement, chips = []) {
  await page.goto("/"); await frame(page);
  await page.evaluate(({ placement, chips }) => {
    const save = JSON.parse(localStorage.getItem("light-game/save"));
    save.chips = chips; save.freeBoards = { t02: placement }; save.freeBoardVersions = { t02: 2 };
    save.session = { levelId: "t02", mode: "free" };
    localStorage.setItem("light-game/save", JSON.stringify(save));
  }, { placement, chips });
  await page.reload(); await frame(page);
  await page.keyboard.press("Space");
  await expect(page.locator("#btn-run")).toHaveAttribute("aria-pressed", "true");
}

test("空格暂停并冻结时间，光源放置和变化延迟一拍，灯泡延迟一拍", async ({ page }) => {
  await fixture(page, []);
  await page.locator('[data-type="directionalEmitter"]').click();
  await click(page, 2, 2); await click(page, 2, 2); // 朝右
  await page.locator('[data-type="bulb"]').click(); await click(page, 5, 2);
  const tick = await page.evaluate(() => window.__lightGame.simulation.tick);
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.__lightGame.simulation.tick)).toBe(tick);
  expect(await page.evaluate(() => window.__lightGame.state.result.segments.length)).toBe(0);
  await page.keyboard.press("Space");
  await page.waitForFunction(() => {
    const t = window.__lightGame.state.result.targets[0];
    return t.rawIncoming === 7 && !t.lit;
  });
  await page.waitForFunction(() => window.__lightGame.state.result.targets[0].lit);
  await page.keyboard.press("Space");
  await click(page, 2, 2); // 朝下，暂停期间旧光路仍在
  expect(await page.evaluate(() => window.__lightGame.state.result.targets[0].rawIncoming)).toBe(7);
  await page.keyboard.down("Space"); await page.keyboard.down("Space"); await page.keyboard.up("Space");
  expect(await page.evaluate(() => window.__lightGame.state.paused)).toBe(false);
  await page.waitForFunction(() => window.__lightGame.state.result.targets[0].rawIncoming === 0);
  await page.waitForFunction(() => !window.__lightGame.state.result.targets[0].lit);
});

test("暂停后 N 每次只运行一拍，长按不重复，单步按钮保持暂停", async ({ page }) => {
  await fixture(page, [{ type: "directionalEmitter", x: 2, y: 2, orient: 1 },
    { type: "bulb", x: 5, y: 2, orient: 0 }]);
  const start = await page.evaluate(() => window.__lightGame.simulation.tick);
  await page.keyboard.press("n"); await frame(page);
  expect(await page.evaluate(() => window.__lightGame.simulation.tick)).toBe(start + 1);
  expect(await page.evaluate(() => window.__lightGame.state.result.targets[0].rawIncoming)).toBe(7);
  expect(await page.evaluate(() => window.__lightGame.state.result.targets[0].lit)).toBe(false);
  expect(await page.evaluate(() => window.__lightGame.state.paused)).toBe(true);
  await page.waitForTimeout(650);
  expect(await page.evaluate(() => window.__lightGame.simulation.tick)).toBe(start + 1);
  await page.getByRole("button", { name: "单步（N）", exact: true }).click(); await frame(page);
  expect(await page.evaluate(() => window.__lightGame.simulation.tick)).toBe(start + 2);
  expect(await page.evaluate(() => window.__lightGame.state.result.targets[0].lit)).toBe(true);
  await page.keyboard.down("n"); await page.keyboard.down("n"); await page.keyboard.up("n");
  expect(await page.evaluate(() => window.__lightGame.simulation.tick)).toBe(start + 3);
  expect(await page.evaluate(() => window.__lightGame.state.paused)).toBe(true);
});

test("Ctrl 左键整组旋转、Ctrl 右键整组删除且一键撤销，中键空处和 Ctrl 中键无操作", async ({ page }) => {
  const placed = [
    { type: "mirror", x: 1, y: 1, orient: 0 }, { type: "splitter", x: 2, y: 1, orient: 1 },
    { type: "prism", x: 3, y: 1, orient: 1, facing: 2 },
    { type: "directionalEmitter", x: 4, y: 1, orient: 1 },
    { type: "chip", x: 5, y: 1, orient: 2, chipId: "empty" },
    { type: "wall", x: 1, y: 3, orient: 0 }, { type: "bulb", x: 2, y: 3, orient: 0 },
  ];
  await fixture(page, placed, [{ id: "empty", name: "空芯片", placement: [] }]);
  const before = await page.evaluate(() => ({ board: window.__lightGame.state.placement, camera: window.__lightGame.state.camera }));
  await click(page, 5, 1, "middle", true); await click(page, 0, 0, "middle");
  expect(await page.evaluate(() => Boolean(window.__lightGame.state.inspection))).toBe(false);
  expect(await page.evaluate(() => ({ board: window.__lightGame.state.placement, camera: window.__lightGame.state.camera }))).toEqual(before);
  await click(page, 0, 0, "left", true);
  const rotated = await page.evaluate(() => window.__lightGame.state.placement);
  expect(rotated.slice(0, 5).map((p) => p.orient)).toEqual([1, 0, 1, 2, 3]);
  expect(rotated[2].facing).toBe(3);
  expect(rotated.slice(5)).toEqual(placed.slice(5));
  await click(page, 0, 0, "right", true);
  expect(await page.evaluate(() => window.__lightGame.state.placement)).toEqual([]);
  await page.keyboard.press("Control+z");
  expect(await page.evaluate(() => window.__lightGame.state.placement)).toEqual(rotated);
  await page.keyboard.press("Control+z");
  expect(await page.evaluate(() => window.__lightGame.state.placement)).toEqual(placed);
});

test("中键查看芯片实时过程，暂停与返回不重置，内部热镜只延迟一拍", async ({ page }) => {
  const chip = { id: "timed", name: "热开关", placement: [
    { type: "inputPort", x: 0, y: 0, orient: 1 },
    { type: "splitter", x: 1, y: 0, orient: 0 },
    { type: "mirror", x: 1, y: -1, orient: 0 }, { type: "mirror", x: 3, y: -1, orient: 1 },
    { type: "hotMirror", x: 3, y: 0, orient: 1 }, { type: "outputPort", x: 4, y: 0, orient: 3 },
  ] };
  await fixture(page, [{ type: "directionalEmitter", x: 0, y: 2, orient: 1 },
    { type: "chip", x: 3, y: 2, orient: 0, chipId: chip.id }, { type: "bulb", x: 6, y: 2, orient: 0 }], [chip]);
  await click(page, 3, 2, "middle");
  await page.keyboard.press("N"); await frame(page);
  const tick = await page.evaluate(() => window.__lightGame.simulation.tick);
  const temperature = () => page.evaluate(() => window.__lightGame.state.result.grid.cells.find((c) => c.type === "hotMirror").temperature);
  expect(await temperature()).toBe(0);
  await page.getByRole("button", { name: "返回实验板", exact: true }).click();
  await click(page, 3, 2, "middle");
  expect(await temperature()).toBe(0);
  expect(await page.evaluate(() => window.__lightGame.simulation.tick)).toBe(tick);
  await page.keyboard.press("N"); await frame(page);
  expect(await temperature()).toBe(1);
  expect(await page.evaluate(() => window.__lightGame.state.paused)).toBe(true);
  await page.getByRole("button", { name: "返回实验板", exact: true }).click();
  await page.keyboard.press("N"); await frame(page);
  expect(await page.evaluate(() => window.__lightGame.state.result.targets[0].lit)).toBe(true);
});

test("芯片无匹配入口挡光，旋转接通后显示实际 IO 收发且不会绕过内部热镜", async ({ page }) => {
  const chip = { id: "ports", name: "端口测试", placement: [
    { type: "inputPort", x: 0, y: 0, orient: 1 },
    { type: "splitter", x: 1, y: 0, orient: 0 },
    { type: "mirror", x: 1, y: -1, orient: 0 }, { type: "mirror", x: 3, y: -1, orient: 1 },
    { type: "hotMirror", x: 3, y: 0, orient: 1 }, { type: "outputPort", x: 4, y: 0, orient: 3 },
  ] };
  await fixture(page, [{ type: "directionalEmitter", x: 0, y: 2, orient: 1 },
    { type: "chip", x: 3, y: 2, orient: 1, chipId: chip.id }, { type: "bulb", x: 6, y: 2, orient: 0 }], [chip]);
  await page.keyboard.press("N"); await frame(page);
  expect(await page.evaluate(() => window.__lightGame.state.result.targets[0].rawIncoming)).toBe(0);
  await click(page, 3, 2, "middle");
  await expect(page.locator("#level-status")).toContainText("芯片IO箭头：下");
  await expect(page.locator("#level-status")).toContainText("来光未匹配IO口，已挡光");
  expect(await page.evaluate(() => window.__lightGame.state.result.grid.cells.find((c) => c.type === "hotMirror").temperature)).toBe(0);
  await page.getByRole("button", { name: "返回实验板", exact: true }).click();
  for (let n = 0; n < 3; n++) await click(page, 3, 2);
  expect(await page.evaluate(() => window.__lightGame.state.result.targets[0].rawIncoming)).toBe(0);
  await click(page, 3, 2, "middle");
  await expect(page.locator("#level-status")).toContainText("芯片IO箭头：右");
  await expect(page.locator("#level-status")).toContainText("已接收入光");
  await expect(page.locator("#level-status")).toContainText("本拍无输出信号");
  expect(await page.evaluate(() => window.__lightGame.state.result.grid.cells.find((c) => c.type === "inputPort" && c.x === 0).inputColor)).toBe(7);
  await page.keyboard.press("N"); await frame(page);
  await expect(page.locator("#level-status")).toContainText("正在向右输出");
  expect(await page.evaluate(() => window.__lightGame.state.result.grid.cells.find((c) => c.type === "outputPort" && c.x === 4).outputColor)).toBe(7);
  await page.keyboard.press("N"); await frame(page);
  await page.getByRole("button", { name: "返回实验板", exact: true }).click();
  expect(await page.evaluate(() => window.__lightGame.state.result.targets[0].lit)).toBe(true);
});

test("冷热镜保持各自侧面规则，用户与非门四种输入和反复切换均正确", async ({ page }) => {
  const chip = { id: "nand-regression", name: "用户与非门", placement: [
    { type: "directionalEmitter", x: 0, y: 0, orient: 1 },
    { type: "coldMirror", x: 1, y: 0, orient: 1 },
    { type: "mirror", x: 2, y: 0, orient: 0 }, { type: "inputPort", x: 2, y: -1, orient: 2 },
    { type: "inputPort", x: 0, y: 1, orient: 1 }, { type: "hotMirror", x: 1, y: 1, orient: 0 },
    { type: "mirror", x: 1, y: 2, orient: 1 }, { type: "inputPort", x: 2, y: 2, orient: 3 },
  ] };
  await fixture(page, [{ type: "chip", x: 3, y: 3, orient: 0, chipId: chip.id },
    { type: "bulb", x: 3, y: 1, orient: 0 }], [chip]);
  const step = async () => { for (let n = 0; n < 6; n++) { await page.keyboard.press("N"); await frame(page); } };
  const signal = () => page.evaluate(() => {
    const game = window.__lightGame, instance = game.state.result.grid.cells.find((cell) => cell.type === "chip");
    const cells = game.simulation.getView(game.simulation.childPath("root", instance)).grid.cells;
    return { hot: cells.find((cell) => cell.type === "hotMirror").open,
      cold: cells.find((cell) => cell.type === "coldMirror").open, output: game.state.result.targets[0].lit };
  });
  await step(); expect(await signal()).toEqual({ hot: false, cold: true, output: true }); // 00
  await page.locator('[data-type="directionalEmitter"]').click();
  await click(page, 1, 3); await click(page, 1, 3);
  await step(); expect(await signal()).toEqual({ hot: true, cold: true, output: true }); // 10
  for (let n = 0; n < 4; n++) await click(page, 5, 3);
  await step(); expect(await signal()).toEqual({ hot: true, cold: false, output: false }); // 11
  await click(page, 1, 3, "right");
  await step(); expect(await signal()).toEqual({ hot: false, cold: true, output: true }); // 01
  await click(page, 5, 3, "right");
  await step(); expect(await signal()).toEqual({ hot: false, cold: true, output: true }); // 00
});

test("图中竖冷镜让左边白光穿到右边镜子，上下来光才作为侧面反相控制", async ({ page }) => {
  await fixture(page, [{ type: "directionalEmitter", x: 0, y: 2, orient: 1 },
    { type: "coldMirror", x: 1, y: 2, orient: 1 },
    { type: "mirror", x: 2, y: 2, orient: 0 }, { type: "bulb", x: 2, y: 0, orient: 0 }]);
  const signal = () => page.evaluate(() => {
    const result = window.__lightGame.state.result;
    const cold = result.grid.cells.find((cell) => cell.type === "coldMirror");
    return { open: cold.open, control: cold.receiving, raw: result.targets[0].rawIncoming,
      reachedMirror: result.segments.some((s) => s.from.x === 1 && s.from.y === 2 && s.to.x === 2 && s.to.y === 2) };
  });
  for (let n = 0; n < 10; n++) { await page.keyboard.press("N"); await frame(page); }
  expect(await signal()).toEqual({ open: true, control: false, raw: 7, reachedMirror: true });
  await page.locator('[data-type="directionalEmitter"]').click();
  await click(page, 1, 0); await click(page, 1, 0); await click(page, 1, 0);
  await page.keyboard.press("N"); await frame(page);
  expect(await signal()).toEqual({ open: true, control: true, raw: 7, reachedMirror: true });
  await page.keyboard.press("N"); await frame(page);
  expect(await signal()).toEqual({ open: false, control: true, raw: 0, reachedMirror: false });
  await click(page, 1, 0, "right");
  await page.keyboard.press("N"); await frame(page);
  expect(await signal()).toEqual({ open: true, control: false, raw: 7, reachedMirror: true });
});

test("冷镜侧面非门一拍反相且不自振，R 和按钮重置保留布局与暂停", async ({ page }) => {
  const placement = [{ type: "directionalEmitter", x: 0, y: 2, orient: 1 },
    { type: "directionalEmitter", x: 3, y: 0, orient: 2 },
    { type: "coldMirror", x: 3, y: 2, orient: 1 }, { type: "bulb", x: 6, y: 2, orient: 0 }];
  await fixture(page, placement);
  const cold = () => page.evaluate(() => {
    const c = window.__lightGame.state.result.grid.cells.find((cell) => cell.type === "coldMirror");
    return { open: c.open, temperature: c.temperature };
  });
  expect(await cold()).toEqual({ open: true, temperature: 0 });
  for (let n = 0; n < 2; n++) { await page.keyboard.press("N"); await frame(page); }
  expect(await cold()).toEqual({ open: false, temperature: 1 });
  for (let n = 0; n < 6; n++) { await page.keyboard.press("N"); await frame(page); }
  expect(await cold()).toEqual({ open: false, temperature: 1 });
  await click(page, 3, 0, "right");
  await page.keyboard.press("N"); await frame(page);
  expect(await cold()).toEqual({ open: true, temperature: 0 });
  await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control");
  await frame(page);
  await page.keyboard.press("r"); await frame(page);
  expect(await page.evaluate(() => window.__lightGame.simulation.tick)).toBe(0);
  expect(await page.evaluate(() => window.__lightGame.state.placement)).toEqual(placement);
  expect(await page.evaluate(() => window.__lightGame.state.paused)).toBe(true);
  expect(await cold()).toEqual({ open: true, temperature: 0 });
  await page.keyboard.press("N"); await frame(page);
  await page.getByRole("button", { name: "重置（R）", exact: true }).click(); await frame(page);
  expect(await page.evaluate(() => window.__lightGame.simulation.tick)).toBe(0);
  expect(await page.evaluate(() => window.__lightGame.state.placement)).toEqual(placement);
});

test("旋转冷镜同时切换通光轴及侧面控制，不再只有图形旋转", async ({ page }) => {
  await fixture(page, [{ type: "directionalEmitter", x: 0, y: 2, orient: 1 },
    { type: "coldMirror", x: 3, y: 2, orient: 0 }, { type: "bulb", x: 6, y: 2, orient: 0 }]);
  const signal = () => page.evaluate(() => {
    const cold = window.__lightGame.state.result.grid.cells.find((cell) => cell.type === "coldMirror");
    return { orient: cold.orient, open: cold.open, receiving: cold.receiving,
      raw: window.__lightGame.state.result.targets[0].rawIncoming };
  });
  for (let n = 0; n < 3; n++) { await page.keyboard.press("N"); await frame(page); }
  expect(await signal()).toEqual({ orient: 0, open: false, receiving: true, raw: 0 });
  await click(page, 3, 2);
  await expect(page.locator("#level-status")).toContainText("通光轴：左右");
  await page.keyboard.press("N"); await frame(page);
  expect(await signal()).toEqual({ orient: 1, open: true, receiving: false, raw: 7 });
  for (let n = 0; n < 6; n++) { await page.keyboard.press("N"); await frame(page); }
  expect(await signal()).toEqual({ orient: 1, open: true, receiving: false, raw: 7 });
  await click(page, 3, 2);
  await page.keyboard.press("N"); await frame(page);
  expect(await signal()).toEqual({ orient: 0, open: false, receiving: true, raw: 0 });
  await expect(page.locator("#level-status")).toContainText("有光 → 取反后关闭");
  await expect(page.locator("#level-status")).not.toContainText("尚无外部来光");
});

test("编辑器可放入其他芯片，阻止自引用，嵌套逐层查看和重置保持原布局", async ({ page }) => {
  const child = { id: "child", name: "子芯片", placement: [
    { type: "inputPort", x: 0, y: 0, orient: 1 }, { type: "outputPort", x: 2, y: 0, orient: 3 },
  ] };
  const parent = { id: "parent", name: "父芯片", placement: [] };
  await fixture(page, [{ type: "directionalEmitter", x: 0, y: 2, orient: 1 },
    { type: "chip", x: 3, y: 2, orient: 0, chipId: parent.id }, { type: "bulb", x: 6, y: 2, orient: 0 }], [child, parent]);
  await page.getByRole("button", { name: "芯片库", exact: true }).click();
  await page.getByRole("button", { name: "编辑 父芯片", exact: true }).click();
  await page.locator('[data-type="inputPort"]').click();
  await click(page, 0, 2); await click(page, 0, 2);
  await page.locator('[data-type="chip"]').click();
  await expect(page.getByRole("button", { name: "放置 父芯片", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "放置 子芯片", exact: true }).click();
  await click(page, 2, 2);
  await page.locator('[data-type="inputPort"]').click();
  await click(page, 4, 2); await click(page, 4, 2); await click(page, 4, 2); await click(page, 4, 2);
  await page.getByRole("button", { name: "保存并返回实验板", exact: true }).click();
  await page.keyboard.press("N"); await frame(page);
  await page.keyboard.press("N"); await frame(page);
  expect(await page.evaluate(() => window.__lightGame.state.result.targets[0].lit)).toBe(true);
  await click(page, 3, 2, "middle");
  await click(page, 2, 2, "middle");
  await expect(page.locator("#level-title")).toHaveText("运行过程 · 子芯片");
  await page.keyboard.press("R"); await frame(page);
  expect(await page.evaluate(() => window.__lightGame.simulation.tick)).toBe(0);
  await page.getByRole("button", { name: "返回上层芯片", exact: true }).click();
  await expect(page.locator("#level-title")).toHaveText("运行过程 · 父芯片");
  await page.getByRole("button", { name: "返回实验板", exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("light-game/save")).chips.find((c) => c.id === "parent").placement))
    .toEqual([{ type: "inputPort", x: 0, y: 2, orient: 1 },
      { type: "chip", x: 2, y: 2, orient: 0, chipId: "child" }, { type: "inputPort", x: 4, y: 2, orient: 3 }]);
});

test("每拍时间自定义立即生效，暂停和单步不受影响，刷新恢复设置", async ({ page }) => {
  await fixture(page, []);
  const field = page.getByRole("spinbutton", { name: "每拍时间（秒）", exact: true });
  await field.fill("0.1"); await field.blur();
  expect(await page.evaluate(() => window.__lightGame.state.stepMs)).toBe(100);
  expect(await page.evaluate(() => window.__lightGame.state.paused)).toBe(true);
  await expect(page.locator("#simulation-status")).toContainText("每拍 0.1 秒");
  await page.keyboard.press("N"); await frame(page);
  const tick = await page.evaluate(() => window.__lightGame.simulation.tick);
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.__lightGame.simulation.tick)).toBe(tick);
  await page.keyboard.press("Space");
  await page.waitForFunction((tick) => window.__lightGame.simulation.tick >= tick + 2, tick, { timeout: 1500 });
  await page.keyboard.press("Space");
  await page.reload(); await frame(page);
  await expect(field).toHaveValue("0.1");
  expect(await page.evaluate(() => window.__lightGame.state.stepMs)).toBe(100);
});

test("只有一种IO工具，旧端口同规则，点击两次转180度且没有角色切换", async ({ page }) => {
  const chip = { id: "stable-ports", name: "端口旋转", placement: [
    { type: "inputPort", x: 0, y: 0, orient: 1 }, { type: "outputPort", x: 2, y: 0, orient: 3 },
  ] };
  await fixture(page, [{ type: "directionalEmitter", x: 0, y: 2, orient: 1 },
    { type: "chip", x: 3, y: 2, orient: 0, chipId: chip.id }, { type: "bulb", x: 6, y: 2, orient: 0 }], [chip]);
  await page.getByRole("button", { name: "芯片库", exact: true }).click();
  await page.getByRole("button", { name: "编辑 端口旋转", exact: true }).click();
  await expect(page.locator('[data-type="outputPort"]')).toHaveCount(0);
  await expect(page.locator("#btn-port-role")).toHaveCount(0);
  await expect(page.locator("#level-status")).toContainText("IO口 2 个");
  await page.locator('[data-type="inputPort"]').click();
  await click(page, 2, 0);
  const port = (x) => page.evaluate((x) => window.__lightGame.state.placement.find((p) => p.x === x && p.y === 0), x);
  expect(await port(2)).toEqual({ type: "outputPort", x: 2, y: 0, orient: 0 });
  await click(page, 2, 0);
  expect(await port(2)).toEqual({ type: "outputPort", x: 2, y: 0, orient: 1 });
  await page.getByRole("button", { name: "保存并返回实验板", exact: true }).click();
  await page.keyboard.press("N"); await frame(page);
  expect(await page.evaluate(() => window.__lightGame.state.result.targets[0].rawIncoming)).toBe(0);
  await page.getByRole("button", { name: "芯片库", exact: true }).click();
  await page.getByRole("button", { name: "编辑 端口旋转", exact: true }).click();
  await click(page, 2, 0); await click(page, 2, 0);
  expect(await port(2)).toEqual({ type: "outputPort", x: 2, y: 0, orient: 3 });
  await page.getByRole("button", { name: "保存并返回实验板", exact: true }).click();
  await page.keyboard.press("N"); await frame(page);
  await page.keyboard.press("N"); await frame(page);
  expect(await page.evaluate(() => window.__lightGame.state.result.targets[0].lit)).toBe(true);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("light-game/save")).chips.find((c) => c.id === "stable-ports").placement))
    .toEqual(chip.placement);
});

test("向下箭头的外侧在上，芯片内部上行光从它向上输出，旋转180度改变外侧", async ({ page }) => {
  const chip = { id: "entry-rule", name: "入口方向", placement: [
    { type: "directionalEmitter", x: 0, y: 2, orient: 1 },
    { type: "coldMirror", x: 1, y: 2, orient: 1 },
    { type: "mirror", x: 2, y: 2, orient: 0 },
    { type: "inputPort", x: 2, y: 0, orient: 2 },
  ] };
  await fixture(page, [{ type: "chip", x: 3, y: 2, orient: 0, chipId: chip.id },
    { type: "bulb", x: 3, y: 0, orient: 0 }, { type: "bulb", x: 3, y: 4, orient: 0 }], [chip]);
  for (let n = 0; n < 3; n++) { await page.keyboard.press("N"); await frame(page); }
  const incoming = () => page.evaluate(() => window.__lightGame.state.result.targets.map((target) => target.rawIncoming));
  expect(await incoming()).toEqual([7, 0]);
  await page.getByRole("button", { name: "芯片库", exact: true }).click();
  await page.getByRole("button", { name: "编辑 入口方向", exact: true }).click();
  await click(page, 2, 0); await click(page, 2, 0);
  expect(await page.evaluate(() => window.__lightGame.state.placement.find((part) => part.type === "inputPort").orient)).toBe(0);
  await page.getByRole("button", { name: "保存并返回实验板", exact: true }).click();
  for (let n = 0; n < 2; n++) { await page.keyboard.press("N"); await frame(page); }
  expect(await incoming()).toEqual([0, 0]);
  await page.reload(); await frame(page);
  await page.keyboard.press("Space");
  for (let n = 0; n < 2; n++) { await page.keyboard.press("N"); await frame(page); }
  expect(await incoming()).toEqual([0, 0]);
});

test("旧 IO 的右侧口向外部右边输出，时钟信号到达 IO 后不再被左右反转", async ({ page }) => {
  const chip = { id: "old-clock", name: "旧 IO 时钟", placement: [
    { type: "coldMirror", x: 0, y: 1, orient: 1 },
    { type: "io", x: -1, y: 1, orient: 1 }, { type: "io", x: 2, y: 1, orient: 3 },
    { type: "splitter", x: 1, y: 1, orient: 0 },
    { type: "mirror", x: 1, y: 0, orient: 1 }, { type: "mirror", x: 0, y: 0, orient: 0 },
  ] };
  await fixture(page, [{ type: "directionalEmitter", x: 0, y: 2, orient: 1 },
    { type: "chip", x: 3, y: 2, orient: 0, chipId: chip.id }, { type: "bulb", x: 6, y: 2, orient: 0 }], [chip]);
  for (let n = 1; n <= 5; n++) {
    await page.keyboard.press("N"); await frame(page);
    const signal = await page.evaluate(() => {
      const game = window.__lightGame, instance = game.state.result.grid.cells.find((c) => c.type === "chip");
      const internal = game.simulation.getView(game.simulation.childPath("root", instance));
      return { io: internal.grid.cells.find((c) => c.type === "io" && c.x === 2).outputColor,
        right: instance.outputColors[2], left: instance.outputColors[6], raw: game.state.result.targets[0].rawIncoming };
    });
    const expected = n % 2 ? 7 : 0;
    expect(signal).toEqual({ io: expected, right: expected, left: 0, raw: expected });
    if (expected) await expect(page.locator("#level-status")).toContainText("正在向右输出");
  }
});
