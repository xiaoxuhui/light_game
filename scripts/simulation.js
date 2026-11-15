"use strict";

// 离散时钟只推进有时间的元件；两拍之间的传播、反射、分光和 IO 均即时求解。
(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports
    ? require("./light-engine.js") : root.LightEngine);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LightSimulation = api;
})(globalThis, function (engine) {
  const STEP_MS = 500;

  function createSimulation() {
    const nodes = new Map();
    const views = new Map();
    let tick = 0;
    let pending = false;

    function key(cell, path) { return path + "/" + cell.x + "," + cell.y + ":" + cell.type; }
    function touch(cell, path, kind) {
      const id = key(cell, path);
      let node = nodes.get(id);
      if (!node) {
        node = { kind, seen: true, current: null, desired: null, signature: "", ready: 0,
          color: 0, observed: 0, temperature: 0, open: cell.type === "coldMirror" };
        nodes.set(id, node);
      }
      node.seen = true;
      return node;
    }

    const runtime = {
      childPath(path, cell) { return path + "/chip(" + cell.x + "," + cell.y + "," + cell.chipId + ")"; },
      source(cell, path) {
        const node = touch(cell, path, "source");
        const signature = JSON.stringify([cell.dir, cell.omni, cell.color]);
        if (node.signature !== signature) {
          node.signature = signature; node.desired = { ...cell }; node.ready = tick + 1;
          // 关卡预设光源在开局时已存在，后续变化仍按拍生效。
          if (cell.fixed && !node.current) { node.current = node.desired; node.ready = tick; }
        }
        cell.powered = Boolean(node.current);
        cell.waiting = node.current !== node.desired;
        const active = node.current;
        return active ? (active.omni ? [0, 2, 4, 6] : [active.dir]).map((dir) => ({ dir, color: active.color })) : [];
      },
      thermal(cell, path, color) {
        const node = touch(cell, path, cell.type);
        node.observed |= color || 0;
        cell.temperature = node.temperature;
        cell.open = node.open;
        cell.receiving = Boolean(node.observed);
        return node.open;
      },
      target(cell, path, color) {
        const node = touch(cell, path, "target");
        node.observed |= color;
        cell.waiting = node.color !== node.observed;
        return node.color;
      },
      capture(path, result) {
        const previous = views.get(path);
        if (!previous) {
          // 实时视图独立聚合各个入口，不能改动求解器的输出缓存。
          views.set(path, { ...result, segments: [...result.segments],
            targets: result.targets.map((target) => ({ ...target })),
            grid: { ...result.grid, cells: result.grid.cells.map((cell) => cell ? { ...cell } : cell) },
            ...(result.outputs ? { outputs: result.outputs.map((out) => ({ ...out })) } : {}) });
          return;
        }
        const seen = new Set(previous.segments.map((s) => JSON.stringify(s)));
        for (const segment of result.segments) {
          const token = JSON.stringify(segment);
          if (!seen.has(token)) { previous.segments.push(segment); seen.add(token); }
        }
        previous.overflow = previous.overflow || result.overflow;
        for (const output of result.outputs || []) {
          const existing = previous.outputs.find((out) => out.dir === output.dir &&
            out.port?.x === output.port?.x && out.port?.y === output.port?.y);
          if (existing) existing.color |= output.color;
          else previous.outputs.push({ ...output });
        }
        for (const cell of result.grid.cells) {
          if (!cell || !["io", "inputPort", "outputPort", "coldMirror", "hotMirror", "chip"].includes(cell.type)) continue;
          const previousCell = previous.grid.cells.find((part) => part?.x === cell.x && part?.y === cell.y);
          if (previousCell) {
            if (cell.type === "chip") {
              for (const name of ["inputColors", "outputColors", "acceptedInputColors"]) {
                for (let dir = 0; dir < 8; dir++) previousCell[name][dir] |= cell[name][dir];
              }
            } else if (["coldMirror", "hotMirror"].includes(cell.type)) previousCell.receiving ||= cell.receiving;
            else {
              previousCell.inputColor |= cell.inputColor;
              previousCell.outputColor |= cell.outputColor;
            }
          }
        }
        for (const target of result.targets) {
          const previousTarget = previous.targets.find((item) => item.x === target.x && item.y === target.y);
          if (previousTarget) {
            previousTarget.rawIncoming |= target.rawIncoming || 0;
            previousTarget.waiting = previousTarget.incoming !== previousTarget.rawIncoming;
          }
        }
      },
    };

    return {
      get tick() { return tick; },
      get pending() { return pending; },
      childPath: runtime.childPath,
      getView(path) { return views.get(path); },
      reset() { nodes.clear(); views.clear(); tick = 0; pending = false; },
      solve(level, placement, options) {
        views.clear();
        for (const node of nodes.values()) { node.seen = false; node.observed = 0; }
        const result = engine.solve(level, placement, { ...options, runtime, path: "root" });
        pending = false;
        for (const [id, node] of nodes) {
          if (!node.seen) { nodes.delete(id); continue; }
          if (node.kind === "source") pending = pending || node.current !== node.desired;
          else if (node.kind === "target") pending = pending || node.color !== node.observed;
          else pending = pending || node.temperature !== (node.observed ? 1 : 0);
        }
        return result;
      },
      advance() {
        tick += 1;
        for (const node of nodes.values()) {
          if (node.kind === "source") {
            if (tick >= node.ready) node.current = node.desired;
          } else if (node.kind === "target") node.color = node.observed;
          else if (node.kind === "coldMirror") {
            // 冷镜是侧面输入的一拍非门，与热镜的受光开关独立。
            node.open = !node.observed;
            node.temperature = node.observed ? 1 : 0;
          } else if (node.kind === "hotMirror") {
            // 热镜独立使用侧面正向控制：有光开、无光关，延迟一拍。
            node.open = Boolean(node.observed);
            node.temperature = node.observed ? 1 : 0;
          }
        }
      },
    };
  }

  return { STEP_MS, createSimulation };
});
