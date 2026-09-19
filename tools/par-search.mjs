#!/usr/bin/env node
"use strict";

// 关卡 par 验证器（开发工具，不进产品包）。
//
// 参考解只能证明「局部最优」——它说明这组元件能通关，但证明不了更少的元件不行。
// 本工具做的是全局搜索：从 0 个元件开始逐层加深，找到**元件数最少**的那组解，
// 那个数就是该关 par 的下界与取值。e05 曾被两个分光镜一分三破解过两次，
// 所以凡改关卡数据或改元件规则，都该重跑一遍。
//
// 用法：
//   node tools/par-search.mjs            校验全部内置关卡
//   node tools/par-search.mjs e02 e06    只看指定关卡（打印解法细节）
//   node tools/par-search.mjs --limit 5  把单关搜索深度上限提到 5（默认 par + 3）
//
// 搜索的可达性剪枝（重要，别随手删）：
//   一个元件若没有任何光射到它，拆掉它结果不变，因此**最小解里的每个元件都必然被光照到**。
//   把元件按依赖关系排序后，放第 i 个元件时它的格子一定已被当前部分配置照亮。
//   于是「候选格子 = 当前光场照到的空格」既不漏解、又能把分支砍到很小。
//   注意光照是会被元件改道的（加一个反射镜可能让下游变暗），所以候选只能按
//   当前配置现算，不能预先缓存一张格子表。

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const core = require(path.join(here, "..", "scripts", "light-core.js"));
const engine = require(path.join(here, "..", "scripts", "light-engine.js"));
const levelLib = require(path.join(here, "..", "scripts", "levels.js"));

const MAX_SEGMENTS = engine.MAX_SEGMENTS;

/** 光场照到的格子（光束进入过的每一格），用来生成候选位置 */
function litCells(level, placement) {
  const result = engine.solve(level, placement, { maxSegments: MAX_SEGMENTS });
  const cells = new Set();
  for (const segment of result.segments) cells.add(segment.to.x + "," + segment.to.y);
  return { cells, result };
}

function decodeCell(key) {
  const [x, y] = key.split(",").map(Number);
  return { x, y };
}

function sortCandidateKeys(keys) {
  return keys.sort((a, b) => {
    const [ax, ay] = a.split(",").map(Number);
    const [bx, by] = b.split(",").map(Number);
    return ay - by || ax - bx;
  });
}

function configKey(placement) {
  return placement
    .map((item) => item.type + ":" + item.x + "," + item.y + ":" + item.orient)
    .sort()
    .join("|");
}

/**
 * 搜索最少的元件数。
 * @param {object} level
 * @param {number} maxDepth 最多允许放几个元件
 * @param {{requireExact?: boolean}} [options] requireExact 为真时按「颜色必须完全相等」
 *   判定目标（默认沿用产品规则：入射色是需求色的超集即点亮）
 * @returns {{count:number, solution:Array|null, nodes:number, exhausted:boolean}}
 *   count 为找到的最小元件数；solution 为 null 表示在 maxDepth 内无解。
 */
function searchMinimum(level, maxDepth, options) {
  const exact = Boolean(options && options.requireExact);
  const solved = (result) =>
    result.targets.length > 0 &&
    result.targets.every((target) =>
      exact ? target.incoming === target.require : target.lit
    );

  const inventory = level.inventory || {};
  const empty = engine.solve(level, []);

  if (solved(empty)) return { count: 0, solution: [], nodes: 0, exhausted: true };

  const placement = [];
  const used = {};
  const nodes = { count: 0 };
  const seen = new Set();

  function optionsFor(type) {
    const total = inventory[type] || 0;
    const usedCount = used[type] || 0;
    return usedCount < total;
  }

  function dfs(depth, limit) {
    if (depth > limit) return null;

    const { cells } = litCells(level, placement);
    const grid = engine.buildGrid(level, placement).grid;
    const candidates = [];
    for (const key of sortCandidateKeys([...cells])) {
      const cell = decodeCell(key);
      if (cell.x < 0 || cell.y < 0 || cell.x >= level.cols || cell.y >= level.rows) continue;
      if (engine.cellAt(grid, cell.x, cell.y) !== null) continue;
      candidates.push(cell);
    }

    for (const cell of candidates) {
      for (const type of core.PLACEABLE_TYPES) {
        if (!optionsFor(type)) continue;
        const states = core.orientStateCount(type);
        for (let orient = 0; orient < states; orient += 1) {
          const key = configKey([...placement, { type, x: cell.x, y: cell.y, orient }]);
          if (seen.has(key)) continue;
          seen.add(key);

          const item = { type, x: cell.x, y: cell.y, orient };
          placement.push(item);
          used[type] = (used[type] || 0) + 1;
          nodes.count += 1;

          const result = engine.solve(level, placement, { maxSegments: MAX_SEGMENTS });
          let found = null;
          if (solved(result)) {
            found = placement.map((entry) => ({ ...entry }));
          } else if (depth < limit) {
            found = dfs(depth + 1, limit);
          }

          used[type] -= 1;
          placement.pop();
          if (found) return found;
        }
      }
    }
    return null;
  }

  for (let limit = 1; limit <= maxDepth; limit += 1) {
    seen.clear();
    const solution = dfs(1, limit);
    if (solution) return { count: solution.length, solution, nodes: nodes.count, exhausted: true };
  }
  return { count: -1, solution: null, nodes: nodes.count, exhausted: false };
}

function describeSolution(solution) {
  if (solution.length === 0) return "（无需放置任何元件）";
  return solution
    .map((item) => `${item.type}[${item.x},${item.y}]朝向${item.orient}`)
    .join("  ");
}

function main() {
  const args = process.argv.slice(2);
  let maxDepthOverride = 0;
  const wanted = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--limit") {
      maxDepthOverride = Number(args[i + 1]);
      i += 1;
    } else {
      wanted.push(args[i]);
    }
  }

  const all = levelLib.LEVELS;
  const targets = wanted.length > 0 ? all.filter((level) => wanted.indexOf(level.id) !== -1) : all;

  if (targets.length === 0) {
    console.error("没有匹配的关卡。可用的 id：" + all.map((level) => level.id).join(" "));
    process.exitCode = 1;
    return;
  }

  let failed = 0;
  const rows = [];

  for (const level of targets) {
    const maxDepth = maxDepthOverride > 0 ? maxDepthOverride : Math.max(level.par, 3) + 3;
    const started = Date.now();
    const found = searchMinimum(level, maxDepth);
    const elapsed = Date.now() - started;

    let verdict;
    let note = "";
    if (found.count < 0) {
      verdict = "无解";
      note = `${maxDepth} 个元件内无解（光路可能被库存卡死）`;
      failed += 1;
    } else if (found.count > level.par) {
      verdict = "par 太小";
      note = `最少需要 ${found.count} 个，par 是 ${level.par} —— 三颗星拿不到`;
      failed += 1;
    } else if (found.count < level.par) {
      verdict = "par 太大";
      note = `最少只要 ${found.count} 个，par 却写了 ${level.par} —— 三星门槛虚高`;
      failed += 1;
    } else {
      verdict = "OK";
    }

    rows.push({
      id: level.id,
      title: level.title,
      par: level.par,
      min: found.count,
      verdict,
      note,
      elapsed,
      solution: found.solution,
    });
  }

  console.log("");
  console.log("id    声明  实际  结论     耗时");
  console.log("----  ----  ----  -------  ------");
  for (const row of rows) {
    const min = row.min < 0 ? " — " : String(row.min);
    console.log(
      `${row.id.padEnd(6)}${String(row.par).padStart(4)}${min.padStart(6)}  ` +
        `${row.verdict.padEnd(9)}${String(row.elapsed + "ms").padStart(7)}`
    );
  }

  const detailed = wanted.length > 0;
  if (detailed) {
    console.log("");
    for (const row of rows) {
      console.log(`【${row.id}】${row.title}`);
      console.log(`  声明 par = ${row.par}，穷举最少 = ${row.min < 0 ? "无解" : row.min}`);
      console.log(`  一组解：${row.solution ? describeSolution(row.solution) : "（无）"}`);
      if (row.note) console.log(`  说明：${row.note}`);
      console.log("");
    }
  } else {
    for (const row of rows) {
      if (row.note) console.log(`  ${row.id}：${row.note}`);
    }
  }

  if (failed > 0) {
    console.log("");
    console.log(`${failed} 关没通过：改关卡数据或元件规则后必须重跑到全 OK。`);
    process.exitCode = 1;
  } else {
    console.log("");
    console.log(`全部 ${rows.length} 关 par 已由穷举确认。`);
  }
}

export { searchMinimum, litCells, describeSolution };

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) main();
