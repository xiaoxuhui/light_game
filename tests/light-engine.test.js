"use strict";

// 光路求解器的单元测试：对应 doc/需求与测试用例.md 的 T11–T13，
// 外加若干端到端的小关卡断言（纯计算，不依赖浏览器）。

const assert = require("node:assert/strict");
const test = require("node:test");

const core = require("../scripts/light-core.js");
const engine = require("../scripts/light-engine.js");

const { R, G, B } = core.COLOR;
const { SLASH, BACKSLASH } = core.ORIENT;

const noInventory = { mirror: 0, splitter: 0, dichroicR: 0, dichroicG: 0, dichroicB: 0 };

/** 光段数量 */
const segmentCount = (result) => result.segments.length;

// ---------- 关卡夹具 ----------

/** 光直射即可命中目标 */
const LEVEL_STRAIGHT = {
  cols: 6,
  rows: 3,
  fixed: [{ type: "emitter", x: 0, y: 1, dir: "right", color: R }],
  targets: [{ x: 5, y: 1, require: R }],
  inventory: noInventory,
};

/** 需要一面镜子把光折向右上角的目标 */
const LEVEL_MIRROR = {
  cols: 5,
  rows: 5,
  fixed: [{ type: "emitter", x: 0, y: 4, dir: "right", color: R }],
  targets: [{ x: 4, y: 0, require: R }],
  inventory: { ...noInventory, mirror: 1 },
};

/** 需要分光镜同时点亮两个目标 */
const LEVEL_SPLIT = {
  cols: 7,
  rows: 5,
  fixed: [{ type: "emitter", x: 0, y: 2, dir: "right", color: R }],
  targets: [
    { x: 6, y: 2, require: R },
    { x: 3, y: 4, require: R },
  ],
  inventory: { ...noInventory, splitter: 1 },
};

/** 需要二向色镜把黄光拆成红光与绿光，各自送到对应的目标 */
const LEVEL_DICHROIC = {
  cols: 5,
  rows: 3,
  fixed: [{ type: "emitter", x: 0, y: 2, dir: "right", color: R | G }],
  targets: [
    { x: 2, y: 0, require: R },
    { x: 4, y: 2, require: G },
  ],
  inventory: { ...noInventory, dichroicR: 1 },
};

// ---------- 基本求解 ----------

test("直射关卡：无需放置元件即可点亮目标", () => {
  const result = engine.solve(LEVEL_STRAIGHT, []);

  assert.equal(result.allLit, true);
  assert.equal(result.placedCount, 0);
  assert.equal(segmentCount(result), 5, "从 (0,1) 到 (5,1) 共 5 段");
  assert.equal(result.overflow, false);
  assert.deepEqual(
    result.targets,
    [{ x: 5, y: 1, require: R, incoming: R, lit: true }],
  );
});

test("镜子关卡：未放置镜子时目标不亮，放对镜子即通关", () => {
  const before = engine.solve(LEVEL_MIRROR, []);
  assert.equal(before.allLit, false, "光会直冲出界，目标不该亮");
  assert.equal(before.targets[0].incoming, 0);

  const after = engine.solve(LEVEL_MIRROR, [
    { type: "mirror", x: 4, y: 4, orient: SLASH },
  ]);
  assert.equal(after.allLit, true, "`/` 镜把向右的光折向上，应命中 (4,0)");
  assert.equal(after.placedCount, 1);
  assert.equal(after.targets[0].incoming, R);
});

test("镜子关卡：朝错方向的镜子不能通关", () => {
  const wrong = engine.solve(LEVEL_MIRROR, [
    { type: "mirror", x: 4, y: 4, orient: BACKSLASH },
  ]);
  assert.equal(wrong.allLit, false, "`\\` 镜会把光折向下，走不到目标");
});

test("分光镜关卡：两束光分别命中两个目标", () => {
  const result = engine.solve(LEVEL_SPLIT, [
    { type: "splitter", x: 3, y: 2, orient: BACKSLASH },
  ]);

  assert.equal(result.allLit, true);
  const right = result.targets.find((target) => target.x === 6);
  const bottom = result.targets.find((target) => target.x === 3);
  assert.equal(right.lit, true, "透射束应命中右侧目标");
  assert.equal(bottom.lit, true, "反射束应命中下方目标");
});

test("分光镜关卡：不放分光镜时只有直射目标被点亮", () => {
  const result = engine.solve(LEVEL_SPLIT, []);
  assert.equal(result.allLit, false);
  assert.equal(result.targets.find((target) => target.x === 6).lit, true);
  assert.equal(result.targets.find((target) => target.x === 3).lit, false);
});

test("二向色镜关卡：黄光被拆成红光与绿光分别命中目标", () => {
  const unplaced = engine.solve(LEVEL_DICHROIC, []);
  assert.equal(unplaced.allLit, false, "不放二向色镜时上方的红光目标不亮");

  const placed = engine.solve(LEVEL_DICHROIC, [
    { type: "dichroicR", x: 2, y: 2, orient: SLASH },
  ]);
  assert.equal(placed.allLit, true);
  assert.deepEqual(
    placed.targets.find((target) => target.x === 2),
    { x: 2, y: 0, require: R, incoming: R, lit: true },
    "反射束应是纯红光",
  );
  assert.deepEqual(
    placed.targets.find((target) => target.x === 4),
    { x: 4, y: 2, require: G, incoming: G, lit: true },
    "透射束应是纯绿光",
  );
});

test("颜色合成只发生在目标处：两束异色光汇入同一目标后按位或", () => {
  const level = {
    cols: 5,
    rows: 3,
    fixed: [
      { type: "emitter", x: 0, y: 1, dir: "right", color: R },
      { type: "emitter", x: 4, y: 1, dir: "left", color: G },
    ],
    targets: [{ x: 2, y: 1, require: R | G }],
    inventory: noInventory,
  };

  const result = engine.solve(level, []);
  assert.equal(result.targets[0].incoming, R | G);
  assert.equal(result.allLit, true, "红光与绿光合成黄光，应满足 require = R|G");
});

test("目标只要求部分颜色时，多余的入射色不影响点亮", () => {
  const level = {
    cols: 4,
    rows: 3,
    fixed: [{ type: "emitter", x: 0, y: 1, dir: "right", color: R | G | B }],
    targets: [{ x: 3, y: 1, require: R }],
    inventory: noInventory,
  };

  const result = engine.solve(level, []);
  assert.equal(result.targets[0].incoming, R | G | B);
  assert.equal(result.allLit, true, "白光里含红光，应满足只要求红光的那个目标");
});

test("目标没有任何入射光时不点亮，require 为 0 的目标视为空缺", () => {
  const level = {
    cols: 4,
    rows: 3,
    fixed: [{ type: "emitter", x: 0, y: 1, dir: "right", color: R }],
    targets: [{ x: 0, y: 0, require: R }],
    inventory: noInventory,
  };

  const result = engine.solve(level, []);
  assert.equal(result.targets[0].incoming, 0);
  assert.equal(result.allLit, false);
});

test("没有目标的关卡不算通关", () => {
  const level = { cols: 3, rows: 3, fixed: [], targets: [], inventory: noInventory };
  const result = engine.solve(level, []);
  assert.equal(result.targets.length, 0);
  assert.equal(result.allLit, false, "allLit 要求至少有一个目标");
});

// ---------- T11：终止与剪枝 ----------

test("T11 撞墙即终止：光段到墙格为止", () => {
  const level = {
    cols: 6,
    rows: 3,
    fixed: [
      { type: "emitter", x: 0, y: 1, dir: "right", color: R },
      { type: "wall", x: 3, y: 1 },
    ],
    targets: [{ x: 5, y: 1, require: R }],
    inventory: noInventory,
  };

  const result = engine.solve(level, []);
  assert.equal(segmentCount(result), 3, "(0,1)→(1,1)→(2,1)→(3,1)");
  assert.equal(result.allLit, false, "墙挡住了光");
  assert.equal(result.overflow, false);
});

test("T11 出界不产生光段", () => {
  const level = {
    cols: 3,
    rows: 3,
    fixed: [{ type: "emitter", x: 2, y: 1, dir: "right", color: R }],
    targets: [{ x: 0, y: 2, require: R }],
    inventory: noInventory,
  };

  const result = engine.solve(level, []);
  assert.equal(segmentCount(result), 0, "光朝网格外射出，不应留下光段");
});

test("T11 去重剪枝：重叠光路只被追踪一次", () => {
  const level = {
    cols: 6,
    rows: 3,
    fixed: [
      { type: "emitter", x: 0, y: 1, dir: "right", color: R },
      { type: "emitter", x: 1, y: 1, dir: "right", color: R },
    ],
    targets: [{ x: 5, y: 1, require: R }],
    inventory: noInventory,
  };

  const result = engine.solve(level, []);
  assert.equal(
    segmentCount(result),
    5,
    "第二个光源与第一个完全重叠，应被剪枝掉，总段数仍是 5",
  );
  assert.equal(result.allLit, true);
});

test("T11 光段数超过上限时置 overflow 并停止追踪", () => {
  const result = engine.solve(LEVEL_STRAIGHT, [], { maxSegments: 2 });
  assert.equal(result.overflow, true);
  assert.equal(segmentCount(result), 2, "应在上限处截断");
  assert.equal(result.allLit, false, "被截断时目标未被命中");
});

test("T11 分光镜环路不会失控（同状态只展开一次）", () => {
  // 两面相对的镜子把光来回反射，最终必然因状态重复或出界而终止
  const level = {
    cols: 6,
    rows: 3,
    fixed: [{ type: "emitter", x: 0, y: 1, dir: "right", color: R }],
    targets: [{ x: 0, y: 0, require: R }],
    inventory: noInventory,
  };
  const placement = [
    { type: "splitter", x: 3, y: 1, orient: SLASH },
    { type: "mirror", x: 3, y: 0, orient: BACKSLASH },
  ];

  const result = engine.solve(level, placement);
  assert.equal(result.overflow, false, "不应触发上限，说明剪枝生效");
  assert.ok(segmentCount(result) > 0 && segmentCount(result) < 64, "段数应有限且不爆炸");
});

test("T11 求解在大网格多光源下仍然收敛", () => {
  const fixed = [];
  for (let x = 0; x < 40; x += 2) {
    fixed.push({ type: "emitter", x, y: 0, dir: "down", color: R | G | B });
  }
  const level = {
    cols: 40,
    rows: 40,
    fixed,
    targets: [{ x: 39, y: 39, require: R }],
    inventory: noInventory,
  };

  const result = engine.solve(level, []);
  assert.equal(result.overflow, false);
  assert.ok(segmentCount(result) <= engine.MAX_SEGMENTS);
});

// ---------- T12：幂等 ----------

test("T12 相同输入重复求解结果完全一致", () => {
  const placement = [{ type: "splitter", x: 3, y: 2, orient: BACKSLASH }];
  const first = engine.solve(LEVEL_SPLIT, placement);
  const second = engine.solve(LEVEL_SPLIT, placement);

  assert.deepEqual(second.segments, first.segments);
  assert.deepEqual(second.targets, first.targets);
  assert.equal(second.allLit, first.allLit);
  assert.equal(second.placedCount, first.placedCount);
});

test("T12 求解不修改传入的关卡与放置数据", () => {
  const placement = [{ type: "mirror", x: 4, y: 4, orient: SLASH }];
  const placementSnapshot = JSON.parse(JSON.stringify(placement));
  const levelSnapshot = JSON.parse(JSON.stringify(LEVEL_MIRROR));

  engine.solve(LEVEL_MIRROR, placement);

  assert.deepEqual(placement, placementSnapshot, "放置数组不应被求解过程改动");
  assert.deepEqual(LEVEL_MIRROR, levelSnapshot, "关卡定义不应被求解过程改动");
});

// ---------- T13：星级 ----------

test("T13 星级按元件数与 par 的差值分档", () => {
  assert.equal(engine.starsFor(false, 0, 0), 0, "未通关不给星");

  assert.equal(engine.starsFor(true, 0, 0), 3);
  assert.equal(engine.starsFor(true, 1, 1), 3);
  assert.equal(engine.starsFor(true, 5, 5), 3);

  assert.equal(engine.starsFor(true, 6, 5), 2);
  assert.equal(engine.starsFor(true, 7, 5), 2);

  assert.equal(engine.starsFor(true, 8, 5), 1);
  assert.equal(engine.starsFor(true, 99, 5), 1);
});

test("T13 par 为 0 的关卡放一个元件就掉到两星", () => {
  assert.equal(engine.starsFor(true, 0, 0), 3);
  assert.equal(engine.starsFor(true, 1, 0), 2);
  assert.equal(engine.starsFor(true, 2, 0), 2);
  assert.equal(engine.starsFor(true, 3, 0), 1);
});

// ---------- 非法放置 ----------

test("非法放置被拒绝并记入 rejected，不参与计数", () => {
  const placement = [
    { type: "mirror", x: 99, y: 0 }, // 越界
    { type: "mirror", x: 0, y: 4 }, // 压在光源上
    { type: "emitter", x: 2, y: 2 }, // 不是可放置元件
    { type: "mirror", x: 4, y: 4, orient: SLASH }, // 唯一合法的一条
  ];

  const result = engine.solve(LEVEL_MIRROR, placement);
  assert.equal(result.placedCount, 1);
  assert.equal(result.rejected.length, 3);
  assert.equal(result.allLit, true, "合法的那面镜子足以通关");
});

test("同一格重复放置时只有先到的那一个生效", () => {
  const result = engine.solve(LEVEL_MIRROR, [
    { type: "mirror", x: 4, y: 4, orient: SLASH },
    { type: "mirror", x: 4, y: 4, orient: BACKSLASH },
  ]);

  assert.equal(result.placedCount, 1);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.allLit, true, "生效的是先到的 `/` 镜");
});

test("非法的 orient 值回落到 `/`", () => {
  const result = engine.solve(LEVEL_MIRROR, [
    { type: "mirror", x: 4, y: 4, orient: 42 },
  ]);
  assert.equal(result.allLit, true, "非法 orient 按 `/` 处理，仍能通关");
});

test("非法方向的光源不发光", () => {
  const level = {
    cols: 4,
    rows: 3,
    fixed: [{ type: "emitter", x: 0, y: 1, dir: "sideways", color: R }],
    targets: [{ x: 3, y: 1, require: R }],
    inventory: noInventory,
  };

  const result = engine.solve(level, []);
  assert.equal(segmentCount(result), 0);
  assert.equal(result.allLit, false);
});

// ---------- 网格工具 ----------

test("网格工具：边界判定与索引换算一致", () => {
  const grid = engine.createGrid(5, 3);
  assert.equal(engine.inBounds(grid, 0, 0), true);
  assert.equal(engine.inBounds(grid, 4, 2), true);
  assert.equal(engine.inBounds(grid, 5, 2), false);
  assert.equal(engine.inBounds(grid, -1, 0), false);
  assert.equal(engine.inBounds(grid, 1.5, 0), false);
  assert.equal(engine.indexOf(grid, 4, 2), 14);

  engine.setCell(grid, 1, 1, { type: "wall" });
  assert.deepEqual(engine.cellAt(grid, 1, 1), { type: "wall" });
  assert.equal(engine.cellAt(grid, 9, 9), null);
});
