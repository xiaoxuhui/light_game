"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const core = require("../scripts/light-core.js");
const engine = require("../scripts/light-engine.js");
const levels = require("../scripts/levels.js");
const storage = require("../scripts/storage.js");

const scene = {
  schema: levels.SCHEMA, version: 1, mode: "free", sourceLevelId: "t01",
  id: "free:t01", title: "白光实验", chapter: 0, par: 0, cols: 7, rows: 7,
  fixed: [], targets: [],
  inventory: Object.fromEntries(core.FREE_PLACEABLE_TYPES.map((type) => [type, 999])),
};
const source = { type: "emitter", x: 3, y: 3, orient: 0 };
const wall = { type: "wall", x: 4, y: 3, orient: 0 };

test("自由光源默认白光，精确向上下左右四面发射", () => {
  const result = engine.solve(scene, [source]);
  const first = result.segments.filter((s) => s.from.x === 3 && s.from.y === 3);
  assert.deepEqual(first.map((s) => s.to), [{ x: 3, y: 2 }, { x: 4, y: 3 }, { x: 3, y: 4 }, { x: 2, y: 3 }]);
  assert.ok(result.segments.every((s) => s.color === 7));
  assert.equal(result.rejected.length, 0);
  assert.equal(engine.solve(scene, []).segments.length, 0);
});

test("墙截断白光，镜片改变白光方向，擦墙恢复光路", () => {
  const blocked = engine.solve(scene, [source, wall]);
  assert.ok(blocked.segments.some((s) => s.to.x === 4 && s.to.y === 3));
  assert.ok(!blocked.segments.some((s) => s.to.x > 4 && s.to.y === 3));
  const reflected = engine.solve(scene, [source, { type: "mirror", x: 4, y: 3, orient: 0 }]);
  assert.ok(reflected.segments.some((s) => s.from.x === 4 && s.from.y === 3 && s.to.x === 4 && s.to.y === 2 && s.color === 7));
  assert.ok(engine.solve(scene, [source]).segments.some((s) => s.to.x === 6 && s.to.y === 3));
});

test("关卡模式继续拒绝玩家放置光源和墙，不接受四向预设光源", () => {
  const level = { ...scene, mode: undefined };
  assert.equal(engine.solve(level, [source, wall]).rejected.length, 2);
  assert.equal(levels.validatePlacement(level, [source, wall]).ok, false);
  assert.equal(levels.validateLevel({ ...level, fixed: [{ type: "emitter", x: 3, y: 3, dir: "all", color: 7 }] }).ok, false);
});

test("自由墙和光源经过存档、工作台和导出导入后完整保留", () => {
  const placement = [source, wall];
  const saved = storage.parseSave(storage.serializeSave({ ...storage.emptySave(), freeBoards: { t01: placement } }));
  assert.deepEqual(saved.freeBoards.t01, placement);
  const snapshot = storage.addSnapshot(saved, { levelId: scene.id, name: "白光与墙", placement });
  assert.equal(snapshot.ok, true);
  assert.deepEqual(storage.parseSave(storage.serializeSave(snapshot.save)).snapshots[0].placement, placement);
  const imported = storage.parseLevelFile(storage.serializeLevelFile(scene, placement));
  assert.equal(imported.ok, true, imported.errors.join("; "));
  assert.deepEqual(imported.placement, placement);
  assert.equal(imported.level.mode, "free");
  assert.deepEqual(storage.normalizePlacement(placement), []);
});

test("无限光路跨越百万格及负坐标，内存只存元件，输出灯泡遇光亮起", () => {
  const free = { ...scene, infinite: true, sceneVersion: 2 };
  const placed = [{ ...source, x: 1000000, y: -5000 }, { type: "bulb", x: -1000000, y: -5000, orient: 0 }];
  const result = engine.solve(free, placed);
  assert.equal(result.grid.cells.length, 2);
  assert.equal(result.segments.length, 4);
  assert.equal(result.targets[0].lit, true);
  assert.equal(result.targets[0].incoming, 7);
  assert.equal(engine.cellAt(result.grid, -1000000, -5000).bulb, true);
  const parsed = storage.parseLevelFile(storage.serializeLevelFile(free, placed));
  assert.equal(parsed.ok, true, parsed.errors.join("; "));
  assert.deepEqual(parsed.placement, placed);
});

test("无限板中单色光也可点亮灯泡；墙阻挡，移除光源后灯泡熄灭", () => {
  const free = { ...scene, infinite: true };
  const bulb = { type: "bulb", x: 4, y: 1, orient: 0 };
  const prism = { type: "prism", x: 4, y: 3, orient: 0 };
  const result = engine.solve(free, [source, prism, bulb]);
  assert.equal(result.targets[0].incoming, 1);
  assert.equal(result.targets[0].lit, true);
  assert.equal(engine.solve(free, [source, prism, bulb, { type: "wall", x: 4, y: 2 }]).targets[0].lit, false);
  assert.equal(engine.solve(free, [prism, bulb]).targets[0].lit, false);
  assert.equal(engine.solve(free, [source], { maxSegments: 2 }).overflow, true);
});

test("单向光源四态旋转，冷热镜静态初态分别关闭和开启", () => {
  const level = { ...scene, infinite: true };
  for (let orient = 0; orient < 4; orient++) {
    const result = engine.solve(level, [{ type: "directionalEmitter", x: 0, y: 0, orient }]);
    assert.equal(result.segments.length, 1);
    const segment = result.segments[0];
    assert.equal(core.directionIndexFromVector(Math.sign(segment.to.x), Math.sign(segment.to.y)), orient * 2);
  }
  const routes = (type, orient, dx, dy) => core.transmit(type, orient, dx, dy, 7)
    .map((out) => [core.directionIndexFromVector(out.dx, out.dy), out.color]);
  assert.deepEqual(routes("hotMirror", 0, 0, 1), []);
  assert.deepEqual(routes("coldMirror", 0, 0, 1), [[4, 7]]);
  assert.deepEqual(routes("hotMirror", 1, 1, 0), []);
  assert.deepEqual(routes("coldMirror", 1, 1, 0), [[2, 7]]);
  assert.deepEqual(routes("coldMirror", 0, 1, 0), []);
  assert.deepEqual(routes("coldMirror", 1, 0, 1), []);
});

test("芯片从右入光匹配向左 IO，没有对应 IO 则挡光", () => {
  const chip = { id: "left", name: "左通", placement: [
    { type: "io", x: 2, y: 0, orient: 3 }, { type: "io", x: 0, y: 0, orient: 1 },
  ] };
  const placed = [{ type: "directionalEmitter", x: 5, y: 0, orient: 3 },
    { type: "chip", x: 2, y: 0, orient: 0, chipId: chip.id }, { type: "bulb", x: 0, y: 0, orient: 0 }];
  assert.equal(engine.solve({ ...scene, infinite: true, chips: [chip] }, placed).targets[0].lit, true);
  const wrong = { ...chip, placement: chip.placement.map((io) => ({ ...io, orient: 0 })) };
  const unmatched = engine.solve({ ...scene, infinite: true, chips: [wrong] }, placed);
  assert.equal(unmatched.targets[0].lit, false);
  assert.equal(unmatched.grid.cells.find((cell) => cell.type === "chip").inputColors[6], 7);
  assert.equal(engine.solve({ ...scene, infinite: true }, [{ type: "io", x: 0, y: 0, orient: 0 }]).rejected.length, 1);
});

test("芯片匹配入口后按内部线路处理，墙或断路不能由外壳透光绕过", () => {
  const chip = { id: "blocked", name: "挡光", placement: [
    { type: "inputPort", x: 0, y: 0, orient: 1 }, { type: "wall", x: 1, y: 0, orient: 0 },
    { type: "outputPort", x: 2, y: 0, orient: 3 },
  ] };
  const placed = [{ type: "directionalEmitter", x: -2, y: 0, orient: 1 },
    { type: "chip", x: 0, y: 0, orient: 0, chipId: chip.id }, { type: "bulb", x: 2, y: 0, orient: 0 }];
  const solve = (definition) => engine.solve({ ...scene, infinite: true, chips: [definition] }, placed);
  const blocked = solve(chip);
  assert.equal(blocked.targets[0].lit, false);
  const signals = blocked.grid.cells.find((cell) => cell.type === "chip");
  assert.equal(signals.inputColors[2], 7);
  assert.deepEqual(signals.portDirections, [2, 6]);
  assert.equal(signals.outputColors.some(Boolean), false);
  assert.equal(solve({ ...chip, placement: [chip.placement[0]] }).targets[0].lit, false);
  assert.equal(solve({ ...chip, placement: chip.placement.filter((p) => p.type !== "wall") }).targets[0].lit, true);
});

test("IO箭头指向内部、向外输出反向；旋转芯片同时旋转内外方向", () => {
  const chip = { id: "turn", name: "转向", placement: [
    { type: "io", x: 0, y: 0, orient: 1 }, { type: "mirror", x: 1, y: 0, orient: 0 },
    { type: "io", x: 1, y: -1, orient: 2 },
  ] };
  const level = { ...scene, infinite: true, chips: [chip] };
  const result = engine.solve(level, [{ type: "directionalEmitter", x: -2, y: 0, orient: 1 },
    { type: "chip", x: 0, y: 0, orient: 0, chipId: "turn" }, { type: "bulb", x: 0, y: -2, orient: 0 }]);
  assert.equal(result.targets[0].lit, true);
  const rotated = engine.solve(level, [{ type: "directionalEmitter", x: 0, y: -2, orient: 2 },
    { type: "chip", x: 0, y: 0, orient: 1, chipId: "turn" }, { type: "bulb", x: 2, y: 0, orient: 0 }]);
  assert.equal(rotated.targets[0].lit, true);
});

test("旧输入口和输出口统一为双向IO规则，方向直接来自箭头", () => {
  const chip = { id: "ports", name: "分离端口", placement: [
    { type: "inputPort", x: 0, y: 0, orient: 1 }, { type: "mirror", x: 1, y: 0, orient: 0 },
    { type: "outputPort", x: 1, y: -1, orient: 2 },
  ] };
  for (let orient = 0; orient < 4; orient++) {
    const inputDir = (2 + orient * 2) % 8;
    const outputDir = orient * 2;
    const a = core.DIRECTIONS[inputDir], b = core.DIRECTIONS[outputDir];
    const result = engine.solve({ ...scene, infinite: true, chips: [chip] }, [
      { type: "directionalEmitter", x: -a.dx * 2, y: -a.dy * 2, orient: inputDir / 2 },
      { type: "chip", x: 0, y: 0, chipId: chip.id, orient },
      { type: "bulb", x: b.dx * 2, y: b.dy * 2, orient: 0 },
    ]);
    assert.equal(result.targets[0].lit, true);
    const cell = result.grid.cells.find((part) => part.type === "chip");
    assert.deepEqual(cell.portDirections, [inputDir, (outputDir + 4) % 8]);
    assert.deepEqual(cell.outputDirections, [(inputDir + 4) % 8, outputDir]);
  }
  const noInput = engine.solve({ ...scene, infinite: true, chips: [{ ...chip, placement: [chip.placement[2]] }] }, [
    { type: "directionalEmitter", x: -2, y: 0, orient: 1 },
    { type: "chip", x: 0, y: 0, chipId: chip.id, orient: 0 }, { type: "bulb", x: 0, y: -2, orient: 0 },
  ]);
  assert.equal(noInput.targets[0].lit, false, "无匹配箭头方向时仍不能注入光");
});

test("三种旧端口类型可互换收发，四向旋转无额外反转，存档保留原始箭头", () => {
  for (const entryType of core.CHIP_PORT_TYPES) for (const exitType of core.CHIP_PORT_TYPES) {
    const chip = { id: "unified", name: "统一IO", placement: [
      { type: entryType, x: -1, y: 0, orient: 1 },
      { type: "mirror", x: 1, y: 0, orient: 0 },
      { type: exitType, x: 1, y: -1, orient: 2 },
    ] };
    const saved = storage.parseSave(storage.serializeSave({ ...storage.emptySave(), chips: [chip] }));
    assert.deepEqual(saved.chips[0], chip);
    for (let rotation = 0; rotation < 4; rotation++) {
      const inputDir = (2 + rotation * 2) % 8, outputDir = rotation * 2;
      const a = core.DIRECTIONS[inputDir], b = core.DIRECTIONS[outputDir];
      const result = engine.solve({ ...scene, infinite: true, chips: saved.chips }, [
        { type: "directionalEmitter", x: -a.dx * 3, y: -a.dy * 3, orient: inputDir / 2 },
        { type: "chip", x: 0, y: 0, orient: rotation, chipId: chip.id },
        { type: "bulb", x: b.dx * 3, y: b.dy * 3, orient: 0 },
      ]);
      assert.equal(result.targets[0].lit, true, entryType + " → " + exitType + " 旋转" + rotation);
    }
  }
});

test("IO箭头标注外到内方向：内部反向来光向外输出，顺向继续进内部，侧光挡住", () => {
  for (const type of core.CHIP_PORT_TYPES) for (let orient = 0; orient < 4; orient++) {
    for (const incomingDir of [0, 2, 4, 6]) for (let rotation = 0; rotation < 4; rotation++) {
      const vector = core.DIRECTIONS[incomingDir];
      const chip = { id: "direction-check", name: "入口规则", placement: [
        { type: "directionalEmitter", x: -vector.dx * 2, y: -vector.dy * 2, orient: incomingDir / 2 },
        { type, x: 0, y: 0, orient },
      ] };
      const result = engine.solve({ ...scene, infinite: true, chips: [chip] }, [
        { type: "chip", x: 0, y: 0, orient: rotation, chipId: chip.id },
        ...[0, 2, 4, 6].map((dir) => ({ type: "bulb", x: core.DIRECTIONS[dir].dx * 3,
          y: core.DIRECTIONS[dir].dy * 3, orient: 0 })),
      ]);
      const direction = (incomingDir + rotation * 2) % 8;
      assert.deepEqual(result.targets.map((target) => target.lit), [0, 2, 4, 6].map((dir) =>
        incomingDir === (orient * 2 + 4) % 8 && dir === direction), type + " 箭头" + orient + " 来光" + incomingDir + " 旋转" + rotation);
    }
  }
});

test("顺箭头来光保留旧入口特性，继续走内部线路而不是提前出芯片", () => {
  for (const type of core.CHIP_PORT_TYPES) {
    const result = engine.solve({ ...scene, infinite: true, insideChip: true }, [
      { type: "directionalEmitter", x: 0, y: 2, orient: 0 },
      { type, x: 0, y: 0, orient: 0 },
      { type: "bulb", x: 0, y: -2, orient: 0 },
    ]);
    assert.equal(result.targets[0].lit, true);
    assert.deepEqual(result.outputs, []);
  }
});

test("嵌套芯片及旧端口存档、文件往返完整；拒绝循环和缺失引用", () => {
  const child = { id: "child", name: "子芯片", placement: [
    { type: "inputPort", x: 0, y: 0, orient: 1 }, { type: "outputPort", x: 2, y: 0, orient: 3 },
  ] };
  const parent = { id: "parent", name: "父芯片", placement: [
    child.placement[0], { type: "chip", x: 1, y: 0, orient: 0, chipId: child.id }, child.placement[1],
  ] };
  const chips = [parent, child];
  const board = [{ type: "directionalEmitter", x: -2, y: 0, orient: 1 },
    { type: "chip", x: 0, y: 0, orient: 0, chipId: parent.id }, { type: "bulb", x: 2, y: 0, orient: 0 }];
  assert.equal(engine.solve({ ...scene, infinite: true, chips }, board).targets[0].lit, true);
  assert.deepEqual(storage.parseSave(storage.serializeSave({ ...storage.emptySave(), chips })).chips, chips);
  const encode = (definitions) => storage.serializeLevelFile({ ...scene, infinite: true, chips: definitions }, board);
  const parsed = storage.parseLevelFile(encode(chips));
  assert.equal(parsed.ok, true, parsed.errors.join("; "));
  assert.deepEqual(parsed.level.chips, chips);
  assert.equal(storage.parseLevelFile(encode([parent])).ok, false);
  const cycle = [parent, { ...child, placement: [{ type: "chip", x: 0, y: 0, orient: 0, chipId: parent.id }] }];
  assert.match(storage.parseLevelFile(encode(cycle)).errors.join("; "), /循环/);
  assert.equal(engine.solve({ ...scene, infinite: true, chips: cycle }, board).overflow, true);
  const removed = storage.removeChip({ ...storage.emptySave(), chips }, child.id);
  assert.equal(removed.removedNestedInstances, 1);
  assert.equal(removed.save.chips[0].placement.some((part) => part.type === "chip"), false);
});

test("芯片从下入光匹配向上 IO；内部光源可向 IO 对应外侧独立输出", () => {
  const chip = { id: "up", name: "上通", placement: [
    { type: "io", x: 0, y: 2, orient: 0 }, { type: "io", x: 0, y: 0, orient: 2 },
  ] };
  const board = [{ type: "directionalEmitter", x: 0, y: 4, orient: 0 },
    { type: "chip", x: 0, y: 2, orient: 0, chipId: "up" }, { type: "bulb", x: 0, y: 0, orient: 0 }];
  assert.equal(engine.solve({ ...scene, infinite: true, chips: [chip] }, board).targets[0].lit, true);
  const active = { ...chip, placement: [{ type: "directionalEmitter", x: 0, y: 1, orient: 0 }, chip.placement[1]] };
  assert.equal(engine.solve({ ...scene, infinite: true, chips: [active] }, board.slice(1)).targets[0].lit, true);
});

test("命名芯片、IO 朝向和芯片实例经过存档和文件往返后不丢失", () => {
  const chip = { id: "chip-save", name: "我的芯片", placement: [{ type: "io", x: -3, y: 2, orient: 3 }] };
  const placed = [{ type: "chip", x: -100, y: 50, orient: 2, chipId: chip.id }];
  const saved = storage.parseSave(storage.serializeSave({ ...storage.emptySave(), chips: [chip], freeBoards: { t01: placed } }));
  assert.deepEqual(saved.chips, [chip]);
  assert.deepEqual(saved.freeBoards.t01, placed);
  const parsed = storage.parseLevelFile(storage.serializeLevelFile({ ...scene, infinite: true, chips: [chip] }, placed));
  assert.equal(parsed.ok, true, parsed.errors.join("; "));
  assert.deepEqual(parsed.placement, placed);
  assert.deepEqual(parsed.level.chips, [chip]);
});

test("删除芯片清理各实验板与工作台中的引用，保留其他元件且不修改输入存档", () => {
  const a = { type: "chip", chipId: "a", x: 0, y: 0, orient: 0 };
  const b = { type: "chip", chipId: "b", x: 1, y: 0, orient: 1 };
  const mirror = { type: "mirror", x: 2, y: 0, orient: 0 };
  const saved = { ...storage.emptySave(), stars: { t01: 3 },
    chips: [{ id: "a", name: "待删", placement: [] }, { id: "b", name: "保留", placement: [] }],
    freeBoards: { t02: [a, b, mirror], t03: [a] }, freeBoardVersions: { t02: 2, t03: 2 },
    snapshots: [{ name: "混合", levelId: "free:t02", placement: [a, mirror], sceneVersion: 2 }],
  };
  const before = JSON.stringify(saved);
  const result = storage.removeChip(saved, "a");
  assert.equal(result.removedInstances, 2);
  assert.equal(result.removedSnapshotInstances, 1);
  assert.deepEqual(result.save.chips.map((chip) => chip.id), ["b"]);
  assert.deepEqual(result.save.freeBoards.t02, [b, mirror]);
  assert.deepEqual(result.save.freeBoards.t03, []);
  assert.deepEqual(result.save.snapshots[0].placement, [mirror]);
  assert.deepEqual(result.save.stars, { t01: 3 });
  assert.equal(JSON.stringify(saved), before);
});

test("棱镜四向旋转同时改变输入面与 RGB 出口，其他入射面不能穿过", () => {
  for (let facing = 0; facing < 4; facing++) {
    const entry = (2 + facing * 2) % 8;
    for (let dir = 0; dir < 8; dir++) {
      const incoming = core.DIRECTIONS[dir];
      const outgoing = core.transmit("prism", 0, incoming.dx, incoming.dy, 7, facing);
      if (dir !== entry) assert.deepEqual(outgoing, [], `facing=${facing} 应拒绝 dir=${dir}`);
      else assert.deepEqual(outgoing.map((beam) => [core.directionIndexFromVector(beam.dx, beam.dy), beam.color]),
        [[(entry + 6) % 8, 1], [entry, 2], [(entry + 2) % 8, 4]]);
    }
    const vector = core.DIRECTIONS[entry];
    const source = { type: "emitter", x: 3 - vector.dx * 2, y: 3 - vector.dy * 2, dir: entry, color: 7 };
    const targets = [-2, 0, 2].map((delta, index) => {
      const direction = core.DIRECTIONS[(entry + delta + 8) % 8];
      return { x: 3 + direction.dx * 2, y: 3 + direction.dy * 2, require: [1, 2, 4][index] };
    });
    const level = { cols: 7, rows: 7, fixed: [source], targets };
    const prism = { type: "prism", x: 3, y: 3, orient: 0, facing };
    assert.equal(engine.solve(level, [prism]).allLit, true, `有限关卡 facing=${facing}`);
    const free = { ...scene, infinite: true };
    const placed = [prism, { type: "directionalEmitter", x: source.x, y: source.y, orient: entry / 2 },
      ...targets.map((target) => ({ type: "bulb", x: target.x, y: target.y, orient: 0 }))];
    const result = engine.solve(free, placed);
    assert.deepEqual(result.targets.map((target) => target.incoming), [1, 2, 4]);
  }
});

test("棱镜输入方向与颜色顺序独立保存，实验板和芯片文件往返不丢失", () => {
  const prism = { type: "prism", x: 3, y: 3, orient: 2, facing: 3 };
  const chip = { id: "rotated-prism", name: "朝上输入", placement: [prism] };
  const saved = storage.parseSave(storage.serializeSave({ ...storage.emptySave(), chips: [chip], freeBoards: { t01: [prism] } }));
  assert.deepEqual(saved.freeBoards.t01, [prism]);
  assert.deepEqual(saved.chips[0].placement, [prism]);
  const parsed = storage.parseLevelFile(storage.serializeLevelFile({ ...scene, infinite: true, chips: [chip] }, [prism]));
  assert.equal(parsed.ok, true, parsed.errors.join("; "));
  assert.deepEqual(parsed.placement, [prism]);
  assert.deepEqual(parsed.level.chips[0].placement, [prism]);
});

test("每拍时长设置存档往返保持，非法时长不进入存档", () => {
  for (const stepMs of [50, 100, 125, 500, 1000, 3600000]) {
    const save = storage.parseSave(storage.serializeSave({ ...storage.emptySave(), stepMs }));
    assert.equal(save.stepMs, stepMs);
  }
  for (const stepMs of [0, -1, 49, 3600001, "100", null, NaN]) {
    assert.equal(storage.normalizeSave({ stepMs }).stepMs, undefined);
  }
});
