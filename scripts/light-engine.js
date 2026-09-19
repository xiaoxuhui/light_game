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
        core.isPlaceable(item.type) &&
        cellAt(grid, item.x, item.y) === null;
      if (!acceptable) {
        rejected.push(item);
        continue;
      }
      setCell(grid, item.x, item.y, {
        type: item.type,
        orient: core.normalizeOrient(item.type, item.orient),
        fixed: false,
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
    const maxSegments = (options && options.maxSegments) || MAX_SEGMENTS;
    const { grid, placedCount, rejected } = buildGrid(level, placement);

    const segments = [];
    const targetIncoming = new Map();
    const visited = new Set();
    const queue = [];
    let overflow = false;

    // 所有光源入队（按行优先扫描，保证求解顺序确定，从而保证幂等）
    for (let y = 0; y < grid.rows; y += 1) {
      for (let x = 0; x < grid.cols; x += 1) {
        const cell = cellAt(grid, x, y);
        if (!cell || cell.type !== core.TILE.EMITTER || cell.dir < 0) continue;
        const direction = core.DIRECTIONS[cell.dir];
        queue.push({ x, y, dx: direction.dx, dy: direction.dy, color: cell.color });
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

      const orient = cell ? cell.orient : core.ORIENT.SLASH;
      const outgoing = core.transmit(type, orient, beam.dx, beam.dy, beam.color);
      for (const out of outgoing) {
        if (core.directionIndexFromVector(out.dx, out.dy) === -1) continue;
        queue.push({ x: nx, y: ny, dx: out.dx, dy: out.dy, color: out.color });
      }
    }

    const targets = (level.targets || []).map((target) => {
      const incoming = inBounds(grid, target.x, target.y)
        ? targetIncoming.get(indexOf(grid, target.x, target.y)) || 0
        : 0;
      return {
        x: target.x,
        y: target.y,
        require: target.require,
        incoming,
        lit: (incoming & target.require) === target.require,
      };
    });

    return {
      grid,
      segments,
      targets,
      allLit: targets.length > 0 && targets.every((target) => target.lit),
      placedCount,
      rejected,
      overflow,
    };
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
