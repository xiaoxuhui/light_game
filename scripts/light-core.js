"use strict";

// 光路核心：方向、颜色、镜面与元件规则。
//
// 纯计算层 —— 不碰 DOM、不碰 canvas、无副作用、无随机，因此可以在 Node 里直接单测。
// 浏览器中通过 <script defer> 加载并挂到 globalThis.LightCore，
// Node 单测环境通过 module.exports 引入的是同一份实现。
//
// 设计要点（详见 doc/设计文档.md 四、核心算法）：
//   · 方向用 0–7 顺时针索引，屏幕坐标系（y 轴向下）
//   · 颜色用 3 位掩码 R=1 / G=2 / B=4；合成即按位或，拆分即按位与
//   · 反射公式化简为纯整数运算：`/` 镜 → (−dy, −dx)；`\` 镜 → (dy, dx)
//     该式自动覆盖「斜向平行滑过」与「垂直原路返回」两种边界，无需特判

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.LightCore = api;
  }
})(globalThis, function () {
  // ---------- 方向 ----------

  const DIRECTIONS = Object.freeze([
    Object.freeze({ dx: 0, dy: -1 }), // 0 上
    Object.freeze({ dx: 1, dy: -1 }), // 1 右上
    Object.freeze({ dx: 1, dy: 0 }), // 2 右
    Object.freeze({ dx: 1, dy: 1 }), // 3 右下
    Object.freeze({ dx: 0, dy: 1 }), // 4 下
    Object.freeze({ dx: -1, dy: 1 }), // 5 左下
    Object.freeze({ dx: -1, dy: 0 }), // 6 左
    Object.freeze({ dx: -1, dy: -1 }), // 7 左上
  ]);

  const DIRECTION_NAMES = Object.freeze([
    "up",
    "upRight",
    "right",
    "downRight",
    "down",
    "downLeft",
    "left",
    "upLeft",
  ]);

  const DIRECTION_INDEX_BY_NAME = Object.freeze({
    up: 0,
    upRight: 1,
    right: 2,
    downRight: 3,
    down: 4,
    downLeft: 5,
    left: 6,
    upLeft: 7,
  });

  /**
   * 把方向写成索引或方向名都接受，非法值返回 -1。
   * @param {number|string} value
   * @returns {number}
   */
  function toDirectionIndex(value) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 7) {
      return value;
    }
    if (typeof value === "string" && Object.prototype.hasOwnProperty.call(DIRECTION_INDEX_BY_NAME, value)) {
      return DIRECTION_INDEX_BY_NAME[value];
    }
    return -1;
  }

  /** 反向。顺时针排 8 个方向，加 4 取模即反向。 */
  function oppositeDirection(index) {
    return (index + 4) % 8;
  }

  /** 由分量反查索引；分量必须是 -1 / 0 / 1，找不到返回 -1。 */
  function directionIndexFromVector(dx, dy) {
    for (let i = 0; i < DIRECTIONS.length; i += 1) {
      if (DIRECTIONS[i].dx === dx && DIRECTIONS[i].dy === dy) return i;
    }
    return -1;
  }

  /** 斜向（对角线）方向 */
  function isDiagonal(index) {
    const direction = DIRECTIONS[index];
    if (!direction) return false;
    return direction.dx !== 0 && direction.dy !== 0;
  }

  // ---------- 颜色 ----------

  const COLOR = Object.freeze({ R: 1, G: 2, B: 4 });

  const COLOR_LABELS = Object.freeze({
    1: "R",
    2: "G",
    3: "Y",
    4: "B",
    5: "M",
    6: "C",
    7: "W",
  });

  /** 掩码 → 可读色名。0 表示没有光。 */
  function colorLabel(mask) {
    return COLOR_LABELS[mask] || "none";
  }

  /** 色名数组 → 掩码，如 ["R", "G"] → 3（黄）。未知色名按 0 计。 */
  function colorFromNames(names) {
    let mask = 0;
    const list = Array.isArray(names) ? names : [names];
    for (const name of list) {
      const bit = COLOR[String(name).toUpperCase()];
      if (bit) mask |= bit;
    }
    return mask;
  }

  /** 按位或合成多束光的颜色 */
  function combineColors(...masks) {
    let mask = 0;
    for (const item of masks) mask |= item;
    return mask;
  }

  // ---------- 镜面 ----------

  const ORIENT = Object.freeze({ SLASH: 0, BACKSLASH: 1 });

  const ORIENT_LABELS = Object.freeze({ 0: "/", 1: "\\" });

  function orientLabel(orient) {
    return ORIENT_LABELS[orient] || "?";
  }

  /** 旋转：`/` 与 `\` 互相切换（仅用于 2 态元件） */
  function toggleOrient(orient) {
    return orient === ORIENT.SLASH ? ORIENT.BACKSLASH : ORIENT.SLASH;
  }

  /**
   * 某个元件有几个朝向后。反射镜与分光镜是 2 态（`/` 与 `\`），棱镜是 3 态。
   * 不可旋转的元件返回 1（调用方据此决定点击时是否循环）。
   */
  function orientStateCount(type) {
    if (type === TILE.PRISM) return PRISM_STATES;
    if (isRotatable(type)) return 2;
    return 1;
  }

  /** 切到下一个朝向，按该元件的态数取模 */
  function cycleOrient(type, orient) {
    const count = orientStateCount(type);
    const current = Number.isInteger(orient) ? orient : 0;
    return (((current % count) + count + 1) % count);
  }

  // ---------- 棱镜 ----------

  /** 棱镜的槽位数 = 朝向态数（左转 / 直行 / 右转 三个位置轮转） */
  const PRISM_STATES = 3;

  /** 三个槽位：0 = 相对入射方向左转 90°，1 = 直行，2 = 右转 90° */
  const PRISM_SLOT_LEFT = 0;
  const PRISM_SLOT_STRAIGHT = 1;
  const PRISM_SLOT_RIGHT = 2;

  /** 颜色分量按 R → G → B 的固定顺序排列，朝向只是把起点轮转一位 */
  const PRISM_COLOR_CYCLE = Object.freeze([COLOR.R, COLOR.G, COLOR.B]);

  /**
   * 某个朝向下，三个槽位各坐哪个颜色分量。
   * 朝向 0：左转 R / 直行 G / 右转 B；朝向 1：左转 G / 直行 B / 右转 R；
   * 朝向 2：左转 B / 直行 R / 右转 G。
   * @returns {number[]} 长度为 3 的颜色掩码数组，下标即槽位
   */
  function prismSlots(orient) {
    const base = ((Number.isInteger(orient) ? orient : 0) % PRISM_STATES + PRISM_STATES) % PRISM_STATES;
    const slots = new Array(PRISM_STATES);
    for (let index = 0; index < PRISM_COLOR_CYCLE.length; index += 1) {
      slots[(index - base + PRISM_STATES) % PRISM_STATES] = PRISM_COLOR_CYCLE[index];
    }
    return slots;
  }

  /** 某个颜色分量在棱镜里走哪个槽位（-1 表示该颜色不在棱镜的循环里） */
  function prismSlotOfColor(orient, color) {
    const slots = prismSlots(orient);
    for (let slot = 0; slot < slots.length; slot += 1) {
      if (slots[slot] === color) return slot;
    }
    return -1;
  }

  /** 槽位 → 出射方向索引：左转 (i−2)，直行 i，右转 (i+2) */
  function prismOutDirection(entryIndex, slot) {
    if (entryIndex < 0) return -1;
    if (slot === PRISM_SLOT_LEFT) return (entryIndex + 6) % 8;
    if (slot === PRISM_SLOT_RIGHT) return (entryIndex + 2) % 8;
    return entryIndex;
  }

  /** 把外部传入的朝向收敛到该元件的合法范围（引擎、存档、关卡校验共用） */
  function normalizeOrient(type, orient) {
    const count = orientStateCount(type);
    const value = Number.isInteger(orient) ? orient : 0;
    return ((value % count) + count) % count;
  }

  /**
   * 反射公式（关于镜面方向做镜像，已化简为整数运算）。
   *   `/` 镜面方向 (1, −1) → 出射 (−dy, −dx)
   *   `\` 镜面方向 (1,  1) → 出射 ( dy,  dx)
   * 当入射与镜面平行时出射等于入射（滑过）；垂直时出射为反向（原路返回）。
   * @returns {{dx:number, dy:number}}
   */
  function reflectVector(dx, dy, orient) {
    if (orient === ORIENT.SLASH) return { dx: -dy, dy: -dx };
    return { dx: dy, dy: dx };
  }

  /** 同上，但输入输出都是方向索引 */
  function reflectDirection(index, orient) {
    const direction = DIRECTIONS[index];
    if (!direction) return -1;
    const reflected = reflectVector(direction.dx, direction.dy, orient);
    return directionIndexFromVector(reflected.dx, reflected.dy);
  }

  // ---------- 元件 ----------

  const TILE = Object.freeze({
    EMITTER: "emitter",
    MIRROR: "mirror",
    SPLITTER: "splitter",
    PRISM: "prism",
    WALL: "wall",
    TARGET: "target",
  });

  /** 玩家可以放置的元件（也是关卡 inventory 的键） */
  const PLACEABLE_TYPES = Object.freeze(["mirror", "splitter", "prism"]);

  /** 关卡预设、不可移动不可删除的元件 */
  const FIXED_TYPES = Object.freeze(["emitter", "wall"]);

  const ALL_TILE_TYPES = Object.freeze([...PLACEABLE_TYPES, ...FIXED_TYPES, TILE.TARGET]);

  function isRotatable(type) {
    return type === TILE.MIRROR || type === TILE.SPLITTER || type === TILE.PRISM;
  }

  function isPlaceable(type) {
    return PLACEABLE_TYPES.indexOf(type) !== -1;
  }

  /** 光是否终止于此格（引擎据此决定是否继续追踪） */
  function stopsLight(type) {
    return type === TILE.WALL || type === TILE.TARGET;
  }

  /**
   * 计算光进入某一格后的出射光线。只负责元件本身的光学规则，
   * 终止（撞墙 / 命中目标 / 出界）由引擎处理。
   *
   * @param {string|null} type 元件类型，null 表示空格
   * @param {number} orient 镜面朝向（仅对可旋转元件有意义）
   * @param {number} dx 入射方向分量
   * @param {number} dy 入射方向分量
   * @param {number} color 入射颜色掩码
   * @returns {Array<{dx:number, dy:number, color:number}>} 出射光线，可能为空
   */
  function transmit(type, orient, dx, dy, color) {
    if (type === TILE.MIRROR) {
      const reflected = reflectVector(dx, dy, orient);
      return [{ dx: reflected.dx, dy: reflected.dy, color }];
    }

    if (type === TILE.SPLITTER) {
      const reflected = reflectVector(dx, dy, orient);
      return [
        { dx, dy, color },
        { dx: reflected.dx, dy: reflected.dy, color },
      ];
    }

    if (type === TILE.PRISM) {
      // 按颜色掩码拆成 R/G/B 三个分量，各自走自己的槽位（左转 / 直行 / 右转）。
      // 每个分量只有一个出口 —— 这与分光镜正相反：分光镜能把同一种颜色变成两束，棱镜永远不能。
      // 缺哪个分量就不出哪一束，因此黄光只出两束、纯红光只出一束。
      const entryIndex = directionIndexFromVector(dx, dy);
      if (entryIndex < 0) return [];
      const slots = prismSlots(orient);
      const out = [];
      for (let slot = 0; slot < slots.length; slot += 1) {
        const component = color & slots[slot];
        if (component === 0) continue;
        const outIndex = prismOutDirection(entryIndex, slot);
        const direction = DIRECTIONS[outIndex];
        if (!direction) continue;
        out.push({ dx: direction.dx, dy: direction.dy, color: component });
      }
      return out;
    }

    if (stopsLight(type)) return [];

    // 空格与光源格：保持原方向、原颜色
    return [{ dx, dy, color }];
  }

  return {
    DIRECTIONS,
    DIRECTION_NAMES,
    COLOR,
    COLOR_LABELS,
    ORIENT,
    ORIENT_LABELS,
    TILE,
    PLACEABLE_TYPES,
    FIXED_TYPES,
    ALL_TILE_TYPES,
    toDirectionIndex,
    oppositeDirection,
    directionIndexFromVector,
    isDiagonal,
    colorLabel,
    colorFromNames,
    combineColors,
    orientLabel,
    toggleOrient,
    orientStateCount,
    cycleOrient,
    PRISM_STATES,
    PRISM_SLOT_LEFT,
    PRISM_SLOT_STRAIGHT,
    PRISM_SLOT_RIGHT,
    prismSlots,
    prismSlotOfColor,
    prismOutDirection,
    normalizeOrient,
    reflectVector,
    reflectDirection,
    isRotatable,
    isPlaceable,
    stopsLight,
    transmit,
  };
});
