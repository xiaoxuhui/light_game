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

  /** 旋转：`/` 与 `\` 互相切换 */
  function toggleOrient(orient) {
    return orient === ORIENT.SLASH ? ORIENT.BACKSLASH : ORIENT.SLASH;
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
    DICHROIC_R: "dichroicR",
    DICHROIC_G: "dichroicG",
    DICHROIC_B: "dichroicB",
    WALL: "wall",
    TARGET: "target",
  });

  /** 玩家可以放置的元件（也是关卡 inventory 的键） */
  const PLACEABLE_TYPES = Object.freeze(["mirror", "splitter", "dichroicR", "dichroicG", "dichroicB"]);

  /** 关卡预设、不可移动不可删除的元件 */
  const FIXED_TYPES = Object.freeze(["emitter", "wall"]);

  const ALL_TILE_TYPES = Object.freeze([...PLACEABLE_TYPES, ...FIXED_TYPES, TILE.TARGET]);

  const DICHROIC_MASKS = Object.freeze({
    dichroicR: COLOR.R,
    dichroicG: COLOR.G,
    dichroicB: COLOR.B,
  });

  function isDichroic(type) {
    return Object.prototype.hasOwnProperty.call(DICHROIC_MASKS, type);
  }

  function dichroicMask(type) {
    return DICHROIC_MASKS[type] || 0;
  }

  function isRotatable(type) {
    return type === TILE.MIRROR || type === TILE.SPLITTER || isDichroic(type);
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

    if (isDichroic(type)) {
      // 按掩码拆分：镜面吃掉指定颜色，其余透射。
      // 复合色光（如 Y = R|G）因此会自然分成两束，不需要额外规则。
      const mask = dichroicMask(type);
      const out = [];
      const reflectedColor = color & mask;
      const passedColor = color & ~mask;
      if (reflectedColor !== 0) {
        const reflected = reflectVector(dx, dy, orient);
        out.push({ dx: reflected.dx, dy: reflected.dy, color: reflectedColor });
      }
      if (passedColor !== 0) {
        out.push({ dx, dy, color: passedColor });
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
    reflectVector,
    reflectDirection,
    isDichroic,
    dichroicMask,
    isRotatable,
    isPlaceable,
    stopsLight,
    transmit,
  };
});
