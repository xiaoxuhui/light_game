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

// ---------- T09：二向色镜 ----------

test("T09 二向色镜：只反射指定颜色", () => {
  const outgoing = core.transmit(core.TILE.DICHROIC_R, BACKSLASH, 1, 0, R);

  assert.equal(outgoing.length, 1, "纯红光打红二向色镜只应反射出一束");
  assert.deepEqual(outgoing[0], { dx: 0, dy: 1, color: R });
});

test("T09 二向色镜：非指定颜色全部透射", () => {
  const outgoing = core.transmit(core.TILE.DICHROIC_R, BACKSLASH, 1, 0, G);

  assert.equal(outgoing.length, 1, "纯绿光打红二向色镜只应透射一束");
  assert.deepEqual(outgoing[0], { dx: 1, dy: 0, color: G });
});

test("T09 二向色镜：复合色光被拆成反射与透射两束", () => {
  const outYellow = core.transmit(core.TILE.DICHROIC_R, BACKSLASH, 1, 0, R | G);
  assert.equal(outYellow.length, 2, "黄光（R|G）打红二向色镜应被拆成两束");
  assert.deepEqual(
    outYellow.find((beam) => beam.dy === 1 && beam.dx === 0),
    { dx: 0, dy: 1, color: R },
    "反射束应是红光",
  );
  assert.deepEqual(
    outYellow.find((beam) => beam.dx === 1 && beam.dy === 0),
    { dx: 1, dy: 0, color: G },
    "透射束应是绿光",
  );

  const outWhite = core.transmit(core.TILE.DICHROIC_R, BACKSLASH, 1, 0, R | G | B);
  assert.deepEqual(outWhite.find((beam) => beam.dy === 1), { dx: 0, dy: 1, color: R });
  assert.deepEqual(
    outWhite.find((beam) => beam.dy === 0),
    { dx: 1, dy: 0, color: G | B },
    "白光打红二向色镜，透射束应是青（G|B）",
  );
});

test("T09 三种二向色镜各自只拦下自己的颜色", () => {
  const expectations = [
    { type: core.TILE.DICHROIC_R, mask: R },
    { type: core.TILE.DICHROIC_G, mask: G },
    { type: core.TILE.DICHROIC_B, mask: B },
  ];

  for (const item of expectations) {
    assert.equal(core.dichroicMask(item.type), item.mask);
    const outgoing = core.transmit(item.type, SLASH, 1, 0, 7);
    const reflected = outgoing.find((beam) => beam.dy !== 0 || beam.dx !== 1);
    assert.ok(reflected, `${item.type} 应反射出自己那一色`);
    assert.equal(reflected.color, item.mask);
    const passed = outgoing.find((beam) => beam.dx === 1 && beam.dy === 0);
    assert.equal(passed.color, 7 & ~item.mask, `${item.type} 透射束应滤掉自己那一色`);
  }
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

test("元件分类：可放置、可旋转、二向色镜判定正确", () => {
  assert.deepEqual(core.PLACEABLE_TYPES, ["mirror", "splitter", "dichroicR", "dichroicG", "dichroicB"]);
  assert.deepEqual(core.FIXED_TYPES, ["emitter", "wall"]);

  for (const type of core.PLACEABLE_TYPES) {
    assert.equal(core.isPlaceable(type), true, `${type} 应可放置`);
    assert.equal(core.isRotatable(type), true, `${type} 应可旋转`);
  }

  assert.equal(core.isPlaceable("emitter"), false, "光源不可放置");
  assert.equal(core.isRotatable(core.TILE.EMITTER), false, "光源不可旋转");
  assert.equal(core.isRotatable(core.TILE.WALL), false, "墙体不可旋转");
  assert.equal(core.isDichroic(core.TILE.MIRROR), false);
  assert.equal(core.isDichroic(core.TILE.DICHROIC_B), true);
  assert.ok(core.ALL_TILE_TYPES.indexOf(core.TILE.TARGET) !== -1);
});

test("镜面朝向：切换两次回到原状态", () => {
  assert.equal(core.toggleOrient(SLASH), BACKSLASH);
  assert.equal(core.toggleOrient(BACKSLASH), SLASH);
  assert.equal(core.toggleOrient(core.toggleOrient(SLASH)), SLASH);
  assert.equal(core.orientLabel(SLASH), "/");
  assert.equal(core.orientLabel(BACKSLASH), "\\");
});
