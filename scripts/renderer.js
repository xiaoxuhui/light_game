"use strict";

// 渲染层：把求解结果画到 canvas。
//
// 职责边界 —— 只画，不判断：
//   · 不复制任何规则判定，元件朝向、目标是否点亮、光段位置全部读自 LightEngine 的输出
//   · 不读 DOM（除传入的 ctx），不写全局状态，同样的参数画两次必须完全一致
//
// 画布以设备像素作画（与 app.js 的 DPR 处理保持一致），格边长由画布尺寸反算。

(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.LightRenderer = api;
  }
})(globalThis, function (root) {
  const core =
    typeof module === "object" && module.exports ? require("./light-core.js") : root.LightCore;

  // ---------- 配色（深色主题） ----------

  const BACKGROUND = "#08090c";
  const BOARD_FILL = "#0d1016";
  const GRID_LINE = "rgba(255, 255, 255, 0.055)";
  const BOARD_EDGE = "rgba(255, 255, 255, 0.10)";
  const ELEMENT_LINE = "#e4eaf4";
  const WALL_FILL = "#1b2028";
  const WALL_EDGE = "rgba(255, 255, 255, 0.09)";

  /** 颜色掩码 → 具体色值 */
  const BEAM_COLORS = Object.freeze({
    1: "#ff5f5f",
    2: "#5ce08a",
    3: "#ffd451",
    4: "#5aa9ff",
    5: "#ff6ee0",
    6: "#4fe3e0",
    7: "#ffffff",
  });

  function beamColor(mask) {
    return BEAM_COLORS[mask] || "#8b93a1";
  }

  function withAlpha(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return "rgba(" + r + ", " + g + ", " + b + ", " + alpha + ")";
  }

  // ---------- 几何 ----------

  /**
   * 反算网格布局。取较小的格边长保证是正方形格，整体居中。
   * @returns {{cell:number, cols:number, rows:number, boardW:number, boardH:number, ox:number, oy:number}}
   */
  function computeLayout(width, height, cols, rows, padding) {
    const pad = typeof padding === "number" ? padding : 0;
    const availableWidth = Math.max(1, width - pad * 2);
    const availableHeight = Math.max(1, height - pad * 2);
    const cell = Math.max(6, Math.floor(Math.min(availableWidth / cols, availableHeight / rows)));
    const boardW = cell * cols;
    const boardH = cell * rows;

    return {
      cell,
      cols,
      rows,
      boardW,
      boardH,
      ox: Math.round((width - boardW) / 2),
      oy: Math.round((height - boardH) / 2),
    };
  }

  /** 画布坐标 → 格坐标（越界返回 null） */
  function pointToCell(layout, px, py) {
    const x = Math.floor((px - layout.ox) / layout.cell);
    const y = Math.floor((py - layout.oy) / layout.cell);
    if (x < 0 || y < 0 || x >= layout.cols || y >= layout.rows) return null;
    return { x, y };
  }

  function cellCenter(layout, x, y) {
    return {
      x: layout.ox + (x + 0.5) * layout.cell,
      y: layout.oy + (y + 0.5) * layout.cell,
    };
  }

  function roundRectPath(ctx, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.arcTo(x + width, y, x + width, y + r, r);
    ctx.lineTo(x + width, y + height - r);
    ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
    ctx.lineTo(x + r, y + height);
    ctx.arcTo(x, y + height, x, y + height - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  // ---------- 各层绘制 ----------

  function drawBoard(ctx, layout) {
    ctx.fillStyle = BOARD_FILL;
    ctx.fillRect(layout.ox, layout.oy, layout.boardW, layout.boardH);

    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= layout.cols; x += 1) {
      const px = Math.round(layout.ox + x * layout.cell) + 0.5;
      ctx.moveTo(px, layout.oy);
      ctx.lineTo(px, layout.oy + layout.boardH);
    }
    for (let y = 0; y <= layout.rows; y += 1) {
      const py = Math.round(layout.oy + y * layout.cell) + 0.5;
      ctx.moveTo(layout.ox, py);
      ctx.lineTo(layout.ox + layout.boardW, py);
    }
    ctx.stroke();

    ctx.strokeStyle = BOARD_EDGE;
    ctx.lineWidth = 1;
    ctx.strokeRect(layout.ox + 0.5, layout.oy + 0.5, layout.boardW - 1, layout.boardH - 1);
  }

  function drawWall(ctx, layout, x, y) {
    const px = layout.ox + x * layout.cell;
    const py = layout.oy + y * layout.cell;
    const inset = layout.cell * 0.08;

    ctx.fillStyle = WALL_FILL;
    ctx.strokeStyle = WALL_EDGE;
    ctx.lineWidth = 1;
    roundRectPath(
      ctx,
      px + inset,
      py + inset,
      layout.cell - inset * 2,
      layout.cell - inset * 2,
      layout.cell * 0.16,
    );
    ctx.fill();
    ctx.stroke();
  }

  function drawTarget(ctx, layout, target) {
    const center = cellCenter(layout, target.x, target.y);
    const half = layout.cell * 0.33;
    const color = beamColor(target.require);

    ctx.fillStyle = target.lit ? withAlpha(color, 0.2) : "rgba(255, 255, 255, 0.035)";
    ctx.strokeStyle = target.lit ? color : withAlpha(color, 0.42);
    ctx.lineWidth = Math.max(1.5, layout.cell * 0.055);

    roundRectPath(
      ctx,
      center.x - half,
      center.y - half,
      half * 2,
      half * 2,
      layout.cell * 0.18,
    );
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(center.x, center.y, layout.cell * 0.13, 0, Math.PI * 2);
    ctx.fillStyle = target.lit ? color : withAlpha(color, 0.3);
    ctx.fill();
  }

  function strokeSegments(ctx, layout, segments) {
    ctx.beginPath();
    for (const segment of segments) {
      const from = cellCenter(layout, segment.from.x, segment.from.y);
      const to = cellCenter(layout, segment.to.x, segment.to.y);
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
    }
    ctx.stroke();
  }

  function drawBeams(ctx, layout, segments) {
    if (!segments || segments.length === 0) return;

    // 按颜色分组，减少状态切换
    const grouped = new Map();
    for (const segment of segments) {
      if (!grouped.has(segment.color)) grouped.set(segment.color, []);
      grouped.get(segment.color).push(segment);
    }

    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (const entry of grouped) {
      const hex = beamColor(entry[0]);

      ctx.strokeStyle = withAlpha(hex, 0.16);
      ctx.lineWidth = Math.max(4, layout.cell * 0.3);
      strokeSegments(ctx, layout, entry[1]);

      ctx.strokeStyle = hex;
      ctx.lineWidth = Math.max(1.5, layout.cell * 0.11);
      strokeSegments(ctx, layout, entry[1]);
    }
  }

  function slashPath(ctx, centerX, centerY, halfLength, orient) {
    ctx.beginPath();
    if (orient === core.ORIENT.SLASH) {
      ctx.moveTo(centerX - halfLength, centerY + halfLength);
      ctx.lineTo(centerX + halfLength, centerY - halfLength);
    } else {
      ctx.moveTo(centerX - halfLength, centerY - halfLength);
      ctx.lineTo(centerX + halfLength, centerY + halfLength);
    }
    ctx.stroke();
  }

  function drawEmitter(ctx, layout, x, y, cellData) {
    const center = cellCenter(layout, x, y);
    const color = beamColor(cellData.color);
    const radius = layout.cell * 0.5;

    const glow = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius);
    glow.addColorStop(0, withAlpha(color, 0.5));
    glow.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(center.x, center.y, layout.cell * 0.15, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // 朝向指示：从中心朝发光方向画一小段
    const direction = core.DIRECTIONS[cellData.dir];
    if (direction) {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(2, layout.cell * 0.07);
      ctx.beginPath();
      ctx.moveTo(center.x, center.y);
      ctx.lineTo(
        center.x + direction.dx * layout.cell * 0.38,
        center.y + direction.dy * layout.cell * 0.38,
      );
      ctx.stroke();
    }
  }

  function drawMirror(ctx, layout, center, orient) {
    ctx.strokeStyle = ELEMENT_LINE;
    ctx.lineWidth = Math.max(2, layout.cell * 0.075);
    slashPath(ctx, center.x, center.y, layout.cell * 0.3, orient);
  }

  function drawSplitter(ctx, layout, center, orient) {
    drawMirror(ctx, layout, center, orient);

    // 平行的淡线表示「半透」
    const offset = layout.cell * 0.1;
    const shifted = { x: center.x + offset, y: center.y + offset };
    ctx.strokeStyle = withAlpha(ELEMENT_LINE, 0.32);
    ctx.lineWidth = Math.max(1, layout.cell * 0.04);
    slashPath(ctx, shifted.x, shifted.y, layout.cell * 0.24, orient);
  }

  function drawDichroic(ctx, layout, center, orient, mask) {
    const color = beamColor(mask);

    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, layout.cell * 0.075);
    slashPath(ctx, center.x, center.y, layout.cell * 0.3, orient);

    ctx.beginPath();
    ctx.arc(center.x - layout.cell * 0.24, center.y + layout.cell * 0.24, layout.cell * 0.07, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  function drawHighlight(ctx, layout, position, kind) {
    if (!position) return;
    const px = layout.ox + position.x * layout.cell;
    const py = layout.oy + position.y * layout.cell;
    const inset = layout.cell * 0.06;

    ctx.strokeStyle = kind === "cursor" ? "rgba(255, 212, 121, 0.92)" : "rgba(255, 255, 255, 0.2)";
    ctx.lineWidth = kind === "cursor" ? 2 : 1.5;
    roundRectPath(
      ctx,
      px + inset,
      py + inset,
      layout.cell - inset * 2,
      layout.cell - inset * 2,
      layout.cell * 0.16,
    );
    ctx.stroke();
  }

  // ---------- 场景 ----------

  /**
   * 画一帧场景。
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} options
   * @param {number} options.width 设备像素宽
   * @param {number} options.height 设备像素高
   * @param {number} options.padding 画布内边距（设备像素）
   * @param {object} options.level 关卡定义
   * @param {object} options.result LightEngine.solve 的返回值
   * @param {{x:number,y:number}|null} [options.cursor] 键盘光标所在格
   * @param {{x:number,y:number}|null} [options.hover] 指针悬停格
   * @returns {object} 本次使用的布局，供交互层做命中判定
   */
  function drawScene(ctx, options) {
    const layout = computeLayout(
      options.width,
      options.height,
      options.level.cols,
      options.level.rows,
      options.padding,
    );

    ctx.clearRect(0, 0, options.width, options.height);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, options.width, options.height);

    drawBoard(ctx, layout);

    const grid = options.result.grid;
    for (let y = 0; y < grid.rows; y += 1) {
      for (let x = 0; x < grid.cols; x += 1) {
        const cellData = grid.cells[y * grid.cols + x];
        if (cellData && cellData.type === core.TILE.WALL) drawWall(ctx, layout, x, y);
      }
    }

    for (const target of options.result.targets) drawTarget(ctx, layout, target);

    drawBeams(ctx, layout, options.result.segments);

    for (let y = 0; y < grid.rows; y += 1) {
      for (let x = 0; x < grid.cols; x += 1) {
        const cellData = grid.cells[y * grid.cols + x];
        if (!cellData) continue;

        const center = cellCenter(layout, x, y);
        if (cellData.type === core.TILE.EMITTER) {
          drawEmitter(ctx, layout, x, y, cellData);
        } else if (cellData.type === core.TILE.MIRROR) {
          drawMirror(ctx, layout, center, cellData.orient);
        } else if (cellData.type === core.TILE.SPLITTER) {
          drawSplitter(ctx, layout, center, cellData.orient);
        } else if (core.isDichroic(cellData.type)) {
          drawDichroic(ctx, layout, center, cellData.orient, core.dichroicMask(cellData.type));
        }
      }
    }

    drawHighlight(ctx, layout, options.hover, "hover");
    drawHighlight(ctx, layout, options.cursor, "cursor");

    return layout;
  }

  return {
    BACKGROUND,
    BEAM_COLORS,
    beamColor,
    withAlpha,
    computeLayout,
    pointToCell,
    cellCenter,
    drawScene,
  };
});
