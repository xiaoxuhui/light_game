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
    if (["directionalEmitter", "chip", "io", "inputPort", "outputPort"].includes(type)) return 4;
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
  const FREE_PLACEABLE_TYPES = Object.freeze([...PLACEABLE_TYPES, "wall", "emitter", "bulb",
    "coldMirror", "hotMirror", "directionalEmitter", "chip"]);
  const MAX_CHIP_CELLS = 999;
  const CHIP_PORT_TYPES = Object.freeze(["io", "inputPort", "outputPort"]);
  // 三个旧存档类型都是同一种 IO，箭头表示外→内；不切换角色、不改写朝向。
  const isInputPort = (type) => CHIP_PORT_TYPES.includes(type);
  const isOutputPort = (type) => CHIP_PORT_TYPES.includes(type);
  function portOutputDirection(type, orient) {
    return oppositeDirection(normalizeOrient(type, orient) * 2);
  }

  function chipCircuits(chip) {
    if (Array.isArray(chip.circuits)) return chip.circuits;
    return chip.appearance ? [{ ...appearanceAnchor(chip.appearance), placement: chip.placement || [] }] : [];
  }

  function chipCircuitAt(chip, point) {
    return chipCircuits(chip).find((cell) => cell.x === point.x && cell.y === point.y);
  }

  function chipAllParts(chip) {
    return [...(chip.placement || []), ...(chip.circuits || []).flatMap((cell) => cell.placement)];
  }

  function chipComposite(chip) {
    const definitions = appearancePoints(chip.appearance).map((point) => ({
      id: chip.id + "::cell(" + point.x + "," + point.y + ")", name: "格 " + point.x + "," + point.y,
      placement: chipCircuitAt(chip, point)?.placement || [],
    }));
    return { definitions, placement: appearancePoints(chip.appearance).map((point, index) => ({
      type: "chip", x: point.x, y: point.y, orient: 0, chipId: definitions[index].id,
    })) };
  }

  function normalizeChipAppearance(raw) {
    if (!raw || !Array.isArray(raw.cells) || raw.cells.length > MAX_CHIP_CELLS ||
        (raw.showName !== undefined && typeof raw.showName !== "boolean")) return null;
    let shape = raw.shape;
    if (shape === undefined) {
      if (!Number.isSafeInteger(raw.cols) || !Number.isSafeInteger(raw.rows) || raw.cols < 1 || raw.rows < 1 ||
          raw.cols * raw.rows > MAX_CHIP_CELLS) return null;
      const x = raw.minX || 0, y = raw.minY || 0;
      if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return null;
      shape = Array.from({ length: raw.cols * raw.rows }, (_, index) => ({
        x: x + index % raw.cols, y: y + Math.floor(index / raw.cols) }));
    }
    if (!Array.isArray(shape) || !shape.length || shape.length > MAX_CHIP_CELLS ||
        shape.some((point) => !point || !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y))) return null;
    const minX = Math.min(...shape.map((point) => point.x)), minY = Math.min(...shape.map((point) => point.y));
    const cols = Math.max(...shape.map((point) => point.x)) - minX + 1;
    const rows = Math.max(...shape.map((point) => point.y)) - minY + 1;
    if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows)) return null;
    const occupied = new Set(shape.map((point) => point.x + "," + point.y));
    if (occupied.size !== shape.length) return null;
    const seen = new Set(), cells = [];
    let hasArrow = false;
    for (const cell of raw.cells) {
      if (!cell || !Number.isSafeInteger(cell.x) || !Number.isSafeInteger(cell.y) ||
          !occupied.has(cell.x + "," + cell.y) || seen.has(cell.x + "," + cell.y) ||
          typeof cell.color !== "string" || !/^#[0-9a-f]{6}$/i.test(cell.color) ||
          typeof cell.text !== "string" || cell.text.length > 12 || typeof cell.arrow !== "boolean" ||
          (cell.arrow && hasArrow)) return null;
      seen.add(cell.x + "," + cell.y); hasArrow ||= cell.arrow;
      cells.push({ x: cell.x, y: cell.y, color: cell.color, text: cell.text, arrow: cell.arrow });
    }
    return { cols, rows, minX, minY, showName: raw.showName !== false,
      shape: shape.map((point) => ({ x: point.x, y: point.y })).sort((a, b) => a.y - b.y || a.x - b.x), cells };
  }

  function appearancePoints(appearance) {
    if (!appearance) return [{ x: 0, y: 0 }];
    if (Array.isArray(appearance.shape) && appearance.shape.length <= MAX_CHIP_CELLS) return appearance.shape;
    if (!Number.isSafeInteger(appearance.cols) || !Number.isSafeInteger(appearance.rows) ||
        appearance.cols < 1 || appearance.rows < 1 || appearance.cols * appearance.rows > MAX_CHIP_CELLS) return [{ x: 0, y: 0 }];
    return Array.from({ length: appearance.cols * appearance.rows }, (_, index) => ({
      x: (appearance.minX || 0) + index % appearance.cols,
      y: (appearance.minY || 0) + Math.floor(index / appearance.cols) }));
  }

  function appearanceAnchor(appearance) {
    return [...appearancePoints(appearance)].sort((a, b) => a.y - b.y || a.x - b.x)[0] || { x: 0, y: 0 };
  }

  function shapeContains(appearance, x, y) {
    return appearancePoints(appearance).some((point) => point.x === x && point.y === y);
  }

  function chipWorldPoint(definition, instance, point) {
    const anchor = appearanceAnchor(definition?.appearance);
    const x = point.x - anchor.x, y = point.y - anchor.y, rotation = normalizeOrient("chip", instance.orient);
    const offset = rotation === 0 ? { x, y } : rotation === 1 ? { x: -y, y: x }
      : rotation === 2 ? { x: -x, y: -y } : { x: y, y: -x };
    return { x: instance.x + offset.x, y: instance.y + offset.y };
  }

  function chipLocalPoint(definition, instance, point) {
    const anchor = appearanceAnchor(definition?.appearance);
    const x = point.x - instance.x, y = point.y - instance.y, rotation = normalizeOrient("chip", instance.orient);
    const offset = rotation === 0 ? { x, y } : rotation === 1 ? { x: y, y: -x }
      : rotation === 2 ? { x: -x, y: -y } : { x: -y, y: x };
    return { x: anchor.x + offset.x, y: anchor.y + offset.y };
  }

  function appearanceArrowCell(appearance) {
    const explicit = appearance.cells.find((cell) => cell.arrow);
    if (explicit) return explicit;
    for (const point of appearancePoints(appearance)) {
      if (!appearance.cells.some((cell) => cell.x === point.x && cell.y === point.y)) return point;
    }
    return appearanceAnchor(appearance);
  }

  function chipFootprint(definition, orient) {
    return appearancePoints(definition?.appearance).map((point) => chipWorldPoint(definition, { x: 0, y: 0, orient }, point));
  }

  function placementFootprint(item, chips) {
    const offsets = item.type === "chip" ? chipFootprint(chips.find((chip) => chip.id === item.chipId), item.orient) : [{ x: 0, y: 0 }];
    return offsets.map((offset) => ({ x: item.x + offset.x, y: item.y + offset.y }));
  }

  function placementCollisions(placement, chips) {
    const occupied = new Set();
    for (const item of placement) for (const point of placementFootprint(item, chips)) {
      const key = point.x + "," + point.y;
      if (!Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y) || occupied.has(key)) return point;
      occupied.add(key);
    }
    return null;
  }

  function chipLayoutError(chip, chips) {
    if (!chip.appearance) return null;
    for (const cell of chipCircuits(chip)) {
      if (!shapeContains(chip.appearance, cell.x, cell.y)) return "已有内部线路的格子不能移出轮廓";
      if (placementCollisions(cell.placement, chips)) return "格子内部的元件发生重叠";
    }
    return null;
  }

  function chipExitPoint(cell, dir, entry) {
    const direction = DIRECTIONS[dir], origin = entry || cell;
    let best = cell, projection = -Infinity, offset = Infinity;
    for (const point of cell.footprint || [cell]) {
      const p = point.x * direction.dx + point.y * direction.dy;
      const distance = Math.abs((point.x - origin.x) * direction.dy - (point.y - origin.y) * direction.dx);
      if (p > projection || (p === projection && distance < offset)) {
        best = point; projection = p; offset = distance;
      }
    }
    return { x: best.x, y: best.y };
  }

  function chipDependsOn(chips, fromId, targetId, visited = new Set()) {
    if (fromId === targetId) return true;
    if (visited.has(fromId)) return false;
    visited.add(fromId);
    const chip = chips.find((entry) => entry.id === fromId);
    return Boolean(chip && chipAllParts(chip).some((part) => part.type === "chip" &&
      chipDependsOn(chips, part.chipId, targetId, visited)));
  }

  function validateChipGraph(chips) {
    const definitions = new Map(chips.map((chip) => [chip.id, chip]));
    for (const chip of chips) for (const part of chipAllParts(chip)) {
      if (part.type !== "chip") continue;
      if (!definitions.has(part.chipId)) return { ok: false, errors: ["芯片内部引用了未定义的芯片"] };
    }
    const visiting = new Set(), visited = new Set();
    function visit(id) {
      if (visiting.has(id)) return false;
      if (visited.has(id)) return true;
      visiting.add(id);
      for (const part of chipAllParts(definitions.get(id))) {
        if (part.type === "chip" && !visit(part.chipId)) return false;
      }
      visiting.delete(id); visited.add(id);
      return true;
    }
    for (const chip of chips) if (!visit(chip.id)) {
      return { ok: false, errors: ["芯片不能直接或间接包含自身（循环嵌套）"] };
    }
    return { ok: true, errors: [] };
  }

  /** 关卡预设、不可移动不可删除的元件 */
  const FIXED_TYPES = Object.freeze(["emitter", "wall"]);

  const ALL_TILE_TYPES = Object.freeze([...PLACEABLE_TYPES, ...FIXED_TYPES, TILE.TARGET]);

  function isRotatable(type) {
    return [TILE.MIRROR, TILE.SPLITTER, TILE.PRISM, "coldMirror", "hotMirror", "directionalEmitter", "chip", ...CHIP_PORT_TYPES].includes(type);
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
  // 分别配置两种元件，修改冷镜的通路或控制口不会覆盖热镜规则。
  const THERMAL_GEOMETRY = {
    coldMirror: { passage: [{ dx: 0, dy: 1 }, { dx: 1, dy: 0 }], control: [{ dx: 1, dy: 0 }, { dx: 0, dy: 1 }] },
    hotMirror: { passage: [{ dx: 0, dy: 1 }, { dx: 1, dy: 0 }], control: [{ dx: 1, dy: 0 }, { dx: 0, dy: 1 }] },
  };

  function thermalAxis(type, orient) {
    return THERMAL_GEOMETRY[type].passage[normalizeOrient(type, orient)];
  }

  function thermalAcceptsDirection(type, orient, dx, dy) {
    const axis = thermalAxis(type, orient);
    return (dx !== 0 || dy !== 0) && dx * axis.dy === dy * axis.dx;
  }

  function thermalControlAcceptsDirection(type, orient, dx, dy) {
    const axis = THERMAL_GEOMETRY[type].control[normalizeOrient(type, orient)];
    return (dx !== 0 || dy !== 0) && dx * axis.dy === dy * axis.dx;
  }

  function transmit(type, orient, dx, dy, color, facing, enabled) {
    if (type === "coldMirror" || type === "hotMirror") {
      const open = enabled === undefined ? type === "coldMirror" : enabled;
      // 有朝向的通光开关：仅正反两面可通光，侧面始终挡光，不反射、不分出额外光束。
      return open && thermalAcceptsDirection(type, orient, dx, dy) ? [{ dx, dy, color }] : [];
    }
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
      // facing 是整个棱镜的四向旋转，orient 仅控制 RGB 出口顺序。
      // 未提供 facing 的旧关卡数据保留旧的颜色槽位语义。
      if (facing !== undefined && entryIndex !== (2 + normalizeOrient("directionalEmitter", facing) * 2) % 8) return [];
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
    DIRECTION_INDEX_BY_NAME,
    COLOR,
    COLOR_LABELS,
    ORIENT,
    ORIENT_LABELS,
    TILE,
    PLACEABLE_TYPES,
    FREE_PLACEABLE_TYPES,
    CHIP_PORT_TYPES,
    MAX_CHIP_CELLS,
    isInputPort,
    isOutputPort,
    portOutputDirection,
    chipCircuits,
    chipCircuitAt,
    chipAllParts,
    chipComposite,
    normalizeChipAppearance,
    appearancePoints,
    appearanceAnchor,
    shapeContains,
    chipWorldPoint,
    chipLocalPoint,
    appearanceArrowCell,
    chipFootprint,
    placementFootprint,
    placementCollisions,
    chipLayoutError,
    chipExitPoint,
    chipDependsOn,
    validateChipGraph,
    thermalAcceptsDirection,
    thermalControlAcceptsDirection,
    thermalAxis,
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
