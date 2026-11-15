"use strict";

// 光路求解器：把「关卡 + 玩家放置的元件」算成「光段 + 目标状态」。
//
// 纯计算层 —— 不碰 DOM、不碰 canvas、无副作用、无随机，可在 Node 里直接单测。
// 浏览器中挂到 globalThis.LightEngine；Node 单测环境通过 module.exports 引入同一份实现。
//
// 设计要点（详见 doc/设计文档.md 4.4）：
//   · 以所有光源为起点做迭代式追踪（工作队列，非递归，避免深光路爆栈）
//   · 进入同一格时按 (格坐标, 方向, 颜色) 去重，同一状态只处理一次 —— 这既是剪枝，
//     也保证分光镜产生的重叠光路不会让光段列表出现重复项
//   · 单次求解最多 MAX_SEGMENTS 个光段，超出即停止并置 overflow

(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.LightEngine = api;
  }
})(globalThis, function (root) {
  const core =
    typeof module === "object" && module.exports ? require("./light-core.js") : root.LightCore;

  /** 单次求解允许生成的最大光段数，防止病态关卡把页面卡死 */
  const MAX_SEGMENTS = 4096;

  // ---------- 网格 ----------

  function createGrid(cols, rows) {
    return { cols, rows, cells: new Array(cols * rows).fill(null) };
  }

  function indexOf(grid, x, y) {
    return y * grid.cols + x;
  }

  function inBounds(grid, x, y) {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < grid.cols && y < grid.rows;
  }

  function cellAt(grid, x, y) {
    if (grid.infinite) return grid.byPosition.get(x + "," + y) || null;
    if (!inBounds(grid, x, y)) return null;
    return grid.cells[indexOf(grid, x, y)];
  }

  function setCell(grid, x, y, value) {
    if (!inBounds(grid, x, y)) return false;
    grid.cells[indexOf(grid, x, y)] = value;
    return true;
  }

  /**
   * 合并关卡预设与玩家放置，得到完整网格。
   * 落在越界、已被占用或非可放置类型的放置会被丢弃并记进 rejected。
   * @returns {{grid: object, placedCount: number, rejected: Array}}
   */
  function buildGrid(level, placement) {
    const grid = createGrid(level.cols, level.rows);

    for (const item of level.fixed || []) {
      if (!inBounds(grid, item.x, item.y)) continue;
      if (item.type === core.TILE.EMITTER) {
        setCell(grid, item.x, item.y, {
          type: core.TILE.EMITTER,
          dir: core.toDirectionIndex(item.dir),
          color: item.color || core.COLOR.R,
          omni: level.mode === "free" && item.dir === "all",
          fixed: true,
        });
      } else {
        setCell(grid, item.x, item.y, { type: item.type, fixed: true });
      }
    }

    for (const target of level.targets || []) {
      if (!inBounds(grid, target.x, target.y)) continue;
      setCell(grid, target.x, target.y, {
        type: core.TILE.TARGET,
        require: target.require,
        fixed: true,
      });
    }

    let placedCount = 0;
    const rejected = [];
    for (const item of placement || []) {
      const acceptable =
        inBounds(grid, item.x, item.y) &&
        (core.isPlaceable(item.type) ||
          (level.mode === "free" && core.FREE_PLACEABLE_TYPES.includes(item.type))) &&
        cellAt(grid, item.x, item.y) === null;
      if (!acceptable) {
        rejected.push(item);
        continue;
      }
      setCell(grid, item.x, item.y, {
        type: item.type,
        orient: core.normalizeOrient(item.type, item.orient),
        ...(item.type === "prism" && item.facing !== undefined
          ? { facing: core.normalizeOrient("directionalEmitter", item.facing) } : {}),
        fixed: false,
        ...(item.type === core.TILE.EMITTER ? { omni: true, dir: 0, color: 7 } : {}),
      });
      placedCount += 1;
    }

    return { grid, placedCount, rejected };
  }

  // ---------- 求解 ----------

  /**
   * 计算光路。
   *
   * @param {object} level 关卡定义
   * @param {Array} placement 玩家放置的元件 [{ type, x, y, orient }]
   * @param {{maxSegments?: number}} [options]
   * @returns {{
   *   grid: object,
   *   segments: Array<{from: {x:number,y:number}, to: {x:number,y:number}, color: number}>,
   *   targets: Array<{x:number, y:number, require:number, incoming:number, lit:boolean}>,
   *   allLit: boolean,
   *   placedCount: number,
   *   rejected: Array,
   *   overflow: boolean
   * }}
   */
  function solve(level, placement, options) {
    if (level.mode === "free" && level.infinite) return solveInfinite(placement, options, level);
    const maxSegments = (options && options.maxSegments) || MAX_SEGMENTS;
    const { grid, placedCount, rejected } = buildGrid(level, placement);
    const runtime = options && options.runtime;
    const path = options && options.path || "root";

    const segments = [];
    const targetIncoming = new Map();
    const visited = new Set();
    const queue = [];
    let overflow = false;

    // 所有光源入队（按行优先扫描，保证求解顺序确定，从而保证幂等）
    for (let y = 0; y < grid.rows; y += 1) {
      for (let x = 0; x < grid.cols; x += 1) {
        const cell = cellAt(grid, x, y);
        if (runtime && cell) {
          cell.x = x; cell.y = y;
          if (cell.type === "coldMirror" || cell.type === "hotMirror") runtime.thermal(cell, path, 0);
        }
        if (!cell || cell.type !== core.TILE.EMITTER || (!cell.omni && cell.dir < 0)) continue;
        const beams = runtime ? runtime.source(cell, path)
          : (cell.omni ? [0, 2, 4, 6] : [cell.dir]).map((dir) => ({ dir, color: cell.color }));
        for (const beam of beams) {
          const direction = core.DIRECTIONS[beam.dir];
          queue.push({ x, y, dx: direction.dx, dy: direction.dy, color: beam.color });
        }
      }
    }

    let head = 0;
    while (head < queue.length) {
      if (segments.length >= maxSegments) {
        overflow = true;
        break;
      }

      const beam = queue[head];
      head += 1;

      const nx = beam.x + beam.dx;
      const ny = beam.y + beam.dy;
      if (!inBounds(grid, nx, ny)) continue; // 出界：光直接消失，不产生光段

      const dirIndex = core.directionIndexFromVector(beam.dx, beam.dy);
      const visitKey = nx + "," + ny + "," + dirIndex + "," + beam.color;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);

      segments.push({
        from: { x: beam.x, y: beam.y },
        to: { x: nx, y: ny },
        color: beam.color,
      });

      const cell = cellAt(grid, nx, ny);
      const type = cell ? cell.type : null;

      if (type === core.TILE.TARGET) {
        const key = indexOf(grid, nx, ny);
        targetIncoming.set(key, (targetIncoming.get(key) || 0) | beam.color);
        continue;
      }

      if (core.stopsLight(type)) continue;
      if (runtime && (type === "coldMirror" || type === "hotMirror")) {
        const control = core.thermalControlAcceptsDirection(type, cell.orient, beam.dx, beam.dy);
        const enabled = runtime.thermal(cell, path, control ? beam.color : 0);
        for (const out of core.transmit(type, cell.orient, beam.dx, beam.dy, beam.color, undefined, enabled)) {
          queue.push({ x: nx, y: ny, ...out });
        }
        continue;
      }

      const orient = cell ? cell.orient : core.ORIENT.SLASH;
      const outgoing = core.transmit(type, orient, beam.dx, beam.dy, beam.color, cell && cell.facing);
      for (const out of outgoing) {
        if (core.directionIndexFromVector(out.dx, out.dy) === -1) continue;
        queue.push({ x: nx, y: ny, dx: out.dx, dy: out.dy, color: out.color });
      }
    }

    const targets = (level.targets || []).map((target) => {
      const rawIncoming = inBounds(grid, target.x, target.y)
        ? targetIncoming.get(indexOf(grid, target.x, target.y)) || 0
        : 0;
      const cell = cellAt(grid, target.x, target.y);
      const incoming = runtime ? runtime.target(cell, path, rawIncoming) : rawIncoming;
      return {
        x: target.x,
        y: target.y,
        require: target.require,
        incoming,
        ...(runtime ? { rawIncoming, waiting: Boolean(cell && cell.waiting) } : {}),
        lit: (incoming & target.require) === target.require,
      };
    });

    const result = {
      grid,
      segments,
      targets,
      allLit: targets.length > 0 && targets.every((target) => target.lit),
      placedCount,
      rejected,
      overflow,
    };
    if (runtime) runtime.capture(path, result);
    return result;
  }

  /**
   * 星级：★ 通关；★★ 元件数 ≤ par+2；★★★ 元件数 ≤ par。
   * @returns {number} 0–3
   */
  function starsFor(allLit, placedCount, par) {
    if (!allLit) return 0;
    if (placedCount <= par) return 3;
    if (placedCount <= par + 2) return 2;
    return 1;
  }

  // 无限实验板只存已占用的格子。光线直接跳到最近的元件，
  // 不逐格扫描空白，因此相隔百万格的两个元件也不需要分配百万格内存。
  function solveInfinite(placement, options, level) {
    options = options || {};
    const runtime = options.runtime;
    const path = options.path || "root";
    const chips = level.chips || [];
    const grid = { infinite: true, cells: [], byPosition: new Map() };
    const rejected = [];
    for (const item of placement || []) {
      const key = item.x + "," + item.y;
      if (!Number.isSafeInteger(item.x) || !Number.isSafeInteger(item.y) ||
          !(core.FREE_PLACEABLE_TYPES.includes(item.type) || (level.insideChip && core.CHIP_PORT_TYPES.includes(item.type))) || grid.byPosition.has(key)) {
        rejected.push(item);
        continue;
      }
      const footprint = core.placementFootprint(item, chips);
      if (footprint.some((point) => !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y) ||
          grid.byPosition.has(point.x + "," + point.y))) {
        rejected.push(item);
        continue;
      }
      const cell = { ...item, fixed: false, orient: core.normalizeOrient(item.type, item.orient) };
      if (item.type === "emitter") Object.assign(cell, { omni: true, dir: 0, color: 7 });
      if (item.type === "directionalEmitter") Object.assign(cell, { type: core.TILE.EMITTER, omni: false,
        dir: core.normalizeOrient(item.type, item.orient) * 2, color: 7 });
      if (item.type === "bulb") Object.assign(cell, { type: core.TILE.TARGET, bulb: true, require: 7 });
      if (cell.type === "chip") {
        cell.footprint = footprint;
        const definition = chips.find((chip) => chip.id === cell.chipId);
        const parts = definition ? core.chipAllParts(definition) : [];
        const portDirs = (predicate) => [...new Set(parts.filter((part) => predicate(part.type))
          .map((part) => (core.normalizeOrient(part.type, part.orient) * 2 + cell.orient * 2) % 8))];
        cell.portDirections = portDirs(core.isInputPort);
        cell.outputDirections = [...new Set(parts.filter((part) => core.isOutputPort(part.type))
          .map((part) => (core.portOutputDirection(part.type, part.orient) + cell.orient * 2) % 8))];
        cell.inputColors = Array(8).fill(0);
        cell.acceptedInputColors = Array(8).fill(0);
        cell.outputColors = Array(8).fill(0);
      }
      if (core.CHIP_PORT_TYPES.includes(cell.type)) { cell.inputColor = 0; cell.outputColor = 0; }
      grid.cells.push(cell);
      grid.byPosition.set(key, cell);
      if (cell.type === "chip") for (const point of footprint) {
        if (point.x === cell.x && point.y === cell.y) continue;
        const part = { type: "chipPart", x: point.x, y: point.y, chipAnchor: key };
        grid.cells.push(part); grid.byPosition.set(point.x + "," + point.y, part);
      }
      if (runtime && (cell.type === "coldMirror" || cell.type === "hotMirror")) runtime.thermal(cell, path, 0);
    }
    const view = options && options.view;
    const bounds = view || { minX: -30, maxX: 30, minY: -30, maxY: 30 };
    const queue = [];
    const outputs = [];
    const budget = options.budget || { remaining: MAX_SEGMENTS * 4 };
    const chipCache = new Map();
    let chipOverflow = false;
    function chipOutput(cell, dir, color, entry) {
      const chip = chips.find((entry) => entry.id === cell.chipId);
      if (!chip) return [];
      if ((options.ancestors || []).includes(cell.chipId)) { chipOverflow = true; return []; }
      const rotation = core.normalizeOrient("chip", cell.orient) * 2;
      const localDir = dir === null ? null : (dir - rotation + 8) % 8;
      const at = chip.appearance && entry ? core.chipLocalPoint(chip, cell, entry) : undefined;
      const cacheKey = [runtime ? runtime.childPath(path, cell) : cell.chipId, localDir, color, at?.x, at?.y].join(":");
      const externalOutput = (out) => ({ dir: (out.dir + rotation) % 8, color: out.color,
        ...(out.port ? { position: core.chipWorldPoint(chip, cell, out.port) } : {}) });
      if (chipCache.has(cacheKey)) return chipCache.get(cacheKey).map(externalOutput);
      const composite = chip.appearance ? core.chipComposite(chip) : null;
      const internalPlacement = composite ? composite.placement : chip.placement;
      const internalChips = composite ? [...chips, ...composite.definitions] : chips;
      const cost = internalPlacement.length + 1;
      if (budget.remaining < cost) { chipOverflow = true; return []; }
      budget.remaining -= cost;
      const result = solveInfinite(internalPlacement, { ancestors: [...(options.ancestors || []), cell.chipId],
        inputs: dir === null ? [] : [{ dir: localDir, color, ...(at ? { at } : {}) }], budget,
        runtime, path: runtime ? runtime.childPath(path, cell) : path,
        compositeShape: chip.appearance,
        inspection: options.inspection,
        view: runtime && options.inspection && options.inspection.path === runtime.childPath(path, cell)
          ? options.inspection.view : undefined,
        skipSources: dir !== null, maxSegments: Math.min(options.maxSegments || MAX_SEGMENTS, 1024) },
      { ...level, insideChip: true, chips: internalChips, chipShape: undefined });
      chipOverflow = chipOverflow || result.overflow;
      chipCache.set(cacheKey, result.outputs);
      return result.outputs.map(externalOutput);
    }
    function emitFromChip(cell, out, entry) {
      cell.outputColors[out.dir] |= out.color;
      if (options.compositeShape) {
        const direction = core.DIRECTIONS[out.dir];
        if (!core.shapeContains(options.compositeShape, cell.x + direction.dx, cell.y + direction.dy)) {
          outputs.push({ dir: out.dir, color: out.color, port: { x: cell.x, y: cell.y } });
          return;
        }
      }
      queue.push({ ...(out.position || core.chipExitPoint(cell, out.dir, entry)), dir: out.dir, color: out.color });
    }
    for (const cell of grid.cells) {
      if (!options.skipSources && cell.type === "chip") {
        for (const out of chipOutput(cell, null, 0)) {
          emitFromChip(cell, out);
        }
      }
      if (cell.type !== core.TILE.EMITTER) continue;
      const beams = runtime ? runtime.source(cell, path)
        : (cell.omni ? [0, 2, 4, 6] : [cell.dir]).map((dir) => ({ dir, color: 7 }));
      if (!options.skipSources) for (const beam of beams) {
        queue.push({ x: cell.x, y: cell.y, ...beam });
      }
    }
    for (const input of options.inputs || []) {
      if (options.compositeShape && input.at) {
        const cell = grid.byPosition.get(input.at.x + "," + input.at.y);
        if (cell?.type === "chip") {
          cell.inputColors[input.dir] |= input.color;
          if (cell.portDirections.includes(input.dir)) cell.acceptedInputColors[input.dir] |= input.color;
          for (const out of chipOutput(cell, input.dir, input.color)) emitFromChip(cell, out);
        }
        continue;
      }
      for (const cell of grid.cells) {
        if (core.isInputPort(cell.type) && cell.orient * 2 === input.dir) {
          cell.inputColor |= input.color;
          queue.push({ x: cell.x, y: cell.y, dir: input.dir, color: input.color });
        }
      }
    }
    const segments = [];
    const incoming = new Map();
    const visited = new Set();
    const maxSegments = options && options.maxSegments || MAX_SEGMENTS;
    let head = 0;
    while (head < queue.length && segments.length < maxSegments && budget.remaining > 0) {
      const beam = queue[head++];
      const visitKey = [beam.x, beam.y, beam.dir, beam.color].join(",");
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);
      budget.remaining -= 1;
      const { dx, dy } = core.DIRECTIONS[beam.dir];
      let hit = null;
      let distance = Infinity;
      for (const cell of grid.cells) {
        const rx = cell.x - beam.x;
        const ry = cell.y - beam.y;
        const step = dx ? rx / dx : ry / dy;
        if (step > 0 && step < distance && rx === step * dx && ry === step * dy) {
          hit = cell;
          distance = step;
        }
      }
      if (!hit) {
        // 开放光线延伸到当前视野外；改变视野会重新求解开放光段。
        const edges = [];
        if (dx > 0) edges.push((Math.max(bounds.maxX + 2, beam.x + 2) - beam.x) / dx);
        if (dx < 0) edges.push((Math.min(bounds.minX - 2, beam.x - 2) - beam.x) / dx);
        if (dy > 0) edges.push((Math.max(bounds.maxY + 2, beam.y + 2) - beam.y) / dy);
        if (dy < 0) edges.push((Math.min(bounds.minY - 2, beam.y - 2) - beam.y) / dy);
        distance = Math.max(1, Math.min(...edges));
      }
      segments.push({ from: { x: beam.x, y: beam.y },
        to: { x: beam.x + dx * distance, y: beam.y + dy * distance }, color: beam.color });
      if (!hit || hit.type === core.TILE.WALL) continue;
      if (core.CHIP_PORT_TYPES.includes(hit.type)) {
        // 箭头指向内部：顺箭头继续进入，反箭头穿向外侧；侧面挡光。
        const inward = core.normalizeOrient(hit.type, hit.orient) * 2;
        if (beam.dir === inward) {
          hit.inputColor |= beam.color;
          queue.push({ ...beam, x: hit.x, y: hit.y });
        } else if (beam.dir === core.portOutputDirection(hit.type, hit.orient)) {
          hit.outputColor |= beam.color;
          outputs.push({ dir: beam.dir, color: beam.color });
        }
        continue;
      }
      if (hit.type === "chip" || hit.type === "chipPart") {
        const chip = hit.type === "chip" ? hit : grid.byPosition.get(hit.chipAnchor);
        chip.inputColors[beam.dir] |= beam.color;
        const definition = chips.find((entry) => entry.id === chip.chipId);
        const at = definition?.appearance ? core.chipLocalPoint(definition, chip, hit) : undefined;
        const localDir = (beam.dir - chip.orient * 2 + 8) % 8;
        const parts = at && definition ? core.chipCircuitAt(definition, at)?.placement || [] : definition?.placement || [];
        const matched = parts.some((part) => core.isInputPort(part.type) &&
          core.normalizeOrient(part.type, part.orient) * 2 === localDir);
        if (!matched) {
          // 芯片默认挡光；必须接通输入口和内部输出口，才会向外发光。
          continue;
        } else {
          chip.acceptedInputColors[beam.dir] |= beam.color;
          for (const out of chipOutput(chip, beam.dir, beam.color, hit)) {
          emitFromChip(chip, out, hit);
          }
        }
        continue;
      }
      if (hit.type === core.TILE.TARGET) {
        const key = hit.x + "," + hit.y;
        incoming.set(key, (incoming.get(key) || 0) | beam.color);
        continue;
      }
      if (runtime && (hit.type === "coldMirror" || hit.type === "hotMirror")) {
        const control = core.thermalControlAcceptsDirection(hit.type, hit.orient, dx, dy);
        const enabled = runtime.thermal(hit, path, control ? beam.color : 0);
        for (const out of core.transmit(hit.type, hit.orient, dx, dy, beam.color, undefined, enabled)) {
          queue.push({ x: hit.x, y: hit.y, dir: core.directionIndexFromVector(out.dx, out.dy), color: out.color });
        }
        continue;
      }
      for (const out of core.transmit(hit.type, hit.orient, dx, dy, beam.color, hit.facing)) {
        queue.push({ x: hit.x, y: hit.y, dir: core.directionIndexFromVector(out.dx, out.dy), color: out.color });
      }
    }
    const targets = grid.cells.filter((cell) => cell.type === core.TILE.TARGET).map((cell) => {
      const rawIncoming = incoming.get(cell.x + "," + cell.y) || 0;
      const color = runtime ? runtime.target(cell, path, rawIncoming) : rawIncoming;
      return { x: cell.x, y: cell.y, require: color || 7, incoming: color,
        ...(runtime ? { rawIncoming, waiting: Boolean(cell.waiting) } : {}), lit: color !== 0, bulb: true };
    });
    const result = { grid, segments, targets, allLit: targets.length > 0 && targets.every((t) => t.lit),
      placedCount: grid.cells.filter((cell) => cell.type !== "chipPart").length, rejected, outputs, overflow: head < queue.length || chipOverflow };
    if (runtime) runtime.capture(path, result);
    return result;
  }

  return {
    MAX_SEGMENTS,
    createGrid,
    indexOf,
    inBounds,
    cellAt,
    setCell,
    buildGrid,
    solve,
    starsFor,
  };
});
