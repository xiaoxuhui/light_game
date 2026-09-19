"use strict";

// 内置关卡自检与关卡数据校验：对应 doc/需求与测试用例.md 的 T14 与 T16。
// T14 保证内置关卡本身是合法且可解的；T16 保证外部导入的数据会被严格拦下。

const assert = require("node:assert/strict");
const test = require("node:test");

const core = require("../scripts/light-core.js");
const engine = require("../scripts/light-engine.js");
const levels = require("../scripts/levels.js");

const { SLASH, BACKSLASH } = core.ORIENT;

/** 每关的参考解。既验证 par 可达，也验证 par 是局部最优；全量最小性由 `npm run verify:par` 穷举确认。 */
const REFERENCE_SOLUTIONS = {
  t01: [],
  t02: [{ type: "mirror", x: 6, y: 4, orient: SLASH }],
  t03: [{ type: "splitter", x: 3, y: 3, orient: BACKSLASH }],
  t04: [{ type: "prism", x: 3, y: 3, orient: 0 }],

  // 第 1 章 · 颜色（本章不发分光镜：要分束就只能靠棱镜）
  c01: [
    { type: "prism", x: 2, y: 2, orient: 0 },
    { type: "mirror", x: 2, y: 3, orient: BACKSLASH },
    { type: "prism", x: 7, y: 3, orient: 2 },
  ],
  c02: [
    { type: "mirror", x: 6, y: 4, orient: SLASH },
    { type: "mirror", x: 2, y: 2, orient: BACKSLASH },
  ],
  c03: [
    { type: "prism", x: 4, y: 2, orient: 1 },
    { type: "mirror", x: 4, y: 3, orient: SLASH },
    { type: "mirror", x: 2, y: 3, orient: BACKSLASH },
  ],
  c04: [
    { type: "mirror", x: 1, y: 1, orient: BACKSLASH },
    { type: "prism", x: 1, y: 3, orient: 1 },
    { type: "mirror", x: 4, y: 3, orient: BACKSLASH },
    { type: "mirror", x: 1, y: 5, orient: BACKSLASH },
  ],
  c05: [
    { type: "mirror", x: 2, y: 5, orient: SLASH },
    { type: "prism", x: 2, y: 2, orient: 2 },
    { type: "mirror", x: 0, y: 2, orient: BACKSLASH },
    { type: "mirror", x: 0, y: 0, orient: SLASH },
  ],
  c06: [
    { type: "mirror", x: 4, y: 5, orient: SLASH },
    { type: "prism", x: 4, y: 3, orient: 1 },
    { type: "mirror", x: 0, y: 3, orient: BACKSLASH },
    { type: "mirror", x: 0, y: 0, orient: SLASH },
  ],

  // 第 2 章 · 精算
  e01: [
    { type: "splitter", x: 5, y: 3, orient: SLASH },
    { type: "splitter", x: 8, y: 3, orient: SLASH },
  ],
  e02: [
    { type: "splitter", x: 4, y: 2, orient: SLASH },
    { type: "splitter", x: 7, y: 2, orient: SLASH },
  ],
  e03: [
    { type: "mirror", x: 4, y: 0, orient: BACKSLASH },
    { type: "splitter", x: 4, y: 3, orient: BACKSLASH },
  ],
  e04: [
    { type: "splitter", x: 5, y: 1, orient: BACKSLASH },
    { type: "splitter", x: 5, y: 4, orient: SLASH },
  ],
  e05: [
    { type: "splitter", x: 9, y: 0, orient: BACKSLASH },
    { type: "splitter", x: 9, y: 6, orient: SLASH },
  ],
  e06: [
    { type: "mirror", x: 5, y: 2, orient: SLASH },
    { type: "splitter", x: 5, y: 1, orient: SLASH },
    { type: "splitter", x: 8, y: 1, orient: SLASH },
  ],
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const firstLevel = () => clone(levels.LEVELS[0]);

// ---------- T14：内置关卡自检 ----------

test("T14 全部内置关卡通过严格校验", () => {
  const all = levels.listLevels();
  assert.ok(all.length >= 4, "至少要有 4 关教学关");

  for (const level of all) {
    const result = levels.validateLevel(level);
    assert.equal(result.ok, true, `${level.id} 校验未通过：${result.errors.join("；")}`);
  }
});

test("T14 关卡总数为 16 关：教学 4 + 颜色 6 + 精算 6", () => {
  const chapters = levels.listChapters();
  assert.deepEqual(
    chapters.map((chapter) => [chapter.id, chapter.levelIds.length]),
    [
      [0, 4],
      [1, 6],
      [2, 6],
    ],
  );
});

test("T14 关卡 id 唯一，且都有关卡名、提示与至少一个目标", () => {
  const seen = new Set();
  for (const level of levels.listLevels()) {
    assert.equal(seen.has(level.id), false, `关卡 id ${level.id} 重复`);
    seen.add(level.id);
    assert.ok(level.title.length > 0, `${level.id} 缺少标题`);
    assert.ok(level.hint.length > 0, `${level.id} 缺少提示`);
    assert.ok(level.targets.length > 0, `${level.id} 没有目标，无法通关`);
  }
});

test("T14 每关的参考解能通关，且元件数正好等于 par", () => {
  for (const level of levels.listLevels()) {
    const solution = REFERENCE_SOLUTIONS[level.id];
    assert.ok(solution, `${level.id} 缺少参考解`);

    const result = engine.solve(level, solution);
    assert.equal(result.allLit, true, `${level.id} 的参考解应当通关`);
    assert.equal(result.placedCount, solution.length, "参考解不应有被拒绝的放置");
    assert.equal(
      solution.length,
      level.par,
      `${level.id} 的 par（${level.par}）应等于参考解元件数（${solution.length}）`,
    );
  }
});

test("T14 par 是局部最优：去掉参考解里任一元件都无法通关", () => {
  for (const level of levels.listLevels()) {
    const solution = REFERENCE_SOLUTIONS[level.id];
    for (let i = 0; i < solution.length; i += 1) {
      const subset = solution.filter((_, index) => index !== i);
      assert.equal(
        engine.solve(level, subset).allLit,
        false,
        `${level.id} 少用第 ${i + 1} 个元件后不应还能通关（说明 par 还能更小）`,
      );
    }
  }
});

test("T14 关卡里的元件配额足够摆出参考解", () => {
  for (const level of levels.listLevels()) {
    const solution = REFERENCE_SOLUTIONS[level.id];
    const used = {};
    for (const item of solution) used[item.type] = (used[item.type] || 0) + 1;

    for (const type of Object.keys(used)) {
      assert.ok(
        level.inventory[type] >= used[type],
        `${level.id} 的 ${type} 配额（${level.inventory[type]}）不足以放下参考解需要的 ${used[type]} 个`,
      );
    }
  }
});

test("T14 教学关按「直射 → 反射 → 分光 → 棱镜」的顺序引入元件", () => {
  const teaching = levels.listLevels().filter((level) => level.chapter === 0);

  assert.equal(teaching[0].id, "t01");
  assert.equal(
    core.PLACEABLE_TYPES.some((type) => teaching[0].inventory[type] > 0),
    false,
    "第 1 关不应提供任何可放置元件",
  );

  assert.ok(teaching[1].inventory.mirror > 0, "第 2 关应引入反射镜");
  assert.ok(teaching[2].inventory.splitter > 0, "第 3 关应引入分光镜");
  assert.ok(teaching[3].inventory.prism > 0, "第 4 关应引入棱镜");
});

test("T14 颜色章不发分光镜，「一束光喂多个目标」就只能靠棱镜", () => {
  const colourChapter = levels.listLevels().filter((level) => level.chapter === 1);
  assert.equal(colourChapter.length, 6);

  for (const level of colourChapter) {
    assert.equal(
      level.inventory.splitter,
      0,
      `${level.id} 若发分光镜，「把白光分两路」就成了更省元件的解法，棱镜会被绕开`,
    );
  }

  // 单光源关：一条光路只够点亮一个目标（光会被目标吸收），所以必须靠棱镜分束
  const singleSource = colourChapter.filter(
    (level) => level.fixed.filter((item) => item.type === "emitter").length === 1,
  );
  assert.ok(singleSource.length >= 3, "颜色章应以单光源关为主");

  for (const level of singleSource) {
    assert.ok(level.targets.length >= 2, `${level.id} 是单光源关，目标应当不止一个`);
    assert.ok(level.inventory.prism > 0, `${level.id} 需要棱镜来分束`);
    assert.ok(
      REFERENCE_SOLUTIONS[level.id].some((item) => item.type === "prism"),
      `${level.id} 的参考解必须用到棱镜`,
    );
  }
});

test("T14 结构性前提：没有分光镜与棱镜时，一束光最多点亮一个目标", () => {
  // 光被目标吸收、不会穿过去继续走，所以「只有反射镜」时一个光源只能照亮一条路径。
  // 颜色章的单光源关卡因此绕不开棱镜 —— 这条不变量就是上面那个断言的依据。
  const level = {
    cols: 7,
    rows: 3,
    fixed: [{ type: "emitter", x: 0, y: 1, dir: "right", color: 7 }],
    targets: [
      { x: 6, y: 1, require: core.COLOR.G },
      { x: 3, y: 0, require: core.COLOR.R },
    ],
    inventory: { mirror: 4, splitter: 0, prism: 0 },
  };

  const mirrorOnly = [
    [],
    [{ type: "mirror", x: 3, y: 1, orient: 0 }],
    [{ type: "mirror", x: 3, y: 1, orient: 1 }],
    [
      { type: "mirror", x: 2, y: 1, orient: 0 },
      { type: "mirror", x: 2, y: 0, orient: 1 },
    ],
  ];

  for (const placement of mirrorOnly) {
    const result = engine.solve(level, placement);
    const lit = result.targets.filter((target) => target.lit).length;
    assert.ok(lit <= 1, "只有反射镜时最多点亮一个目标");
    assert.equal(result.allLit, false, "一个光源喂不饱两个目标");
  }

  const withPrism = engine.solve(
    { ...level, inventory: { mirror: 4, splitter: 0, prism: 1 } },
    [{ type: "prism", x: 3, y: 1, orient: 0 }],
  );
  assert.equal(withPrism.allLit, true, "棱镜把白光分成两路，两个目标同时点亮");
});

test("T14 章节按 chapter 自动分组，且顺序递增", () => {
  const chapters = levels.listChapters();
  assert.ok(chapters.length >= 1);
  assert.deepEqual(chapters[0], {
    id: 0,
    title: "教学",
    levelIds: ["t01", "t02", "t03", "t04"],
  });
  for (let i = 1; i < chapters.length; i += 1) {
    assert.ok(chapters[i].id > chapters[i - 1].id, "章节应按 id 升序");
  }
});

test("T14 关卡查询与串联正确", () => {
  assert.equal(levels.getLevel("t01").title, "第一束光");
  assert.equal(levels.getLevel("nope"), null);
  assert.equal(levels.indexOfLevel("t01"), 0);

  const all = levels.listLevels();
  assert.equal(levels.nextLevelId("t01"), all[1].id);
  assert.equal(levels.nextLevelId(all[all.length - 1].id), null, "最后一关没有下一关");
  assert.equal(levels.nextLevelId("nope"), null);
});

test("T14 星数汇总：未通关记 0，超过 3 的星数被截断", () => {
  const empty = levels.totalStars({});
  assert.equal(empty.earned, 0);
  assert.equal(empty.max, levels.LEVELS.length * 3);

  const mixed = levels.totalStars({
    t01: { stars: 3 },
    t02: { stars: 2 },
    t03: { stars: 99 },
    t04: { stars: -5 },
  });
  assert.equal(mixed.earned, 3 + 2 + 3, "超范围值应被截断到 0–3");

  // 存档里用的是「直接给数字」的写法，也必须能汇总
  assert.equal(levels.totalStars({ t01: 3, t02: 2 }).earned, 5);
  assert.equal(levels.totalStars({ t01: 3, t02: 99 }).earned, 6, "数字写法同样要截断");
});

test("T14 每关的网格尺寸都在合法范围内，且目标都在界内", () => {
  for (const level of levels.listLevels()) {
    assert.ok(level.cols >= levels.MIN_SIDE && level.cols <= levels.MAX_SIDE);
    assert.ok(level.rows >= levels.MIN_SIDE && level.rows <= levels.MAX_SIDE);

    for (const target of level.targets) {
      assert.ok(target.x >= 0 && target.x < level.cols, `${level.id} 目标 x 越界`);
      assert.ok(target.y >= 0 && target.y < level.rows, `${level.id} 目标 y 越界`);
    }
    for (const item of level.fixed) {
      assert.ok(item.x >= 0 && item.x < level.cols, `${level.id} 固定元件 x 越界`);
      assert.ok(item.y >= 0 && item.y < level.rows, `${level.id} 固定元件 y 越界`);
    }
  }
});

// ---------- T16：导入校验的拒绝路径 ----------

test("T16 合法数据通过校验，且校验过程不修改输入", () => {
  const level = firstLevel();
  const snapshot = clone(level);
  const result = levels.validateLevel(level);

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(level, snapshot, "校验函数不应改动入参");
});

test("T16 非对象一律被拒", () => {
  for (const bad of [null, undefined, 42, "level", [], true]) {
    const result = levels.validateLevel(bad);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} 应被拒绝`);
    assert.ok(result.errors.length > 0);
  }
});

test("T16 缺字段与错 schema 被拒，并给出具体原因", () => {
  const missingSchema = firstLevel();
  delete missingSchema.schema;
  let result = levels.validateLevel(missingSchema);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.indexOf("schema") !== -1));

  const wrongSchema = firstLevel();
  wrongSchema.schema = "light-game/save";
  result = levels.validateLevel(wrongSchema);
  assert.equal(result.ok, false);

  const noTitle = firstLevel();
  delete noTitle.title;
  result = levels.validateLevel(noTitle);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.indexOf("title") !== -1));
});

test("T16 未知版本号被拒", () => {
  for (const version of [0, 2, 99, "1", 1.5, null]) {
    const level = firstLevel();
    level.version = version;
    assert.equal(levels.validateLevel(level).ok, false, `version=${version} 应被拒绝`);
  }
});

test("T16 网格尺寸越界或非整数被拒", () => {
  for (const size of [3, 41, 0, -8, 4.5, "8", null]) {
    const level = firstLevel();
    level.cols = size;
    assert.equal(levels.validateLevel(level).ok, false, `cols=${size} 应被拒绝`);

    const other = firstLevel();
    other.rows = size;
    assert.equal(levels.validateLevel(other).ok, false, `rows=${size} 应被拒绝`);
  }
});

test("T16 坐标越界、非整数、以及元件重叠被拒", () => {
  const outOfRange = firstLevel();
  outOfRange.targets[0].x = 99;
  let result = levels.validateLevel(outOfRange);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.indexOf("坐标越界") !== -1));

  const fractional = firstLevel();
  fractional.targets[0].y = 1.5;
  assert.equal(levels.validateLevel(fractional).ok, false);

  const overlapping = firstLevel();
  overlapping.targets[0].x = overlapping.fixed[0].x;
  overlapping.targets[0].y = overlapping.fixed[0].y;
  result = levels.validateLevel(overlapping);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.indexOf("重叠") !== -1));
});

test("T16 颜色代号非法被拒", () => {
  for (const color of [0, 8, -1, 3.5, "R", null]) {
    const level = firstLevel();
    level.fixed[0].color = color;
    assert.equal(levels.validateLevel(level).ok, false, `color=${color} 应被拒绝`);

    const other = firstLevel();
    other.targets[0].require = color;
    assert.equal(levels.validateLevel(other).ok, false, `require=${color} 应被拒绝`);
  }
});

test("T16 方向代号非法被拒", () => {
  for (const dir of [-1, 8, 1.5, "sideways", null]) {
    const level = firstLevel();
    level.fixed[0].dir = dir;
    assert.equal(levels.validateLevel(level).ok, false, `dir=${JSON.stringify(dir)} 应被拒绝`);
  }
  // 方向名是合法写法
  const byName = firstLevel();
  byName.fixed[0].dir = "downRight";
  assert.equal(levels.validateLevel(byName).ok, true);
});

test("T16 元件类型不在白名单被拒", () => {
  for (const type of ["laser", "prism", "target", "mirror", "", null]) {
    const level = firstLevel();
    level.fixed[0].type = type;
    assert.equal(
      levels.validateLevel(level).ok,
      false,
      `fixed 里的 type=${JSON.stringify(type)} 应被拒绝（只允许 emitter / wall）`,
    );
  }

  // emitter 与 wall 是 fixed 的合法类型
  for (const type of ["emitter", "wall"]) {
    const level = firstLevel();
    level.fixed[0].type = type;
    assert.equal(levels.validateLevel(level).ok, true, `fixed.type=${type} 应当合法`);
  }
  // 换成 wall 就不再需要 dir / color
  const asWall = firstLevel();
  asWall.fixed[0] = { type: "wall", x: 0, y: 2 };
  assert.equal(levels.validateLevel(asWall).ok, true);
});

test("T16 inventory 缺项、负值或超上限被拒", () => {
  const missing = firstLevel();
  delete missing.inventory.splitter;
  assert.equal(levels.validateLevel(missing).ok, false);

  const negative = firstLevel();
  negative.inventory.mirror = -1;
  assert.equal(levels.validateLevel(negative).ok, false);

  const tooMany = firstLevel();
  tooMany.inventory.mirror = levels.MAX_UNITS + 1;
  assert.equal(levels.validateLevel(tooMany).ok, false);

  const notObject = firstLevel();
  notObject.inventory = [];
  assert.equal(levels.validateLevel(notObject).ok, false);
});

test("T16 fixed 与 targets 必须是数组", () => {
  const fixedNotArray = firstLevel();
  fixedNotArray.fixed = {};
  assert.equal(levels.validateLevel(fixedNotArray).ok, false);

  const targetsNotArray = firstLevel();
  targetsNotArray.targets = "t01";
  assert.equal(levels.validateLevel(targetsNotArray).ok, false);
});

test("T16 多处错误会一次全部报出，而不是只报第一条", () => {
  const level = firstLevel();
  level.schema = "wrong";
  level.title = "";
  level.inventory.mirror = -1;
  level.fixed[0].color = 0;

  const result = levels.validateLevel(level);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 4, `一次应报出全部问题，实际只报了 ${result.errors.length} 条`);
});

test("T16 尺寸非法时会跳过依赖尺寸的坐标校验，但不漏报尺寸本身", () => {
  const level = firstLevel();
  level.cols = 999;
  level.fixed[0].color = 0; // 依赖 cols 才能判断，故此刻不会被检查

  const result = levels.validateLevel(level);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.indexOf("cols") !== -1), "尺寸问题必须报出");
  assert.equal(
    result.errors.some((error) => error.indexOf("color") !== -1),
    false,
    "尺寸都不合法时不再逐个校验坐标",
  );
});

// ---------- T16：布局校验与外部关卡注册 ----------

test("T16 合法布局通过校验（含空布局）", () => {
  const level = levels.getLevel("t02");
  assert.deepEqual(levels.validatePlacement(level, []), { ok: true, errors: [] });
  assert.deepEqual(levels.validatePlacement(level, [{ type: "mirror", x: 6, y: 4, orient: SLASH }]), {
    ok: true,
    errors: [],
  });
});

test("T16 布局里的非法元件逐项被拒", () => {
  const level = levels.getLevel("t02"); // 7×5，emitter(0,4)，target(6,0)，mirror 配额 3

  const cases = [
    [{ type: "laser", x: 1, y: 1 }],
    [{ type: "target", x: 1, y: 1 }],
    [{ type: "mirror", x: 99, y: 1 }],
    [{ type: "mirror", x: -1, y: 1 }],
    [{ type: "mirror", x: 1.5, y: 1 }],
    [{ type: "mirror", x: 1, y: 1, orient: 5 }],
    [{ type: "mirror", x: 0, y: 4 }], // 压在光源上
    [{ type: "mirror", x: 6, y: 0 }], // 压在目标上
    [
      { type: "mirror", x: 1, y: 1 },
      { type: "mirror", x: 1, y: 1 },
    ], // 自重叠
    [
      { type: "mirror", x: 1, y: 1 },
      { type: "mirror", x: 2, y: 1 },
      { type: "mirror", x: 3, y: 1 },
      { type: "mirror", x: 4, y: 1 },
    ], // 超出 mirror:3 的配额
    "not-an-array",
    [null],
  ];

  for (const placement of cases) {
    const result = levels.validatePlacement(level, placement);
    assert.equal(result.ok, false, `${JSON.stringify(placement)} 应被拒绝`);
    assert.ok(result.errors.length > 0, "拒绝时必须给出原因");
  }
});

test("T16 导入的关卡可以注册，但不能覆盖内置关卡", () => {
  const custom = clone(levels.getLevel("t01"));
  custom.id = "user-1";
  custom.chapter = 9;
  custom.title = "自建关";

  const accepted = levels.registerLevel(custom);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.replaced, false);
  assert.equal(levels.getLevel("user-1").title, "自建关");

  // 同名再注册是替换，不是新增
  custom.title = "自建关 2";
  assert.equal(levels.registerLevel(custom).replaced, true);
  assert.equal(levels.getLevel("user-1").title, "自建关 2");

  // 与内置 id 冲突一律拒绝
  const conflict = clone(levels.getLevel("t02"));
  const rejected = levels.registerLevel(conflict);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.errors.some((error) => error.indexOf("内置") !== -1));

  // 非法数据同样拒绝
  assert.equal(levels.registerLevel({ id: "broken" }).ok, false);

  // 清理，避免影响其它用例
  const index = levels.LEVELS.findIndex((level) => level.id === "user-1");
  if (index !== -1) levels.LEVELS.splice(index, 1);
});

test("T16 被篡改的关卡无法在求解器里造成异常", () => {
  const hostile = firstLevel();
  hostile.cols = 4;
  hostile.rows = 4;
  hostile.fixed[0].x = 999; // 越界
  hostile.targets[0].x = -3;

  assert.equal(levels.validateLevel(hostile).ok, false);

  // 即便绕过校验直接求解，也必须安全返回而不是抛异常或死循环
  const result = engine.solve(hostile, []);
  assert.equal(result.overflow, false);
  assert.equal(result.allLit, false);
});
