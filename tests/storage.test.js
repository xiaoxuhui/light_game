"use strict";

// 存档与关卡文件读写：对应 doc/需求与测试用例.md 的 T15 与 T16。
//
// storage.js 的变换函数一律「返回新对象、不改入参」，所以这里大量用往返比对与入参不可变断言。
// 所有「拒绝路径」的断言都要求给出可读原因 —— 导入失败必须能告诉玩家到底哪儿不对。

const assert = require("node:assert/strict");
const test = require("node:test");

const core = require("../scripts/light-core.js");
const levels = require("../scripts/levels.js");
const storage = require("../scripts/storage.js");

const { SLASH, BACKSLASH } = core.ORIENT;

const mirror = (x, y, orient) => ({ type: "mirror", x, y, orient });

// ---------- T15 存档 ----------

test("T15 空存档结构稳定，非对象一律规范化为空存档", () => {
  const empty = storage.emptySave();
  assert.equal(empty.schema, storage.SAVE_SCHEMA);
  assert.equal(empty.version, storage.SAVE_VERSION);
  assert.deepEqual(empty.stars, {});
  assert.deepEqual(empty.boards, {});
  assert.deepEqual(empty.snapshots, []);

  for (const bad of [null, undefined, "x", 42, []]) {
    assert.deepEqual(storage.normalizeSave(bad), empty);
  }
});

test("T15 存档序列化／反序列化往返一致且幂等", () => {
  const save = {
    schema: storage.SAVE_SCHEMA,
    version: storage.SAVE_VERSION,
    stars: { t01: 3, t02: 1 },
    boards: { t02: [mirror(6, 4, BACKSLASH)] },
    snapshots: [
      {
        name: "第一版",
        levelId: "t02",
        placement: [mirror(6, 4, SLASH)],
        savedAt: "2026-09-19T00:00:00.000Z",
      },
    ],
  };

  const text = storage.serializeSave(save);
  assert.equal(typeof text, "string");
  assert.deepEqual(storage.parseSave(text), storage.normalizeSave(save));
  // 再序列化一次应当逐字节相同
  assert.equal(storage.serializeSave(storage.parseSave(text)), text);
});

test("T15 存档里的坏字段被丢弃，而不是整体报废", () => {
  const messy = {
    schema: storage.SAVE_SCHEMA,
    version: 1,
    stars: { t01: 3, t02: 99, t03: -1, t04: "3", t05: 2 },
    boards: {
      t02: [mirror(1, 1, SLASH), { type: "laser", x: 2, y: 2 }],
      t03: [null, "x"],
    },
    snapshots: [
      { name: "  ", levelId: "t02", placement: [] },
      { name: "好的", levelId: "t02", placement: [mirror(1, 1, SLASH)] },
    ],
  };

  const save = storage.normalizeSave(messy);
  assert.deepEqual(save.stars, { t01: 3, t05: 2 }, "只保留 1–3 的整数星数");
  assert.deepEqual(save.boards.t02, [mirror(1, 1, SLASH)], "非法元件被逐项丢弃");
  assert.equal(save.boards.t03, undefined, "全是坏数据的布局整条丢掉");
  assert.equal(save.snapshots.length, 1);
  assert.equal(save.snapshots[0].name, "好的");
});

test("T15 schema 不符、版本过高或非法一律退化为空存档", () => {
  const empty = storage.emptySave();
  const wrap = (payload) => storage.parseSave(JSON.stringify(payload));

  assert.deepEqual(storage.parseSave("not json"), empty);
  assert.deepEqual(storage.parseSave(""), empty);
  assert.deepEqual(wrap({ schema: "other", version: 1 }), empty);
  assert.deepEqual(wrap({ schema: storage.SAVE_SCHEMA, version: 99 }), empty);
  assert.deepEqual(wrap({ schema: storage.SAVE_SCHEMA, version: 0 }), empty);
  assert.deepEqual(wrap({ schema: storage.SAVE_SCHEMA, version: 1.5 }), empty);

  // 当前版本能读
  assert.equal(wrap(storage.emptySave()).schema, storage.SAVE_SCHEMA);
});

test("T15 星数只记录更好的成绩", () => {
  let save = storage.emptySave();

  let result = storage.updateStars(save, "t01", 2);
  assert.equal(result.improved, true);
  assert.equal(result.best, 2);
  save = result.save;

  result = storage.updateStars(save, "t01", 1);
  assert.equal(result.improved, false);
  assert.equal(result.best, 2);

  result = storage.updateStars(save, "t01", 3);
  assert.equal(result.improved, true);
  assert.equal(result.best, 3);
  save = result.save;

  // 越界值不会把已有成绩冲掉
  assert.equal(storage.updateStars(save, "t01", 99).best, 3);
  assert.equal(storage.updateStars(save, "t01", "3").best, 3);
});

test("T15 布局写入与读取往返一致，空布局会清除该关记录", () => {
  const placement = [mirror(1, 1, BACKSLASH), { type: "splitter", x: 2, y: 2, orient: SLASH }];

  let save = storage.setBoard(storage.emptySave(), "t02", placement);
  assert.deepEqual(storage.getBoard(save, "t02"), placement);
  assert.deepEqual(storage.getBoard(save, "不存在"), []);

  save = storage.setBoard(save, "t02", []);
  assert.deepEqual(storage.getBoard(save, "t02"), []);
  assert.equal(save.boards.t02, undefined);
});

test("T15 变换函数不修改入参", () => {
  const save = storage.emptySave();
  const snapshot = JSON.parse(JSON.stringify(save));

  storage.updateStars(save, "t01", 3);
  storage.setBoard(save, "t02", [mirror(1, 1, SLASH)]);
  storage.addSnapshot(save, { name: "甲", levelId: "t02", placement: [mirror(1, 1, SLASH)] });
  storage.removeSnapshot(save, "甲");

  assert.deepEqual(save, snapshot);
});

test("T15 快照：空名与空布局拒绝、同名覆盖、超上限挤掉最旧", () => {
  const unit = [mirror(1, 1, SLASH)];
  let save = storage.emptySave();

  const blank = storage.addSnapshot(save, { name: "   ", levelId: "t02", placement: unit });
  assert.equal(blank.ok, false);
  assert.ok(blank.errors.length > 0);

  const tooLong = storage.addSnapshot(save, {
    name: "x".repeat(storage.MAX_NAME_LENGTH + 1),
    levelId: "t02",
    placement: unit,
  });
  assert.equal(tooLong.ok, false);

  const noUnits = storage.addSnapshot(save, { name: "空的", levelId: "t02", placement: [] });
  assert.equal(noUnits.ok, false);

  save = storage.addSnapshot(save, { name: "甲", levelId: "t02", placement: unit }).save;
  assert.equal(save.snapshots.length, 1);

  save = storage.addSnapshot(save, { name: "甲", levelId: "t02", placement: [mirror(3, 3, BACKSLASH)] }).save;
  assert.equal(save.snapshots.length, 1, "同名应当覆盖而不是新增");
  assert.equal(save.snapshots[0].placement[0].x, 3);

  for (let i = 0; i < storage.MAX_SNAPSHOTS + 5; i += 1) {
    save = storage.addSnapshot(save, { name: "第 " + i + " 个", levelId: "t02", placement: unit }).save;
  }
  assert.equal(save.snapshots.length, storage.MAX_SNAPSHOTS);

  const first = save.snapshots[0].name;
  assert.ok(storage.getSnapshot(save, first));
  assert.equal(storage.getSnapshot(save, "不存在"), null);
  assert.equal(storage.removeSnapshot(save, first).snapshots.length, storage.MAX_SNAPSHOTS - 1);
});

// ---------- T16 关卡文件 ----------

test("T16 导出的关卡文件能原样导入，布局与元件朝向完全一致", () => {
  const level = levels.getLevel("t02");
  const placement = [mirror(6, 4, BACKSLASH)];

  const parsed = storage.parseLevelFile(storage.serializeLevelFile(level, placement));
  assert.equal(parsed.ok, true, parsed.errors.join("；"));
  assert.equal(parsed.level.id, "t02");
  assert.deepEqual(parsed.placement, placement, "朝向必须原样保留");
  assert.equal(storage.levelFileName(level), "t02.json");
});

test("T16 全部 16 个内置关卡都能导出再导入", () => {
  for (const level of levels.listLevels()) {
    const parsed = storage.parseLevelFile(storage.serializeLevelFile(level, []));
    assert.equal(parsed.ok, true, `${level.id} 往返失败：${parsed.errors.join("；")}`);
    assert.equal(parsed.level.id, level.id);
  }
});

test("T16 导入被篡改的文件时整体拒绝，并给出具体原因", () => {
  const level = levels.getLevel("t02");

  const cases = [
    ["", /空/],
    ["{ not json", /JSON/],
    [JSON.stringify({ ...level, schema: "nope" }), /schema/],
    [JSON.stringify({ ...level, id: "" }), /id/],
    [JSON.stringify({ ...level, cols: 999 }), /cols/],
    [JSON.stringify({ ...level, fixed: [{ type: "laser", x: 0, y: 0 }] }), /type/],
    [JSON.stringify({ ...level, placement: [{ type: "laser", x: 1, y: 1 }] }), /placement/],
    [JSON.stringify({ ...level, placement: [mirror(99, 1, SLASH)] }), /越界/],
    [
      JSON.stringify({
        ...level,
        placement: [mirror(1, 1, SLASH)],
        inventory: { ...level.inventory, mirror: 0 },
      }),
      /配额/,
    ],
  ];

  for (const [text, pattern] of cases) {
    const result = storage.parseLevelFile(text);
    assert.equal(result.ok, false, `应被拒绝：${text.slice(0, 70)}`);
    assert.ok(
      result.errors.some((error) => pattern.test(error)),
      `错误信息应说明原因，实际是：${result.errors.join("；")}`,
    );
    assert.equal(result.level, null, "拒绝时不返回任何关卡数据");
    assert.deepEqual(result.placement, [], "拒绝时不返回任何布局");
  }
});

// ---------- 存储后端 ----------

test("T15 内存后端可读写，跨 store 实例仍能读回", () => {
  const backend = storage.createMemoryBackend();
  const store = storage.createStore({ backend });

  assert.equal(store.available, true);
  assert.deepEqual(store.load(), storage.emptySave());

  store.replace(storage.updateStars(store.data, "t03", 2).save);
  assert.equal(store.persist(), true);

  const reopened = storage.createStore({ backend });
  assert.equal(reopened.load().stars.t03, 2, "重新打开后成绩应当还在");
});

test("T15 后端写入抛错时不打断游戏，只记录 lastError", () => {
  const broken = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota exceeded");
    },
    removeItem: () => {},
  };
  const store = storage.createStore({ backend: broken });

  assert.equal(store.persist(), false);
  assert.match(store.lastError, /quota exceeded/);
  assert.deepEqual(store.load(), storage.emptySave());

  store.reset();
  assert.deepEqual(store.data, storage.emptySave());
});

// ---------- U14 安卓导出桥（阶段 5 打包） ----------
//
// 安卓 WebView 不支持 Blob + <a download>，外壳会注入 LightAndroid 桥。
// downloadFile() 探测到桥就把文本交给它，探测不到才走浏览器下载。

/** 装上假桥跑一段，跑完自动摘掉，避免污染其它用例 */
async function withBridge(saveFile, run) {
  globalThis.LightAndroid = { saveFile };
  try {
    await run();
  } finally {
    delete globalThis.LightAndroid;
  }
}

/** readBlobText 是异步的，等一轮宏任务让回调落地 */
const settleBridge = () => new Promise((resolve) => setImmediate(resolve));

test("U14 没有桥时走浏览器下载：Node 环境无 document，返回 false", () => {
  assert.equal(typeof globalThis.document, "undefined");
  assert.equal(storage.downloadFile("t02.json", new Blob(["{}"])), false);
});

test("U14 有桥时导出交给原生，内容与文件名原样传出", async () => {
  const calls = [];
  await withBridge(
    (name, content) => {
      calls.push({ name, content });
      return true;
    },
    async () => {
      assert.equal(storage.downloadFile("t02.json", new Blob(["{\"a\":1}"])), true);
      await settleBridge();
    }
  );

  assert.equal(calls.length, 1, "桥应恰好被调用一次");
  assert.equal(calls[0].name, "t02.json");
  assert.equal(calls[0].content, "{\"a\":1}", "桥收到的必须是 Blob 里的原文");
});

test("U14 桥抛错不向上传播（导出失败不该打断游戏）", async () => {
  await withBridge(
    () => {
      throw new Error("bridge down");
    },
    async () => {
      assert.equal(storage.downloadFile("t02.json", new Blob(["{}"])), true);
      await settleBridge();
    }
  );
});

test("U14 桥收到的内容能被导入路径原样读回", async () => {
  const level = levels.LEVELS.find((item) => item.id === "t02");
  const placement = [{ type: "mirror", x: 6, y: 4, orient: SLASH }];
  const text = storage.serializeLevelFile(level, placement);

  let saved = null;
  await withBridge(
    (name, content) => {
      saved = { name, content };
      return true;
    },
    async () => {
      storage.downloadFile(storage.levelFileName(level), new Blob([text]));
      await settleBridge();
    }
  );

  assert.ok(saved, "桥应当被调用");
  assert.equal(saved.name, "t02.json", "导出文件名沿用网页端逻辑");

  const parsed = storage.parseLevelFile(saved.content);
  assert.equal(parsed.ok, true, (parsed.errors || []).join("；"));
  assert.deepEqual(parsed.placement, placement, "经过桥之后布局不应变形");
});
