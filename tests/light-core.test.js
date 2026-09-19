"use strict";

// 光路核心的单元测试：对应 doc/需求与测试用例.md 的 T06–T10。
// 全部是纯函数断言，不依赖浏览器，Node 直接跑。

const assert = require("node:assert/strict");
const test = require("node:test");

const core = require("../scripts/light-core.js");

const { SLASH, BACKSLASH } = core.ORIENT;
const { R, G, B } = core.COLOR;

/** 方向名 → 分量，便于用名字写用例 */
function vec(name) {
  const index = core.toDirectionIndex(name);
  assert.notEqual(index, -1, `未知方向名：${name}`);
  return core.DIRECTIONS[index];
}

/** 分量 → 方向名，断言失败时输出可读 */
function nameOf(vector) {
  const index = core.directionIndexFromVector(vector.dx, vector.dy);
  return index === -1 ? `非法方向(${vector.dx},${vector.dy})` : core.DIRECTION_NAMES[index];
}

// ---------- T06：轴向入射 × 两种镜面朝向 ----------

test("T06 轴向反射：4 个入射方向 × 2 种镜面共 8 组的出射方向均正确", () => {
  const cases = [
    { orient: SLASH, from: "right", to: "up" },
    { orient: SLASH, from: "up", to: "right" },
    { orient: SLASH, from: "left", to: "down" },
    { orient: SLASH, from: "down", to: "left" },
    { orient: BACKSLASH, from: "right", to: "down" },
    { orient: BACKSLASH, from: "down", to: "right" },
    { orient: BACKSLASH, from: "left", to: "up" },
    { orient: BACKSLASH, from: "up", to: "left" },
  ];

  for (const item of cases) {
    const incoming = vec(item.from);
    const actual = core.reflectVector(incoming.dx, incoming.dy, item.orient);
    assert.equal(
      nameOf(actual),
      item.to,
      `${core.orientLabel(item.orient)} 镜面，${item.from} 入射应折向 ${item.to}`,
    );
    // 轴向入射必须得到轴向出射（不能变成斜向）
    assert.equal(core.isDiagonal(core.directionIndexFromVector(actual.dx, actual.dy)), false);
  }
});

// ---------- T07：斜向入射的两种边界情形 ----------

test("T07 斜向入射：与镜面平行时滑过、垂直时原路返回", () => {
  // `/` 镜面方向为 upRight–downLeft：(1,−1) 与 (−1,1) 滑过，(1,1) 与 (−1,−1) 返回
  // `\` 镜面方向为 upLeft–downRight：(1,1) 与 (−1,−1) 滑过，(1,−1) 与 (−1,1) 返回
  const cases = [
    { orient: SLASH, from: "upRight", to: "upRight", kind: "平行滑过" },
    { orient: SLASH, from: "downLeft", to: "downLeft", kind: "平行滑过" },
    { orient: SLASH, from: "downRight", to: "upLeft", kind: "垂直返回" },
    { orient: SLASH, from: "upLeft", to: "downRight", kind: "垂直返回" },
    { orient: BACKSLASH, from: "downRight", to: "downRight", kind: "平行滑过" },
    { orient: BACKSLASH, from: "upLeft", to: "upLeft", kind: "平行滑过" },
    { orient: BACKSLASH, from: "upRight", to: "downLeft", kind: "垂直返回" },
    { orient: BACKSLASH, from: "downLeft", to: "upRight", kind: "垂直返回" },
  ];

  for (const item of cases) {
    const incoming = vec(item.from);
    const actual = core.reflectVector(incoming.dx, incoming.dy, item.orient);
    assert.equal(
      nameOf(actual),
      item.to,
      `${core.orientLabel(item.orient)} 镜面，${item.from} 入射应「${item.kind}」到 ${item.to}`,
    );
    // 45° 镜面不会把斜向光变成轴向光
    assert.equal(
      core.isDiagonal(core.directionIndexFromVector(actual.dx, actual.dy)),
      true,
      `${item.from} 反射后应仍是斜向`,
    );
    if (item.kind === "平行滑过") {
      assert.equal(actual.dx, incoming.dx, "平行滑过时方向完全不变");
      assert.equal(actual.dy, incoming.dy, "平行滑过时方向完全不变");
    } else {
      assert.equal(actual.dx, -incoming.dx, "垂直返回时方向取反");
      assert.equal(actual.dy, -incoming.dy, "垂直返回时方向取反");
    }
  }
});

test("T07 反射是幂等的：同一方向连续反射两次回到入射方向", () => {
  for (let orient = 0; orient <= 1; orient += 1) {
    for (let index = 0; index < core.DIRECTIONS.length; index += 1) {
      const once = core.reflectDirection(index, orient);
      assert.notEqual(once, -1, `方向 ${core.DIRECTION_NAMES[index]} 反射后必须仍是合法方向`);
      const twice = core.reflectDirection(once, orient);
      assert.equal(twice, index, `${core.DIRECTION_NAMES[index]} 反射两次应回到自身`);
    }
  }
});

test("T07 反射不会产生非法方向（覆盖全部 8 个入射方向）", () => {
  for (let orient = 0; orient <= 1; orient += 1) {
    for (let index = 0; index < core.DIRECTIONS.length; index += 1) {
      const reflected = core.reflectDirection(index, orient);
      assert.ok(reflected >= 0 && reflected <= 7, `反射结果 ${reflected} 应在 0–7 之间`);
    }
  }
});

// ---------- T08：分光镜 ----------

test("T08 分光镜：入射光拆成透射与反射两束，颜色均与入射相同", () => {
  const outgoing = core.transmit(core.TILE.SPLITTER, BACKSLASH, 1, 0, R | G);

  assert.equal(outgoing.length, 2, "分光镜必须产生两束光");

  const passed = outgoing.find((beam) => beam.dx === 1 && beam.dy === 0);
  const reflected = outgoing.find((beam) => beam.dx === 0 && beam.dy === 1);

  assert.ok(passed, "应有一束沿原方向透射");
  assert.ok(reflected, "应有一束被反射");
  assert.equal(passed.color, R | G, "透射束颜色应与入射一致");
  assert.equal(reflected.color, R | G, "反射束颜色应与入射一致");
});

test("T08 分光镜在两种朝向下都产生两束且其中一束始终保持原方向", () => {
  for (const orient of [SLASH, BACKSLASH]) {
    for (let index = 0; index < core.DIRECTIONS.length; index += 1) {
      const incoming = core.DIRECTIONS[index];
      const outgoing = core.transmit(core.TILE.SPLITTER, orient, incoming.dx, incoming.dy, B);
      assert.equal(outgoing.length, 2, `${core.DIRECTION_NAMES[index]} 入射应产生两束`);
      const keepsDirection = outgoing.some(
        (beam) => beam.dx === incoming.dx && beam.dy === incoming.dy,
      );
      assert.ok(keepsDirection, "透射束必须保持入射方向");
    }
  }
});

// ---------- T09：棱镜 ----------
//
// 朝向 0 的三槽位是「左转 R / 直行 G / 右转 B」；
// 对向右传播的光，左转 = 上（dir 0）、直行 = 右（dir 2）、右转 = 下（dir 4）。

test("T09 棱镜：白光向右入射拆成三束，各走左转 / 直行 / 右转", () => {
  const outgoing = core.transmit(core.TILE.PRISM, 0, 1, 0, R | G | B);

  assert.equal(outgoing.length, 3, "白光进棱镜应出三束");
  assert.deepEqual(outgoing.find((beam) => beam.color === R), { dx: 0, dy: -1, color: R }, "红光左转（向上）");
  assert.deepEqual(outgoing.find((beam) => beam.color === G), { dx: 1, dy: 0, color: G }, "绿光直行（向右）");
  assert.deepEqual(outgoing.find((beam) => beam.color === B), { dx: 0, dy: 1, color: B }, "蓝光右转（向下）");
});

test("T09 棱镜：朝向轮转改变「哪个颜色走直行」", () => {
  const cases = [
    { orient: 0, straight: G, left: R, right: B },
    { orient: 1, straight: B, left: G, right: R },
    { orient: 2, straight: R, left: B, right: G },
  ];

  for (const item of cases) {
    const outgoing = core.transmit(core.TILE.PRISM, item.orient, 1, 0, R | G | B);
    assert.equal(outgoing.length, 3, `朝向 ${item.orient} 应出三束`);
    assert.deepEqual(
      outgoing.find((beam) => beam.color === item.straight),
      { dx: 1, dy: 0, color: item.straight },
      `朝向 ${item.orient}：${core.colorLabel(item.straight)} 应直行`,
    );
    assert.deepEqual(
      outgoing.find((beam) => beam.color === item.left),
      { dx: 0, dy: -1, color: item.left },
      `朝向 ${item.orient}：${core.colorLabel(item.left)} 应左转`,
    );
    assert.deepEqual(
      outgoing.find((beam) => beam.color === item.right),
      { dx: 0, dy: 1, color: item.right },
      `朝向 ${item.orient}：${core.colorLabel(item.right)} 应右转`,
    );
  }
});

test("T09 棱镜：缺哪个分量就不出哪一束", () => {
  const redOnly = core.transmit(core.TILE.PRISM, 0, 1, 0, R);
  assert.equal(redOnly.length, 1, "纯红光进棱镜只出一束");
  assert.deepEqual(redOnly[0], { dx: 0, dy: -1, color: R });

  const yellow = core.transmit(core.TILE.PRISM, 0, 1, 0, R | G);
  assert.equal(yellow.length, 2, "黄光（R|G）进棱镜出两束");
  assert.deepEqual(yellow.find((beam) => beam.color === R), { dx: 0, dy: -1, color: R });
  assert.deepEqual(yellow.find((beam) => beam.color === G), { dx: 1, dy: 0, color: G });

  const cyan = core.transmit(core.TILE.PRISM, 0, 1, 0, G | B);
  assert.equal(cyan.length, 2, "青光（G|B）进棱镜出两束");

  assert.deepEqual(core.transmit(core.TILE.PRISM, 0, 1, 0, 0), [], "没有光就没有出射");
});

test("T09 棱镜永远不会把同一种颜色变成两束（这是它与分光镜的分界）", () => {
  for (let orient = 0; orient < core.PRISM_STATES; orient += 1) {
    for (let index = 0; index < core.DIRECTIONS.length; index += 1) {
      const incoming = core.DIRECTIONS[index];
      const outgoing = core.transmit(core.TILE.PRISM, orient, incoming.dx, incoming.dy, R | G | B);
      const colors = outgoing.map((beam) => beam.color);
      assert.equal(
        new Set(colors).size,
        colors.length,
        "同一颜色不许出现两次出射",
      );
      assert.equal(new Set(colors).size, 3, "三色各出一束");
    }
  }

  // 对照：分光镜同一颜色确实会出两束
  const split = core.transmit(core.TILE.SPLITTER, SLASH, 1, 0, R);
  assert.equal(split.length, 2);
  assert.equal(split[0].color, split[1].color);
});

test("T09 棱镜：各入射方向的三个出射互不相同且都合法", () => {
  for (let index = 0; index < core.DIRECTIONS.length; index += 1) {
    const incoming = core.DIRECTIONS[index];
    const outgoing = core.transmit(core.TILE.PRISM, 0, incoming.dx, incoming.dy, 7);
    const indexes = outgoing.map((beam) => core.directionIndexFromVector(beam.dx, beam.dy));
    assert.equal(new Set(indexes).size, 3, `${core.DIRECTION_NAMES[index]} 入射的三束方向应互不相同`);
    for (const value of indexes) assert.ok(value >= 0, "出射方向必须合法");
  }
});

test("T09 棱镜朝向工具：槽位表、态数、轮转与归一", () => {
  assert.equal(core.PRISM_STATES, 3);
  assert.deepEqual(core.prismSlots(0), [R, G, B]);
  assert.deepEqual(core.prismSlots(1), [G, B, R]);
  assert.deepEqual(core.prismSlots(2), [B, R, G]);
  assert.deepEqual(core.prismSlots(3), core.prismSlots(0), "朝向对 3 取模");
  assert.deepEqual(core.prismSlots(-1), core.prismSlots(2), "负朝向也能归一");

  assert.equal(core.prismSlotOfColor(0, R), core.PRISM_SLOT_LEFT);
  assert.equal(core.prismSlotOfColor(0, G), core.PRISM_SLOT_STRAIGHT);
  assert.equal(core.prismSlotOfColor(0, B), core.PRISM_SLOT_RIGHT);
  assert.equal(core.prismSlotOfColor(1, G), core.PRISM_SLOT_LEFT);

  assert.equal(core.orientStateCount(core.TILE.PRISM), 3);
  assert.equal(core.orientStateCount(core.TILE.MIRROR), 2);
  assert.equal(core.orientStateCount(core.TILE.SPLITTER), 2);
  assert.equal(core.orientStateCount(core.TILE.EMITTER), 1);

  assert.equal(core.cycleOrient(core.TILE.PRISM, 0), 1);
  assert.equal(core.cycleOrient(core.TILE.PRISM, 2), 0, "棱镜三态循环");
  assert.equal(core.cycleOrient(core.TILE.MIRROR, 1), 0, "反射镜两态循环");

  assert.equal(core.normalizeOrient(core.TILE.PRISM, 1), 1);
  assert.equal(core.normalizeOrient(core.TILE.MIRROR, 1), 1);
  assert.equal(core.normalizeOrient(core.TILE.PRISM, undefined), 0);
});

// ---------- T10：颜色掩码 ----------

test("T10 颜色合成：R+G=Y、G+B=C、R+B=M、R+G+B=W", () => {
  assert.equal(core.combineColors(R, G), 3);
  assert.equal(core.colorLabel(core.combineColors(R, G)), "Y");
  assert.equal(core.colorLabel(core.combineColors(G, B)), "C");
  assert.equal(core.colorLabel(core.combineColors(R, B)), "M");
  assert.equal(core.colorLabel(core.combineColors(R, G, B)), "W");
  assert.equal(core.colorLabel(R), "R");
  assert.equal(core.colorLabel(0), "none");
});

test("T10 色名解析：与颜色常量一致且大小写不敏感", () => {
  assert.equal(core.colorFromNames(["R", "G"]), R | G);
  assert.equal(core.colorFromNames(["r", "g", "b"]), R | G | B);
  assert.equal(core.colorFromNames("B"), B);
  assert.equal(core.colorFromNames(["R", "X"]), R, "未知色名按 0 计入");
  assert.equal(core.colorFromNames([]), 0);
});

// ---------- 元件规则与工具函数 ----------

test("空格直行、墙体与目标格终止", () => {
  assert.deepEqual(core.transmit(null, SLASH, 1, 0, R), [{ dx: 1, dy: 0, color: R }]);
  assert.deepEqual(core.transmit(core.TILE.WALL, SLASH, 1, 0, R), []);
  assert.deepEqual(core.transmit(core.TILE.TARGET, SLASH, 1, 0, R), []);
});

test("方向工具：正反、索引与命名互查", () => {
  for (let index = 0; index < 8; index += 1) {
    const name = core.DIRECTION_NAMES[index];
    assert.equal(core.toDirectionIndex(name), index, `方向名 ${name} 应能查回索引`);
    assert.equal(core.toDirectionIndex(index), index);
    assert.equal(core.oppositeDirection(index), (index + 4) % 8);
    assert.equal(core.oppositeDirection(core.oppositeDirection(index)), index, "反向两次回到自身");
  }

  assert.equal(core.toDirectionIndex("nope"), -1);
  assert.equal(core.toDirectionIndex(8), -1);
  assert.equal(core.toDirectionIndex(1.5), -1);
  assert.equal(core.directionIndexFromVector(2, 0), -1);
  assert.equal(core.isDiagonal(core.toDirectionIndex("upRight")), true);
  assert.equal(core.isDiagonal(core.toDirectionIndex("up")), false);
});

test("元件分类：可放置、可旋转判定正确", () => {
  assert.deepEqual(core.PLACEABLE_TYPES, ["mirror", "splitter", "prism"]);
  assert.deepEqual(core.FIXED_TYPES, ["emitter", "wall"]);

  for (const type of core.PLACEABLE_TYPES) {
    assert.equal(core.isPlaceable(type), true, `${type} 应可放置`);
    assert.equal(core.isRotatable(type), true, `${type} 应可旋转`);
  }

  assert.equal(core.isPlaceable("emitter"), false, "光源不可放置");
  assert.equal(core.isRotatable(core.TILE.EMITTER), false, "光源不可旋转");
  assert.equal(core.isRotatable(core.TILE.WALL), false, "墙体不可旋转");
  assert.equal(core.isPlaceable("dichroicR"), false, "二向色镜已移除，不再是可放置元件");
  assert.equal(core.TILE.DICHROIC_R, undefined, "TILE 里不该再有二向色镜常量");
  assert.ok(core.ALL_TILE_TYPES.indexOf(core.TILE.TARGET) !== -1);
});

test("镜面朝向：切换两次回到原状态", () => {
  assert.equal(core.toggleOrient(SLASH), BACKSLASH);
  assert.equal(core.toggleOrient(BACKSLASH), SLASH);
  assert.equal(core.toggleOrient(core.toggleOrient(SLASH)), SLASH);
  assert.equal(core.orientLabel(SLASH), "/");
  assert.equal(core.orientLabel(BACKSLASH), "\\");
});
