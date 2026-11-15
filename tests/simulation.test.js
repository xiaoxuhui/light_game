"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSimulation } = require("../scripts/simulation.js");

const level = { mode: "free", infinite: true, fixed: [], targets: [], chips: [] };
const source = { type: "directionalEmitter", x: 0, y: 0, orient: 1 };
const bulb = { type: "bulb", x: 5, y: 0, orient: 0 };
function rig(board, definition = level) {
  const simulation = createSimulation();
  let result = simulation.solve(definition, board);
  return { simulation, get result() { return result; },
    solve(next = board) { board = next; result = simulation.solve(definition, board); return result; },
    step() { simulation.advance(); return this.solve(); } };
}

test("新光源一拍后发光，传播无距离耗时，输出灯泡再等一拍", () => {
  const r = rig([source, { ...bulb, x: 1000000 }]);
  assert.equal(r.result.segments.length, 0);
  assert.equal(r.simulation.pending, true);
  assert.equal(r.step().targets[0].rawIncoming, 7);
  assert.equal(r.result.targets[0].lit, false);
  assert.equal(r.step().targets[0].lit, true);
  assert.equal(r.simulation.pending, false);
});

test("光源旋转延迟一拍，普通镜子和墙的改变无需额外拍数", () => {
  const r = rig([source, bulb]); r.step(); r.step();
  r.solve([{ ...source, orient: 2 }, bulb]);
  assert.equal(r.result.targets[0].rawIncoming, 7);
  assert.equal(r.step().targets[0].rawIncoming, 0);
  assert.equal(r.result.targets[0].lit, true);
  assert.equal(r.step().targets[0].lit, false);
  r.solve([source, { type: "mirror", x: 2, y: 0, orient: 0 }, { ...bulb, x: 2, y: -2 }]);
  assert.equal(r.step().targets[0].rawIncoming, 7);
  r.solve([source, { type: "wall", x: 1, y: 0 }, { ...bulb, x: 2, y: -2 }]);
  assert.equal(r.result.targets[0].rawIncoming, 0);
});

test("热镜仅由侧面正向控制：有侧光一拍开启，无侧光一拍关闭，通路光不触发", () => {
  const hot = { type: "hotMirror", x: 2, y: 0, orient: 1 };
  const bulb = { type: "bulb", x: 5, y: 0, orient: 0 };
  const control = { type: "directionalEmitter", x: 2, y: -2, orient: 2 };
  const r = rig([source, hot, bulb]);
  for (let n = 0; n < 30; n++) assert.equal(r.step().targets[0].rawIncoming, 0);
  r.solve([source, control, hot, bulb]);
  assert.equal(r.step().targets[0].rawIncoming, 0);
  assert.equal(r.step().targets[0].rawIncoming, 7);
  assert.equal(r.result.grid.cells.find((c) => c.type === "hotMirror").temperature, 1);
  assert.equal(r.step().targets[0].lit, true);
  r.solve([hot, bulb]);
  r.step(); assert.equal(r.result.grid.cells.find((c) => c.type === "hotMirror").open, false);
});

test("冷热镜分别响应同一侧面信号：热镜有光开、冷镜有光关，持续通路光不串扰", () => {
  for (const orient of [0, 1]) {
    const hot = { type: "hotMirror", x: orient ? 0 : 2, y: orient ? 2 : 0, orient };
    const cold = { type: "coldMirror", x: -hot.x, y: -hot.y, orient };
    const main = [hot, cold].flatMap((part) => [
      { type: "directionalEmitter", x: part.x - (orient ? 2 : 0), y: part.y - (orient ? 0 : 2), orient: orient ? 1 : 2 },
      part, { type: "bulb", x: part.x + (orient ? 2 : 0), y: part.y + (orient ? 0 : 2), orient: 0 },
    ]);
    const r = rig(main);
    const states = () => ["hotMirror", "coldMirror"].map((type) => r.result.grid.cells.find((cell) => cell.type === type).open);
    for (let n = 0; n < 30; n++) { r.step(); assert.deepEqual(states(), [false, true]); }
    r.solve([...main, { type: "emitter", x: 0, y: 0, orient: 0 }]);
    r.step(); assert.deepEqual(states(), [false, true]);
    for (let n = 0; n < 30; n++) { r.step(); assert.deepEqual(states(), [true, false]); }
    r.solve(main); r.step();
    assert.deepEqual(states(), [false, true]);
  }
});

test("用户核心线路的与非门四种输入均正确，四向旋转和输入切换后仍稳定", () => {
  const core = require("../scripts/light-core.js");
  const chip = { id: "user-nand", name: "用户与非门", placement: [
    { type: "directionalEmitter", x: 0, y: 0, orient: 1 },
    { type: "coldMirror", x: 1, y: 0, orient: 1 },
    { type: "mirror", x: 2, y: 0, orient: 0 }, { type: "inputPort", x: 2, y: -1, orient: 2 },
    { type: "inputPort", x: 0, y: 1, orient: 1 }, { type: "hotMirror", x: 1, y: 1, orient: 0 },
    { type: "mirror", x: 1, y: 2, orient: 1 }, { type: "inputPort", x: 2, y: 2, orient: 3 },
  ] };
  for (let rotation = 0; rotation < 4; rotation++) {
    const axis = core.DIRECTIONS[(2 + rotation * 2) % 8], output = core.DIRECTIONS[rotation * 2];
    const base = [{ type: "chip", x: 0, y: 0, orient: rotation, chipId: chip.id },
      { type: "bulb", x: output.dx * 3, y: output.dy * 3, orient: 0 }];
    const r = rig(base, { ...level, chips: [chip] });
    for (const [a, b] of [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0], [1, 1], [0, 1]]) {
      r.solve([...base,
        ...(a ? [{ type: "directionalEmitter", x: -axis.dx * 3, y: -axis.dy * 3, orient: (1 + rotation) % 4 }] : []),
        ...(b ? [{ type: "directionalEmitter", x: axis.dx * 3, y: axis.dy * 3, orient: (3 + rotation) % 4 }] : []),
      ]);
      for (let n = 0; n < 12; n++) r.step();
      assert.equal(r.result.targets[0].lit, !(a && b), "旋转" + rotation + " 输入" + a + b);
      for (let n = 0; n < 12; n++) { r.step(); assert.equal(r.result.targets[0].lit, !(a && b)); }
    }
  }
});

test("有限网格热镜也只接受侧面控制，持续主光不自行开启", () => {
  const simulation = createSimulation();
  const finite = { mode: "free", cols: 8, rows: 8,
    fixed: [{ type: "emitter", x: 0, y: 3, dir: "right", color: 7 }], targets: [{ x: 6, y: 3, require: 7 }] };
  const hot = [{ type: "hotMirror", x: 3, y: 3, orient: 1 }];
  const controlled = { ...finite, fixed: [...finite.fixed, { type: "emitter", x: 3, y: 0, dir: "down", color: 7 }] };
  simulation.solve(finite, hot);
  for (let n = 0; n < 10; n++) { simulation.advance(); assert.equal(simulation.solve(finite, hot).targets[0].rawIncoming, 0); }
  simulation.solve(controlled, hot); simulation.advance();
  assert.equal(simulation.solve(controlled, hot).targets[0].rawIncoming, 7);
  simulation.solve(finite, hot); simulation.advance();
  assert.equal(simulation.solve(finite, hot).targets[0].rawIncoming, 0);
});

test("冷镜本格自带侧面非门：通路光不触发，侧面输入一拍反相且持续输入保持关闭", () => {
  const cold = { type: "coldMirror", x: 2, y: 0, orient: 1 };
  const bulb = { type: "bulb", x: 5, y: 0, orient: 0 };
  const control = { type: "directionalEmitter", x: 2, y: -2, orient: 2 };
  const r = rig([source, cold, bulb]);
  assert.equal(r.result.grid.cells.find((c) => c.type === "coldMirror").open, true);
  for (let n = 0; n < 30; n++) assert.equal(r.step().targets[0].rawIncoming, 7);
  r.solve([source, control, cold, bulb]);
  assert.equal(r.step().targets[0].rawIncoming, 7); // 光源一拍生效，非门尚未采样
  assert.equal(r.step().targets[0].rawIncoming, 0);
  assert.equal(r.result.grid.cells.find((c) => c.type === "coldMirror").open, false);
  for (let n = 0; n < 30; n++) assert.equal(r.step().targets[0].rawIncoming, 0);
  assert.equal(r.simulation.pending, false);
  r.solve([source, cold, bulb]);
  assert.equal(r.result.targets[0].rawIncoming, 0);
  assert.equal(r.step().targets[0].rawIncoming, 7);
  assert.equal(r.result.grid.cells.find((c) => c.type === "coldMirror").open, true);
});

test("芯片内部竖冷镜让左侧白光穿到右侧镜子，不误当侧面控制", () => {
  const chip = { id: "visible-circuit", name: "当前光路", placement: [
    { type: "directionalEmitter", x: -1, y: 0, orient: 1 },
    { type: "coldMirror", x: 0, y: 0, orient: 1 },
    { type: "mirror", x: 1, y: 0, orient: 0 },
    { type: "outputPort", x: 1, y: -2, orient: 2 },
  ] };
  const instance = { type: "chip", x: 0, y: 0, orient: 0, chipId: chip.id };
  const r = rig([instance, { type: "bulb", x: 0, y: -3, orient: 0 }], { ...level, chips: [chip] });
  for (let n = 0; n < 30; n++) {
    assert.equal(r.step().targets[0].rawIncoming, 7);
    const view = r.simulation.getView(r.simulation.childPath("root", instance));
    const cold = view.grid.cells.find((cell) => cell.type === "coldMirror");
    assert.equal(cold.open, true);
    assert.equal(cold.receiving, false);
    assert.equal(view.segments.some((s) => s.from.x === 0 && s.from.y === 0 && s.to.x === 1 && s.to.y === 0), true);
  }
});

test("有限网格也按冷镜侧面非门控制，轴向光不使其自振", () => {
  const simulation = createSimulation();
  const finite = { mode: "free", cols: 8, rows: 8,
    fixed: [{ type: "emitter", x: 0, y: 3, dir: "right", color: 7 }],
    targets: [{ x: 6, y: 3, require: 7 }] };
  const cold = [{ type: "coldMirror", x: 3, y: 3, orient: 1 }];
  const controlled = { ...finite, fixed: [...finite.fixed,
    { type: "emitter", x: 3, y: 0, dir: "down", color: 7 }] };
  simulation.solve(finite, cold);
  for (let n = 0; n < 30; n++) {
    simulation.advance();
    assert.equal(simulation.solve(finite, cold).targets[0].rawIncoming, 7);
  }
  assert.equal(simulation.solve(controlled, cold).targets[0].rawIncoming, 7);
  for (let n = 0; n < 30; n++) {
    simulation.advance();
    assert.equal(simulation.solve(controlled, cold).targets[0].rawIncoming, 0);
  }
  simulation.solve(finite, cold); simulation.advance();
  assert.equal(simulation.solve(finite, cold).targets[0].rawIncoming, 7);
});

test("芯片 IO 不耗拍，内部组件耗时，实时查看保留实例状态且实例互相独立", () => {
  const chip = { id: "timed", name: "热开关", placement: [
    { type: "inputPort", x: 0, y: 0, orient: 1 },
    { type: "splitter", x: 1, y: 0, orient: 0 },
    { type: "mirror", x: 1, y: -1, orient: 0 }, { type: "mirror", x: 3, y: -1, orient: 1 },
    { type: "hotMirror", x: 3, y: 0, orient: 1 }, { type: "outputPort", x: 4, y: 0, orient: 3 },
  ] };
  const a = { type: "chip", x: 2, y: 0, chipId: chip.id, orient: 0 };
  const b = { ...a, y: 4 };
  const r = rig([source, a, b, bulb], { ...level, chips: [chip] });
  r.step();
  const path = r.simulation.childPath("root", a);
  const secondPath = r.simulation.childPath("root", b);
  assert.equal(r.simulation.getView(path).grid.cells.find((c) => c.type === "hotMirror").temperature, 0);
  assert.equal(r.simulation.getView(secondPath).grid.cells.find((c) => c.type === "hotMirror").temperature, 0);
  const tick = r.simulation.tick;
  r.solve();
  assert.equal(r.simulation.tick, tick);
  assert.equal(r.simulation.getView(path).grid.cells.find((c) => c.type === "hotMirror").temperature, 0);
  assert.equal(r.step().targets[0].rawIncoming, 7);
  const activeView = r.simulation.getView(path);
  assert.deepEqual(activeView.outputs, [{ dir: 2, color: 7 }]);
  assert.equal(activeView.grid.cells.find((c) => c.type === "inputPort" && c.x === 0).inputColor, 7);
  assert.equal(activeView.grid.cells.find((c) => c.type === "outputPort" && c.x === 4).outputColor, 7);
  assert.equal(r.step().targets[0].lit, true);
  const passthrough = { ...chip, placement: [chip.placement[0], { ...chip.placement[5], x: 2 }] };
  const immediate = rig([source, a, bulb], { ...level, chips: [passthrough] });
  assert.equal(immediate.step().targets[0].rawIncoming, 7);
});

test("冷热镜通路与侧面控制独立，斜光被挡，冷热镜分别反向和正向响应", () => {
  const core = require("../scripts/light-core.js");
  for (const type of ["coldMirror", "hotMirror"]) for (const orient of [0, 1]) {
    for (const dir of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const { dx, dy } = core.DIRECTIONS[dir];
      const normal = orient === 0 ? dx === 0 : dy === 0;
      assert.deepEqual(core.transmit(type, orient, dx, dy, 7, undefined, true), normal ? [{ dx, dy, color: 7 }] : []);
      assert.deepEqual(core.transmit(type, orient, dx, dy, 7, undefined, false), []);
    }
    const sideSource = { type: "directionalEmitter", x: orient === 0 ? -2 : 0,
      y: orient === 0 ? 0 : -2, orient: orient === 0 ? 1 : 2 };
    const sideBulb = { type: "bulb", x: orient === 0 ? 2 : 0, y: orient === 0 ? 0 : 2, orient: 0 };
    const r = rig([sideSource, { type, x: 0, y: 0, orient }, sideBulb]);
    for (let n = 0; n < 30; n++) {
      assert.equal(r.step().targets[0].rawIncoming, 0);
      assert.equal(r.result.grid.cells.find((c) => c.type === type).temperature, n >= 1 ? 1 : 0);
    }
  }
});

test("冷镜侧面非门随芯片四向旋转，嵌套旋转后通路与控制仍独立", () => {
  const core = require("../scripts/light-core.js");
  const base = { id: "cold-control", name: "侧控冷镜", placement: [
    { type: "inputPort", x: -2, y: 0, orient: 1 },
    { type: "inputPort", x: 0, y: -2, orient: 2 },
    { type: "coldMirror", x: 0, y: 0, orient: 1 },
    { type: "outputPort", x: 2, y: 0, orient: 3 },
  ] };
  const inner = { type: "chip", x: 0, y: 0, orient: 1, chipId: base.id };
  const wrapper = { id: "wrapped-cold", name: "旋转子芯片", placement: [
    { type: "inputPort", x: 0, y: -3, orient: 2 },
    { type: "inputPort", x: 3, y: 0, orient: 3 }, inner,
    { type: "outputPort", x: 0, y: 3, orient: 0 },
  ] };
  for (const nested of [false, true]) for (let rotation = 0; rotation < 4; rotation++) {
    const total = rotation + (nested ? 1 : 0);
    const axialDir = (2 + total * 2) % 8, controlDir = (4 + total * 2) % 8;
    const axial = core.DIRECTIONS[axialDir], side = core.DIRECTIONS[controlDir];
    const power = { type: "directionalEmitter", x: -axial.dx * 4, y: -axial.dy * 4, orient: axialDir / 2 };
    const control = { type: "directionalEmitter", x: -side.dx * 4, y: -side.dy * 4, orient: controlDir / 2 };
    const output = { type: "bulb", x: axial.dx * 4, y: axial.dy * 4, orient: 0 };
    const instance = { type: "chip", x: 0, y: 0, orient: rotation, chipId: nested ? wrapper.id : base.id };
    const board = [power, instance, output];
    const r = rig(board, { ...level, chips: [base, wrapper] });
    for (let n = 0; n < 30; n++) assert.equal(r.step().targets[0].rawIncoming, 7);
    r.solve([...board, control]);
    assert.equal(r.step().targets[0].rawIncoming, 7);
    for (let n = 0; n < 30; n++) assert.equal(r.step().targets[0].rawIncoming, 0);
    let path = r.simulation.childPath("root", instance);
    if (nested) path = r.simulation.childPath(path, inner);
    const cold = r.simulation.getView(path).grid.cells.find((cell) => cell.type === "coldMirror");
    assert.equal(cold.receiving, true);
    assert.equal(cold.open, false);
    r.solve(board);
    assert.equal(r.result.targets[0].rawIncoming, 0);
    assert.equal(r.step().targets[0].rawIncoming, 7);
    assert.equal(r.result.overflow, false);
  }
});

test("六层嵌套芯片传光不增加拍数，内部热镜仍按自身时间运行", () => {
  const chips = [{ id: "base", name: "热镜", placement: [
    { type: "inputPort", x: 0, y: 0, orient: 1 },
    { type: "splitter", x: 1, y: 0, orient: 0 },
    { type: "mirror", x: 1, y: -1, orient: 0 }, { type: "mirror", x: 3, y: -1, orient: 1 },
    { type: "hotMirror", x: 3, y: 0, orient: 1 }, { type: "outputPort", x: 4, y: 0, orient: 3 },
  ] }];
  for (let n = 1; n <= 6; n++) chips.push({ id: "layer" + n, name: "第" + n + "层", placement: [
    { type: "inputPort", x: 0, y: 0, orient: 1 },
    { type: "chip", x: 1, y: 0, orient: 0, chipId: chips[n - 1].id },
    { type: "outputPort", x: 2, y: 0, orient: 3 },
  ] });
  const r = rig([source, { type: "chip", x: 2, y: 0, orient: 0, chipId: "layer6" }, bulb], { ...level, chips });
  assert.equal(r.step().targets[0].rawIncoming, 0);
  assert.equal(r.step().targets[0].rawIncoming, 7);
  assert.equal(r.step().targets[0].lit, true);
  assert.equal(r.result.overflow, false);
});
