"use strict";

// 内置关卡与关卡数据校验。
//
// 校验函数 validateLevel 有两个用途：
//   1. 内置关卡自检（tests/levels.test.js，对应 T14）
//   2. 导入外部关卡文件时的严格校验（对应 T16）—— 绝不信任文件内容
//
// 浏览器中挂到 globalThis.LightLevels；Node 单测环境通过 module.exports 引入同一份实现。

(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.LightLevels = api;
  }
})(globalThis, function (root) {
  const core =
    typeof module === "object" && module.exports ? require("./light-core.js") : root.LightCore;

  const SCHEMA = "light-game/level";
  const SCHEMA_VERSION = 1;

  const MIN_SIDE = 4;
  const MAX_SIDE = 40;
  const MAX_UNITS = 999;

  const isInt = (value) => typeof value === "number" && Number.isInteger(value);

  const CHAPTER_TITLES = Object.freeze({
    0: "教学",
    1: "颜色",
    2: "精算",
  });

  const NO_INVENTORY = Object.freeze({
    mirror: 0,
    splitter: 0,
    prism: 0,
  });

  // 颜色掩码（见 light-core.js）。写成常量而不是裸数字，
  // 免得读关卡数据时还要回头查「3 到底是黄还是绿」。
  const C_R = core.COLOR.R;
  const C_G = core.COLOR.G;
  const C_B = core.COLOR.B;
  const C_Y = C_R | C_G;
  const C_M = C_R | C_B;
  const C_C = C_G | C_B;
  const C_W = C_R | C_G | C_B;

  // ---------- 第 0 章 · 教学 ----------
  // 依次引入：直射 → 反射镜 → 分光镜 → 棱镜。每关只教一件事。

  const LEVELS = [
    {
      schema: SCHEMA,
      version: SCHEMA_VERSION,
      id: "t01",
      title: "第一束光",
      chapter: 0,
      cols: 8,
      rows: 5,
      par: 0,
      fixed: [{ type: "emitter", x: 0, y: 2, dir: "right", color: C_R }],
      targets: [{ x: 7, y: 2, require: C_R }],
      inventory: NO_INVENTORY,
      hint: "这一关不用放任何元件：光会一直朝一个方向走到目标。看懂了就进下一关。",
    },
    {
      schema: SCHEMA,
      version: SCHEMA_VERSION,
      id: "t02",
      title: "折一下",
      chapter: 0,
      cols: 7,
      rows: 5,
      par: 1,
      fixed: [{ type: "emitter", x: 0, y: 4, dir: "right", color: C_R }],
      targets: [{ x: 6, y: 0, require: C_R }],
      inventory: { ...NO_INVENTORY, mirror: 3 },
      hint: "反射镜能把光折 90°。选中它放到格子上，再点一下已放好的镜子就能换朝向。",
    },
    {
      schema: SCHEMA,
      version: SCHEMA_VERSION,
      id: "t03",
      title: "一分为二",
      chapter: 0,
      cols: 8,
      rows: 6,
      par: 1,
      fixed: [{ type: "emitter", x: 0, y: 3, dir: "right", color: C_R }],
      targets: [
        { x: 7, y: 3, require: C_R },
        { x: 3, y: 5, require: C_R },
      ],
      inventory: { ...NO_INVENTORY, splitter: 2 },
      hint: "分光镜把一束光变成两束：一束继续直行，一束被反射出去。",
    },
    {
      schema: SCHEMA,
      version: SCHEMA_VERSION,
      id: "t04",
      title: "拆开这束光",
      chapter: 0,
      cols: 6,
      rows: 4,
      par: 1,
      fixed: [{ type: "emitter", x: 0, y: 3, dir: "right", color: C_Y }],
      targets: [
        { x: 3, y: 0, require: C_R },
        { x: 5, y: 3, require: C_G },
      ],
      inventory: { ...NO_INVENTORY, prism: 1 },
      hint: "黄光是红与绿混在一起的光。棱镜把红光甩向左转的方向、绿光留在直行方向 —— 一个元件就拆开了两种颜色。",
    },

    // ---------- 第 1 章 · 颜色 ----------
    // 引入拆分与合成：棱镜按颜色分量分向，多束光可以在同一目标处叠加。

    {
      schema: SCHEMA,
      version: SCHEMA_VERSION,
      id: "c01",
      title: "留下绿色",
      chapter: 1,
      cols: 8,
      rows: 5,
      par: 3,
      fixed: [{ type: "emitter", x: 0, y: 2, dir: "right", color: C_W }],
      targets: [
        { x: 7, y: 2, require: C_C },
        { x: 2, y: 0, require: C_R },
      ],
      inventory: { ...NO_INVENTORY, prism: 3, mirror: 2 },
      hint: "棱镜把白光拆成三束：红向左转、绿直行、蓝向右转。右边那个目标要的是青（绿加蓝），所以拆出来的两束都得送到它那里。",
    },
    {
      schema: SCHEMA,
      version: SCHEMA_VERSION,
      id: "c02",
      title: "两束光汇合",
      chapter: 1,
      cols: 8,
      rows: 6,
      par: 2,
      fixed: [
        { type: "emitter", x: 0, y: 4, dir: "right", color: C_R },
        { type: "emitter", x: 2, y: 0, dir: "down", color: C_G },
      ],
      targets: [{ x: 6, y: 2, require: C_Y }],
      inventory: { ...NO_INVENTORY, mirror: 4 },
      hint: "同一个目标收到两束光时，颜色会叠加 —— 红加绿就是黄。",
    },
    {
      schema: SCHEMA,
      version: SCHEMA_VERSION,
      id: "c03",
      title: "三色分离",
      chapter: 1,
      cols: 8,
      rows: 5,
      par: 3,
      fixed: [{ type: "emitter", x: 0, y: 2, dir: "right", color: C_W }],
      targets: [
        { x: 2, y: 0, require: C_R },
        { x: 4, y: 0, require: C_G },
        { x: 7, y: 2, require: C_B },
      ],
      inventory: { ...NO_INVENTORY, prism: 3, mirror: 4 },
      hint: "棱镜一束白光出三束，三种颜色各去一个方向。绿色拐上去、蓝色继续向右，红光得绕一圈才能回到最上面那个目标。",
    },
    {
      schema: SCHEMA,
      version: SCHEMA_VERSION,
      id: "c04",
      title: "撞墙之前转弯",
      chapter: 1,
      cols: 9,
      rows: 6,
      par: 4,
      fixed: [
        { type: "emitter", x: 0, y: 1, dir: "right", color: C_W },
        { type: "wall", x: 5, y: 1 },
      ],
      targets: [
        { x: 0, y: 3, require: C_R },
        { x: 4, y: 5, require: C_C },
      ],
      inventory: { ...NO_INVENTORY, mirror: 4, prism: 3 },
      hint: "墙会吃掉光，所以要先拐弯再拆色。红灯在西边，青灯在南边 —— 绿色和蓝色得汇到同一个目标上。",
    },
    {
      schema: SCHEMA,
      version: SCHEMA_VERSION,
      id: "c05",
      title: "品红与绿",
      chapter: 1,
      cols: 8,
      rows: 6,
      par: 4,
      fixed: [{ type: "emitter", x: 0, y: 5, dir: "right", color: C_W }],
      targets: [
        { x: 2, y: 0, require: C_M },
        { x: 7, y: 2, require: C_G },
      ],
      inventory: { ...NO_INVENTORY, mirror: 4, prism: 3 },
      hint: "品红是红加蓝：让红光直着上去，蓝光绕出去再折回来，两者在同一个目标上会合。绿光则直接向右。",
    },
    {
      schema: SCHEMA,
      version: SCHEMA_VERSION,
      id: "c06",
      title: "一路到底",
      chapter: 1,
      cols: 9,
      rows: 6,
      par: 4,
      fixed: [
        { type: "emitter", x: 0, y: 5, dir: "right", color: C_W },
        { type: "emitter", x: 8, y: 0, dir: "down", color: C_B },
        { type: "wall", x: 5, y: 5 },
      ],
      targets: [
        { x: 4, y: 0, require: C_C },
        { x: 8, y: 3, require: C_M },
      ],
      inventory: { ...NO_INVENTORY, mirror: 4, prism: 3 },
      hint: "红来自白光，蓝来自另一侧的光源。让它们在同一个目标上会合。",
    },

    // ---------- 第 2 章 · 精算 ----------
    // 分光镜、多目标与转向的组合；元件配额收紧，par 是全局最小值。

    {
      schema: SCHEMA,
      version: SCHEMA_VERSION,
      id: "e01",
      title: "连着分两次",
      chapter: 2,
      cols: 10,
      rows: 6,
      par: 2,
      fixed: [{ type: "emitter", x: 0, y: 3, dir: "right", color: C_R }],
      targets: [
        { x: 5, y: 0, require: C_R },
        { x: 8, y: 0, require: C_R },
        { x: 9, y: 3, require: C_R },
      ],
      inventory: { ...NO_INVENTORY, splitter: 3, mirror: 2 },
      hint: "分光镜可以串联：第一面分出的直行光，还能被第二面再分一次。",
    },
    {
      schema: SCHEMA,
      version: SCHEMA_VERSION,
      id: "e02",
      title: "先分光再拆色",
      chapter: 2,
      cols: 10,
      rows: 6,
      par: 2,
      fixed: [{ type: "emitter", x: 0, y: 2, dir: "right", color: C_W }],
      targets: [
        { x: 4, y: 0, require: C_W },
        { x: 7, y: 0, require: C_R },
        { x: 9, y: 2, require: C_C },
      ],
      inventory: { ...NO_INVENTORY, splitter: 2, prism: 2, mirror: 2 },
      hint: "先用分光镜把白光分成两路，再在其中一路上拆颜色。",
    },
    {
      schema: SCHEMA,
      version: SCHEMA_VERSION,
      id: "e03",
      title: "绕开这堵墙",
      chapter: 2,
      cols: 11,
      rows: 7,
      par: 2,
      fixed: [
        { type: "emitter", x: 0, y: 0, dir: "right", color: C_R },
        { type: "wall", x: 5, y: 0 },
      ],
      targets: [
        { x: 5, y: 3, require: C_R },
        { x: 4, y: 6, require: C_R },
      ],
      inventory: { ...NO_INVENTORY, mirror: 3, splitter: 2 },
      hint: "光会一直往前走，直到撞上墙。先拐弯，再决定在哪儿把它分开。",
    },
    {
      schema: SCHEMA,
      version: SCHEMA_VERSION,
      id: "e04",
      title: "两种颜色会合",
      chapter: 2,
      cols: 10,
      rows: 6,
      par: 2,
      fixed: [
        { type: "emitter", x: 0, y: 1, dir: "right", color: C_R },
        { type: "emitter", x: 0, y: 4, dir: "right", color: C_B },
      ],
      targets: [
        { x: 9, y: 1, require: C_R },
        { x: 9, y: 4, require: C_B },
        { x: 5, y: 3, require: C_M },
      ],
      inventory: { ...NO_INVENTORY, splitter: 3 },
      hint: "两束光各分出一半，让它们在同一个目标上叠成品红。",
    },
    {
      schema: SCHEMA,
      version: SCHEMA_VERSION,
      id: "e05",
      title: "中间会合",
      chapter: 2,
      cols: 12,
      rows: 7,
      par: 2,
      fixed: [
        { type: "emitter", x: 0, y: 0, dir: "right", color: C_R },
        { type: "emitter", x: 0, y: 6, dir: "right", color: C_G },
      ],
      targets: [
        { x: 11, y: 0, require: C_R },
        { x: 11, y: 6, require: C_G },
        { x: 9, y: 3, require: C_Y },
      ],
      inventory: { ...NO_INVENTORY, splitter: 3, mirror: 2 },
      hint: "红与绿各自从一端出发，各分出一束送到中间，在同一个目标上叠成黄色。",
    },
    {
      schema: SCHEMA,
      version: SCHEMA_VERSION,
      id: "e06",
      title: "收尾的一堵墙",
      chapter: 2,
      cols: 12,
      rows: 6,
      par: 3,
      fixed: [
        { type: "emitter", x: 0, y: 2, dir: "right", color: C_W },
        { type: "wall", x: 6, y: 2 },
      ],
      targets: [
        { x: 5, y: 0, require: C_C },
        { x: 8, y: 0, require: C_R },
        { x: 11, y: 1, require: C_R },
      ],
      inventory: { ...NO_INVENTORY, mirror: 3, splitter: 3, prism: 2 },
      hint: "最后一道题：拐弯、拆色、再分光，一个都不能少。",
    },
  ];

  /** 内置关卡的 id 快照：外部导入的关卡不许与它们重名，免得覆盖内置内容 */
  const BUILTIN_LEVELS = LEVELS.slice();

  // ---------- 校验 ----------

  /**
   * 严格校验一份关卡数据。返回全部错误，调用方可据此给出具体原因。
   * 不修改传入对象。
   * @returns {{ok: boolean, errors: string[]}}
   */
  function validateLevel(data) {
    const errors = [];

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, errors: ["关卡数据必须是一个对象"] };
    }

    const isColor = (value) => isInt(value) && value >= 1 && value <= 7;
    const isCount = (value) => isInt(value) && value >= 0 && value <= MAX_UNITS;

    if (data.schema !== SCHEMA) errors.push("schema 必须是 " + SCHEMA);
    if (!isInt(data.version) || data.version < 1 || data.version > SCHEMA_VERSION) {
      errors.push("version 必须是 1–" + SCHEMA_VERSION + " 的整数");
    }
    if (typeof data.id !== "string" || data.id.length === 0) errors.push("id 必须是非空字符串");
    if (typeof data.title !== "string" || data.title.length === 0) {
      errors.push("title 必须是非空字符串");
    }
    if (!isInt(data.chapter) || data.chapter < 0) errors.push("chapter 必须是非负整数");
    if (!isCount(data.par)) errors.push("par 必须是 0–" + MAX_UNITS + " 的整数");
    if (data.hint !== undefined && typeof data.hint !== "string") errors.push("hint 必须是字符串");

    const colsOk = isInt(data.cols) && data.cols >= MIN_SIDE && data.cols <= MAX_SIDE;
    const rowsOk = isInt(data.rows) && data.rows >= MIN_SIDE && data.rows <= MAX_SIDE;
    if (!colsOk) errors.push("cols 必须是 " + MIN_SIDE + "–" + MAX_SIDE + " 的整数");
    if (!rowsOk) errors.push("rows 必须是 " + MIN_SIDE + "–" + MAX_SIDE + " 的整数");

    if (!Array.isArray(data.fixed)) errors.push("fixed 必须是数组");
    if (!Array.isArray(data.targets)) errors.push("targets 必须是数组");
    if (!data.inventory || typeof data.inventory !== "object" || Array.isArray(data.inventory)) {
      errors.push("inventory 必须是对象");
    } else {
      for (const type of core.PLACEABLE_TYPES) {
        if (!isCount(data.inventory[type])) {
          errors.push("inventory." + type + " 必须是 0–" + MAX_UNITS + " 的整数");
        }
      }
    }

    if (Array.isArray(data.fixed) && Array.isArray(data.targets) && colsOk && rowsOk) {
      const occupied = new Set();
      const key = (x, y) => x + "," + y;
      const inRange = (x, y) =>
        isInt(x) && isInt(y) && x >= 0 && y >= 0 && x < data.cols && y < data.rows;

      let unitCount = 0;

      data.fixed.forEach((item, index) => {
        const where = "fixed[" + index + "]";
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          errors.push(where + " 必须是对象");
          return;
        }
        if (core.FIXED_TYPES.indexOf(item.type) === -1) {
          errors.push(where + ".type 必须是 " + core.FIXED_TYPES.join(" / "));
          return;
        }
        if (!inRange(item.x, item.y)) {
          errors.push(where + " 坐标越界或不是整数");
          return;
        }
        if (occupied.has(key(item.x, item.y))) {
          errors.push(where + " 与已有元件重叠");
          return;
        }
        occupied.add(key(item.x, item.y));
        unitCount += 1;

        if (item.type === core.TILE.EMITTER) {
          if (core.toDirectionIndex(item.dir) === -1) errors.push(where + ".dir 非法");
          if (!isColor(item.color)) errors.push(where + ".color 必须是 1–7 的整数");
        }
      });

      data.targets.forEach((target, index) => {
        const where = "targets[" + index + "]";
        if (!target || typeof target !== "object" || Array.isArray(target)) {
          errors.push(where + " 必须是对象");
          return;
        }
        if (!inRange(target.x, target.y)) {
          errors.push(where + " 坐标越界或不是整数");
          return;
        }
        if (occupied.has(key(target.x, target.y))) {
          errors.push(where + " 与已有元件重叠");
          return;
        }
        occupied.add(key(target.x, target.y));
        unitCount += 1;

        if (!isColor(target.require)) errors.push(where + ".require 必须是 1–7 的整数");
      });

      if (unitCount > MAX_UNITS) errors.push("元件总数不得超过 " + MAX_UNITS);
    }

    return { ok: errors.length === 0, errors };
  }

  /**
   * 校验一份玩家布局是否适用于给定关卡。
   * 与 validateLevel 分开是因为两者的定位不同：关卡是不可变的定义，
   * 布局是随关卡一起导入导出的动态数据，还要额外看占用与配额。
   * @returns {{ok: boolean, errors: string[]}}
   */
  function validatePlacement(level, placement) {
    if (!Array.isArray(placement)) return { ok: false, errors: ["placement 必须是数组"] };
    if (placement.length > MAX_UNITS) {
      return { ok: false, errors: ["元件数不得超过 " + MAX_UNITS] };
    }

    const colsOk = isInt(level.cols) && level.cols >= MIN_SIDE && level.cols <= MAX_SIDE;
    const rowsOk = isInt(level.rows) && level.rows >= MIN_SIDE && level.rows <= MAX_SIDE;
    if (!colsOk || !rowsOk) {
      return { ok: false, errors: ["关卡尺寸非法，无法校验布局"] };
    }

    const errors = [];
    const occupied = new Set();
    for (const item of level.fixed || []) occupied.add(item.x + "," + item.y);
    for (const target of level.targets || []) occupied.add(target.x + "," + target.y);

    const used = new Map();
    const seen = new Set();

    placement.forEach((item, index) => {
      const where = "placement[" + index + "]";

      if (!item || typeof item !== "object" || Array.isArray(item)) {
        errors.push(where + " 必须是对象");
        return;
      }
      if (core.PLACEABLE_TYPES.indexOf(item.type) === -1) {
        errors.push(where + ".type 不在可放置元件白名单内");
        return;
      }
      if (!isInt(item.x) || !isInt(item.y)) {
        errors.push(where + " 坐标必须是整数");
        return;
      }
      if (item.x < 0 || item.y < 0 || item.x >= level.cols || item.y >= level.rows) {
        errors.push(where + " 坐标越界");
        return;
      }
      if (
        item.orient !== undefined &&
        (!isInt(item.orient) || item.orient < 0 || item.orient >= core.orientStateCount(item.type))
      ) {
        errors.push(where + ".orient 超出该元件的朝向范围（0–" + (core.orientStateCount(item.type) - 1) + "）");
        return;
      }

      const key = item.x + "," + item.y;
      if (occupied.has(key)) {
        errors.push(where + " 落在关卡预设元件或目标上");
        return;
      }
      if (seen.has(key)) {
        errors.push(where + " 与其它元件重叠");
        return;
      }

      seen.add(key);
      used.set(item.type, (used.get(item.type) || 0) + 1);
    });

    for (const [type, count] of used) {
      const quota = (level.inventory && level.inventory[type]) || 0;
      if (count > quota) {
        errors.push(type + " 用了 " + count + " 个，超出关卡配额 " + quota);
      }
    }

    return { ok: errors.length === 0, errors };
  }

  // ---------- 查询 ----------

  function listLevels() {
    return LEVELS.slice();
  }

  function getLevel(id) {
    for (const level of LEVELS) {
      if (level.id === id) return level;
    }
    return null;
  }

  function indexOfLevel(id) {
    for (let i = 0; i < LEVELS.length; i += 1) {
      if (LEVELS[i].id === id) return i;
    }
    return -1;
  }

  function nextLevelId(id) {
    const index = indexOfLevel(id);
    if (index === -1 || index + 1 >= LEVELS.length) return null;
    return LEVELS[index + 1].id;
  }

  function isBuiltinId(id) {
    for (const level of BUILTIN_LEVELS) {
      if (level.id === id) return true;
    }
    return false;
  }

  /**
   * 注册一个外部导入的关卡，让它在关卡列表里可见可玩。
   * 与内置 id 冲突时拒绝 —— 内置关卡不允许被外部文件覆盖。
   * @returns {{ok: boolean, errors: string[], replaced: boolean}}
   */
  function registerLevel(data) {
    const check = validateLevel(data);
    if (!check.ok) return { ok: false, errors: check.errors, replaced: false };

    if (isBuiltinId(data.id)) {
      return {
        ok: false,
        errors: ["关卡 id「" + data.id + "」与内置关卡冲突，请换一个 id"],
        replaced: false,
      };
    }

    const index = indexOfLevel(data.id);
    if (index !== -1) {
      LEVELS[index] = data;
      return { ok: true, errors: [], replaced: true };
    }

    LEVELS.push(data);
    return { ok: true, errors: [], replaced: false };
  }

  /** 按 chapter 字段自动分组，新增关卡不需要改这里 */
  function listChapters() {
    const grouped = new Map();
    for (const level of LEVELS) {
      if (!grouped.has(level.chapter)) grouped.set(level.chapter, []);
      grouped.get(level.chapter).push(level.id);
    }
    return Array.from(grouped.keys())
      .sort((a, b) => a - b)
      .map((chapter) => ({
        id: chapter,
        title: CHAPTER_TITLES[chapter] || "第 " + chapter + " 章",
        levelIds: grouped.get(chapter),
      }));
  }

  /**
   * 汇总星数。progress 支持两种写法，都在用：
   *   { [levelId]: 3 }             存档里的写法
   *   { [levelId]: { stars: 3 } }  更早的写法，继续兼容
   */
  function totalStars(progress) {
    let earned = 0;
    for (const level of LEVELS) {
      const record = progress ? progress[level.id] : null;
      let stars = 0;
      if (isInt(record)) stars = record;
      else if (record && isInt(record.stars)) stars = record.stars;
      earned += Math.max(0, Math.min(3, stars));
    }
    return { earned, max: LEVELS.length * 3 };
  }

  return {
    SCHEMA,
    SCHEMA_VERSION,
    MIN_SIDE,
    MAX_SIDE,
    MAX_UNITS,
    CHAPTER_TITLES,
    NO_INVENTORY,
    LEVELS,
    BUILTIN_LEVELS,
    validateLevel,
    validatePlacement,
    registerLevel,
    isBuiltinId,
    listLevels,
    getLevel,
    indexOfLevel,
    nextLevelId,
    listChapters,
    totalStars,
  };
});
