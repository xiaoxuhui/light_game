"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../scripts/light-core.js");
const engine = require("../scripts/light-engine.js");
const levels = require("../scripts/levels.js");
const storage = require("../scripts/storage.js");
const { createSimulation } = require("../scripts/simulation.js");

const appearance = (cols, rows, extra = {}) => core.normalizeChipAppearance({ cols, rows, cells: [], ...extra });
const scene = { ...levels.getLevel("t02"), mode: "free", id: "free:t02", sourceLevelId: "t02", infinite: true,
  fixed: [], targets: [], inventory: Object.fromEntries(core.FREE_PLACEABLE_TYPES.map((type) => [type, 999])) };
const straight = () => [{ type: "inputPort", x: -10, y: 5, orient: 1 }, { type: "outputPort", x: 10, y: 5, orient: 3 }];
const definition = { id: "addressed", name: "分格芯片", appearance: appearance(3, 3), placement: [],
  circuits: [0, 2].flatMap((y) => [0, 1, 2].map((x) => ({ x, y, placement: straight() }))) };
const bulb = (x, y) => ({ type: "bulb", x, y, orient: 0 });
const source = (x, y, orient = 1) => ({ type: "directionalEmitter", x, y, orient });

test("异形轮廓、颜色、文字及唯一朝上箭头完整存档及文件往返，编辑不修改原数据", () => {
  const design = appearance(3, 2, { shape: [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    cells: [{ x: 1, y: 0, color: "#235c55", text: "时钟", arrow: true }] });
  const chip = { id: "shape", name: "自定义", appearance: design, placement: [] };
  const before = JSON.stringify(chip);
  const saved = storage.parseSave(storage.serializeSave({ ...storage.emptySave(), chips: [chip] }));
  assert.deepEqual(saved.chips[0], chip);
  const parsed = storage.parseLevelFile(storage.serializeLevelFile({ ...scene, chips: [chip] }, []));
  assert.equal(parsed.ok, true, parsed.errors.join("; "));
  assert.deepEqual(parsed.level.chips[0], chip);
  assert.equal(JSON.stringify(chip), before);
  assert.equal(appearance(3, 2, { shape: [] }), null);
  assert.equal(appearance(3, 2, { shape: [{ x: 0, y: 0 }], cells: [{ x: 1, y: 0, color: "#235c55", text: "越界", arrow: false }] }), null);
  assert.equal(appearance(2, 1, { cells: [0, 1].map((x) => ({ x, y: 0, color: "#235c55", text: "", arrow: true })) }), null);
});

test("异形实际占格、空洞允许放置元件，四向旋转及内外坐标互为逆变换", () => {
  const chip = { ...definition, circuits: [], appearance: appearance(3, 2, { shape: [
    { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 },
  ] }) };
  for (let orient = 0; orient < 4; orient++) {
    const instance = { type: "chip", x: 10, y: 10, orient, chipId: chip.id };
    assert.equal(core.placementFootprint(instance, [chip]).length, 4);
    for (const point of chip.appearance.shape) {
      assert.deepEqual(core.chipLocalPoint(chip, instance, core.chipWorldPoint(chip, instance, point)), point);
    }
  }
  const instance = { type: "chip", x: 10, y: 10, orient: 0, chipId: chip.id };
  const allowed = engine.solve({ ...scene, chips: [chip] }, [instance, { type: "wall", x: 9, y: 10, orient: 0 }]);
  assert.equal(allowed.rejected.length, 0);
  assert.equal(allowed.placedCount, 2);
  assert.equal(allowed.grid.byPosition.get("9,11").type, "chipPart");
  const overlap = engine.solve({ ...scene, chips: [chip] }, [instance, { type: "wall", x: 9, y: 11, orient: 0 }]);
  assert.equal(overlap.rejected.length, 1);
  assert.equal(overlap.grid.byPosition.get("9,11").type, "chipPart");
});

test("同一外环方向的不同格输入互不广播，输出回到对应格，旋转保持位置关系", () => {
  for (let orient = 0; orient < 4; orient++) {
    const instance = { type: "chip", x: 10, y: 10, orient, chipId: definition.id };
    const dir = (2 + orient * 2) % 8, vector = core.DIRECTIONS[dir];
    const input = core.chipWorldPoint(definition, instance, { x: 0, y: 0 });
    const output = core.chipWorldPoint(definition, instance, { x: 2, y: 0 });
    const other = core.chipWorldPoint(definition, instance, { x: 2, y: 2 });
    const result = engine.solve({ ...scene, chips: [definition] }, [instance,
      source(input.x - vector.dx * 2, input.y - vector.dy * 2, dir / 2),
      bulb(output.x + vector.dx * 2, output.y + vector.dy * 2), bulb(other.x + vector.dx * 2, other.y + vector.dy * 2)]);
    assert.deepEqual(result.targets.map((target) => target.incoming), [7, 0], "旋转 " + orient);
  }
});

test("同方向双格同时输入各自出光，缓存包含格子地址；没有对应 IO 的边缘格挡光", () => {
  const instance = { type: "chip", x: 10, y: 10, orient: 0, chipId: definition.id };
  const dual = engine.solve({ ...scene, chips: [definition] }, [instance, source(8, 10), source(8, 12), bulb(14, 10), bulb(14, 12)]);
  assert.deepEqual(dual.targets.map((target) => target.incoming), [7, 7]);
  const empty = engine.solve({ ...scene, chips: [definition] }, [instance, source(8, 11), bulb(14, 10), bulb(14, 11), bulb(14, 12)]);
  assert.deepEqual(empty.targets.map((target) => target.incoming), [0, 0, 0]);
  assert.equal(empty.grid.cells.find((cell) => cell.type === "chip").acceptedInputColors[2], 0);
});

test("每格的独立内部网格可使用任意坐标和嵌套芯片，外层仍回到对应格子", () => {
  const parent = { id: "parent", name: "大外壳", appearance: appearance(1, 2), placement: [], circuits: [
    { x: 0, y: 0, placement: straight() },
    { x: 0, y: 1, placement: [
      { type: "inputPort", x: -5, y: 0, orient: 1 },
      { type: "chip", x: 0, y: -2, orient: 0, chipId: definition.id },
      { type: "outputPort", x: 5, y: 0, orient: 3 },
    ] },
  ] };
  const chips = [definition, parent];
  assert.equal(core.chipLayoutError(parent, chips), null);
  const result = engine.solve({ ...scene, chips }, [
    { type: "chip", x: 10, y: 10, orient: 0, chipId: parent.id }, source(8, 11), bulb(13, 10), bulb(13, 11),
  ]);
  assert.deepEqual(result.targets.map((target) => target.incoming), [0, 7]);
});

test("导入拒绝身体重叠、无对应外层格的线路及格子内的循环引用", () => {
  const encode = (chip, board = []) => storage.serializeLevelFile({ ...scene, chips: [chip] }, board);
  const overlap = storage.parseLevelFile(encode(definition, [
    { type: "chip", x: 0, y: 0, orient: 0, chipId: definition.id }, { type: "wall", x: 1, y: 1, orient: 0 },
  ]));
  assert.equal(overlap.ok, false);
  assert.equal(storage.parseLevelFile(encode({ ...definition, circuits: [{ x: 4, y: 1, placement: straight() }] })).ok, false);
  assert.equal(storage.parseLevelFile(encode({ ...definition, circuits: [{ x: 0, y: 0,
    placement: [{ type: "chip", x: 0, y: 0, orient: 0, chipId: definition.id }] }] })).ok, false);
  const valid = storage.parseLevelFile(encode(definition));
  assert.equal(valid.ok, true, valid.errors.join("; "));
  assert.deepEqual(valid.level.chips[0].circuits, definition.circuits);
});

test("相邻格内部热镜各延迟一拍且状态独立，实时外层视图保留各格收发状态", () => {
  const placement = [{ type: "inputPort", x: 0, y: 0, orient: 1 },
    { type: "splitter", x: 1, y: 0, orient: 0 },
    { type: "mirror", x: 1, y: -1, orient: 0 }, { type: "mirror", x: 3, y: -1, orient: 1 },
    { type: "hotMirror", x: 3, y: 0, orient: 1 }, { type: "outputPort", x: 4, y: 0, orient: 3 }];
  const chip = { id: "timed-cells", name: "两格延迟", appearance: appearance(2, 1), placement: [],
    circuits: [{ x: 0, y: 0, placement }, { x: 1, y: 0, placement }] };
  const instance = { type: "chip", x: 0, y: 0, orient: 0, chipId: chip.id };
  const board = [source(-2, 0), instance, bulb(4, 0)], simulation = createSimulation();
  const solve = () => simulation.solve({ ...scene, chips: [chip] }, board);
  solve(); simulation.advance(); solve(); simulation.advance();
  const second = solve();
  assert.equal(second.targets[0].rawIncoming, 0);
  const outer = simulation.getView(simulation.childPath("root", instance));
  assert.equal(outer.grid.cells.find((cell) => cell.x === 0).outputColors[2], 7);
  assert.equal(outer.grid.cells.find((cell) => cell.x === 1).inputColors[2], 7);
  assert.equal(outer.grid.cells.find((cell) => cell.x === 1).outputColors[2], 0);
  simulation.advance(); assert.equal(solve().targets[0].rawIncoming, 7);
  simulation.advance(); assert.equal(solve().targets[0].lit, true);
});

test("删除被格子内部引用的芯片会清理引用，保留外形及该格其他线路", () => {
  const child = { id: "leaf", name: "子芯片", placement: [] };
  const wall = { type: "wall", x: 5, y: 5, orient: 0 };
  const parent = { id: "parent", name: "父芯片", appearance: appearance(1, 1), placement: [], circuits: [
    { x: 0, y: 0, placement: [{ type: "chip", x: 0, y: 0, orient: 0, chipId: child.id }, wall] },
  ] };
  const result = storage.removeChip({ ...storage.emptySave(), chips: [child, parent] }, child.id);
  assert.equal(result.removedNestedInstances, 1);
  assert.deepEqual(result.save.chips[0].appearance, parent.appearance);
  assert.deepEqual(result.save.chips[0].circuits[0].placement, [wall]);
});

test("无限形状按稀疏点保存，跨越正负百万格不分配包围矩形", () => {
  const shape = [{ x: -1000000, y: 0 }, { x: 0, y: 0 }, { x: 1000000, y: 0 }];
  const design = core.normalizeChipAppearance({ shape, cells: [] });
  assert.equal(design.cols, 2000001);
  assert.deepEqual(design.shape, shape);
  const chip = { id: "infinite-shape", name: "无限形状", placement: [], appearance: design };
  const instance = { type: "chip", x: 0, y: 0, orient: 0, chipId: chip.id };
  const result = engine.solve({ ...scene, chips: [chip] }, [instance]);
  assert.equal(result.grid.cells.length, 3);
  assert.equal(result.grid.byPosition.size, 3);
  const imported = storage.parseLevelFile(storage.serializeLevelFile({ ...scene, chips: [chip] }, [instance]));
  assert.equal(imported.ok, true, imported.errors.join("; "));
  assert.deepEqual(imported.level.chips[0].appearance, design);
});
