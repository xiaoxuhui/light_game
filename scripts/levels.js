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

  const CHAPTER_TITLES = Object.freeze({
    0: "教学",
    1: "颜色",
    2: "精算",
  });

  const NO_INVENTORY = Object.freeze({
    mirror: 0,
    splitter: 0,
    dichroicR: 0,
    dichroicG: 0,
    dichroicB: 0,
  });

  // ---------- 第 0 章 · 教学 ----------
  // 依次引入：直射 → 反射镜 → 分光镜 → 二向色镜。每关只教一件事。

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
      fixed: [{ type: "emitter", x: 0, y: 2, dir: "right", color: 1 }],
      targets: [{ x: 7, y: 2, require: 1 }],
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
      fixed: [{ type: "emitter", x: 0, y: 4, dir: "right", color: 1 }],
      targets: [{ x: 6, y: 0, require: 1 }],
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
      fixed: [{ type: "emitter", x: 0, y: 3, dir: "right", color: 1 }],
      targets: [
        { x: 7, y: 3, require: 1 },
        { x: 3, y: 5, require: 1 },
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
      fixed: [{ type: "emitter", x: 0, y: 3, dir: "right", color: 3 }],
      targets: [
        { x: 3, y: 0, require: 1 },
        { x: 5, y: 3, require: 2 },
      ],
      inventory: { ...NO_INVENTORY, dichroicR: 1 },
      hint: "这道光是红与绿的混合。红二向色镜会拦下红光、放过绿光。",
    },
  ];

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

    const isInt = (value) => typeof value === "number" && Number.isInteger(value);
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

  /** 汇总星数。progress 形如 { [levelId]: { stars: 0–3 } } */
  function totalStars(progress) {
    let earned = 0;
    for (const level of LEVELS) {
      const record = progress ? progress[level.id] : null;
      const stars = record && Number.isInteger(record.stars) ? record.stars : 0;
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
    validateLevel,
    listLevels,
    getLevel,
    indexOfLevel,
    nextLevelId,
    listChapters,
    totalStars,
  };
});
