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
    if (!layout.infinite && (x < 0 || y < 0 || x >= layout.cols || y >= layout.rows)) return null;
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return null;
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
    if (layout.infinite) {
      ctx.fillStyle = BOARD_FILL;
      ctx.fillRect(0, 0, layout.width, layout.height);
      ctx.strokeStyle = GRID_LINE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = layout.ox % layout.cell; x < layout.width; x += layout.cell) {
        ctx.moveTo(x, 0); ctx.lineTo(x, layout.height);
      }
      for (let y = layout.oy % layout.cell; y < layout.height; y += layout.cell) {
        ctx.moveTo(0, y); ctx.lineTo(layout.width, y);
      }
      ctx.stroke();
      return;
    }
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

    if (target.bulb) {
      if (target.lit) {
        const glow = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, layout.cell * 0.6);
        glow.addColorStop(0, withAlpha(color, 0.45));
        glow.addColorStop(1, withAlpha(color, 0));
        ctx.fillStyle = glow;
        ctx.fillRect(center.x - layout.cell, center.y - layout.cell, layout.cell * 2, layout.cell * 2);
      }
      ctx.beginPath();
      ctx.arc(center.x, center.y - layout.cell * 0.06, layout.cell * 0.25, 0, Math.PI * 2);
      ctx.fillStyle = target.lit ? withAlpha(color, 0.65) : "#202632";
      ctx.strokeStyle = target.lit ? color : "#8b93a1";
      ctx.lineWidth = Math.max(1.5, layout.cell * 0.045);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = target.lit ? color : "#8b93a1";
      ctx.fillRect(center.x - layout.cell * 0.12, center.y + layout.cell * 0.19, layout.cell * 0.24, layout.cell * 0.12);
      return;
    }

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
    ctx.save();
    if (cellData.powered === false) ctx.globalAlpha = 0.25;
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
    const directions = cellData.omni ? [0, 2, 4, 6] : [cellData.dir];
    for (const dir of directions) {
      const direction = core.DIRECTIONS[dir];
      if (!direction) continue;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(2, layout.cell * 0.07);
      ctx.beginPath();
      ctx.moveTo(center.x, center.y);
      ctx.lineTo(
        center.x + direction.dx * layout.cell * 0.38,
        center.y + direction.dy * layout.cell * 0.38,
      );
      ctx.stroke();
      if (!cellData.omni) drawArrow(ctx, layout, center, cellData.dir, color);
    }
    ctx.restore();
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

  /**
   * 棱镜：三角形本体 + 三颗色点。
   * 色点摆在该颜色**真正出射**的方向上（三色按朝向左转 / 直行 / 右转），
   * 因此需要入射方向；没有光照到它时按「光从左来」画，形状规则一致、不影响判读。
   * 入射光里缺哪个分量，对应的色点就画暗一些 —— 既能看到完整的朝向映射，
   * 又不会让人误以为那束光真的存在（黄光里没有蓝，蓝点就该是暗的）。
   * @param {{dir:number, color:number}|null} incoming 进入本格的光（方向索引 + 颜色掩码）
   */
  function drawPrism(ctx, layout, center, orient, incoming, facing) {
    const half = layout.cell * 0.22;
    const entry = facing === undefined
      ? incoming && incoming.dir >= 0 ? incoming.dir : core.DIRECTION_INDEX_BY_NAME.right
      : (2 + core.normalizeOrient("directionalEmitter", facing) * 2) % 8;

    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.rotate((entry - 2) * Math.PI / 4);
    ctx.beginPath();
    ctx.moveTo(-half, -half);
    ctx.lineTo(half, 0);
    ctx.lineTo(-half, half);
    ctx.closePath();
    ctx.fillStyle = "rgba(228,234,244,0.08)";
    ctx.fill();
    ctx.strokeStyle = ELEMENT_LINE;
    ctx.lineWidth = Math.max(1.5, layout.cell * 0.06);
    ctx.stroke();
    // 高亮输入面；整个三角形及输入箭头随四向旋转。
    ctx.strokeStyle = "#ffd479";
    ctx.beginPath(); ctx.moveTo(-half, -half); ctx.lineTo(-half, half); ctx.stroke();
    ctx.restore();

    const input = core.DIRECTIONS[entry];
    drawArrow(ctx, { cell: layout.cell * 0.45 }, {
      x: center.x - input.dx * layout.cell * 0.32,
      y: center.y - input.dy * layout.cell * 0.32,
    }, entry, "#fff2cf");
    const incomingColor = incoming ? incoming.dir === entry ? incoming.color : 0 : null;
    const slots = core.prismSlots(orient);
    const distance = layout.cell * 0.38;
    const radius = Math.max(1.5, layout.cell * 0.095);

    for (let slot = 0; slot < slots.length; slot += 1) {
      const direction = core.DIRECTIONS[core.prismOutDirection(entry, slot)];
      if (!direction) continue;

      // 没有入射光时按「完整预览」画（偏亮），有入射光时缺席的颜色画暗
      let alpha = 0.78;
      if (incomingColor !== null) alpha = (incomingColor & slots[slot]) !== 0 ? 1 : 0.24;

      ctx.beginPath();
      ctx.arc(
        center.x + direction.dx * distance,
        center.y + direction.dy * distance,
        radius,
        0,
        Math.PI * 2,
      );
      ctx.fillStyle = withAlpha(beamColor(slots[slot]), alpha);
      ctx.fill();
    }
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

  function drawArrow(ctx, layout, center, dir, color) {
    const vector = core.DIRECTIONS[dir];
    if (!vector) return;
    const s = layout.cell * 0.3;
    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.rotate(Math.atan2(vector.dy, vector.dx));
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, layout.cell * 0.06);
    ctx.beginPath(); ctx.moveTo(-s, 0); ctx.lineTo(s, 0);
    ctx.moveTo(s * 0.4, -s * 0.5); ctx.lineTo(s, 0); ctx.lineTo(s * 0.4, s * 0.5);
    ctx.stroke(); ctx.restore();
  }

  function drawChip(ctx, layout, center, cell, chips) {
    const chip = (chips || []).find((item) => item.id === cell.chipId);
    if (chip?.appearance) {
      const appearance = chip.appearance, anchor = core.appearanceAnchor(appearance), heading = core.appearanceArrowCell(appearance);
      ctx.save(); ctx.translate(center.x, center.y); ctx.rotate(cell.orient * Math.PI / 2);
      for (const point of core.appearancePoints(appearance)) {
        const cx = (point.x - anchor.x) * layout.cell, cy = (point.y - anchor.y) * layout.cell;
        const style = appearance.cells.find((entry) => entry.x === point.x && entry.y === point.y);
        const half = layout.cell * 0.47;
        ctx.fillStyle = style?.color || "#20373c"; ctx.strokeStyle = "#6bddd2"; ctx.lineWidth = Math.max(1, layout.cell * 0.035);
        roundRectPath(ctx, cx - half, cy - half, half * 2, half * 2, layout.cell * 0.05); ctx.fill(); ctx.stroke();
        if (heading.x === point.x && heading.y === point.y) {
          drawArrow(ctx, { cell: layout.cell * (style?.text ? 0.35 : 0.7) },
            { x: cx, y: cy - (style?.text ? layout.cell * 0.25 : 0) }, 0, "#54e58b");
        }
        if (style?.text) {
          ctx.fillStyle = "#d4fffa"; ctx.font = Math.max(8, layout.cell * 0.25) + "px sans-serif";
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(style.text, cx, cy + (heading.x === point.x && heading.y === point.y ? layout.cell * 0.16 : 0), layout.cell * 0.85);
        }
      }
      if (appearance.showName) {
        ctx.fillStyle = "#d4fffa"; ctx.font = Math.max(7, layout.cell * 0.18) + "px sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(chip.name, 0, layout.cell * 0.32, layout.cell * 0.85);
      }
      ctx.restore(); return;
    }
    const s = layout.cell * 0.35;
    ctx.save(); ctx.translate(center.x, center.y); ctx.rotate(cell.orient * Math.PI / 2);
    ctx.fillStyle = "#20373c"; ctx.strokeStyle = "#6bddd2"; ctx.lineWidth = 2;
    roundRectPath(ctx, -s, -s, s * 2, s * 2, layout.cell * 0.06); ctx.fill(); ctx.stroke();
    // 唯一的绿色箭头标记芯片朝向，默认向上；名字与建筑一起旋转。
    drawArrow(ctx, { cell: layout.cell * 0.35 }, { x: 0, y: -s * 0.53 }, 0, "#54e58b");
    ctx.font = Math.max(8, layout.cell * 0.2) + "px sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#d4fffa";
    ctx.fillText(chip ? chip.name : "芯片", 0, s * 0.35, layout.cell * 0.62);
    ctx.restore();
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
    const camera = options.camera;
    const layout = camera ? {
      infinite: true, width: options.width, height: options.height,
      cell: camera.cell * options.dpr,
      ox: options.width / 2 - camera.x * camera.cell * options.dpr,
      oy: options.height / 2 - camera.y * camera.cell * options.dpr,
    } : computeLayout(
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
    if (options.shapeEditor) {
      const chip = options.shapeEditor, anchor = core.appearanceAnchor(chip.appearance);
      drawChip(ctx, layout, cellCenter(layout, anchor.x, anchor.y),
        { x: anchor.x, y: anchor.y, orient: 0, chipId: chip.id }, [chip]);
    }
    if (options.compositeEditor) {
      const chip = options.compositeEditor, anchor = core.appearanceAnchor(chip.appearance);
      drawChip(ctx, layout, cellCenter(layout, anchor.x, anchor.y),
        { x: anchor.x, y: anchor.y, orient: 0, chipId: chip.id }, [chip]);
    }
    const grid = options.result.grid;
    const cells = grid.infinite ? grid.cells : grid.cells.flatMap((cell, i) => cell
      ? [{ ...cell, x: i % grid.cols, y: Math.floor(i / grid.cols) }] : []);
    const pointVisible = (cell) => !camera || (
      layout.ox + (cell.x + 1) * layout.cell >= 0 && layout.ox + cell.x * layout.cell <= options.width &&
      layout.oy + (cell.y + 1) * layout.cell >= 0 && layout.oy + cell.y * layout.cell <= options.height);
    const visible = (cell) => cell.type === "chip" && cell.footprint ? cell.footprint.some(pointVisible) : pointVisible(cell);
    for (const cell of cells) {
      if (cell.type === core.TILE.WALL && visible(cell)) drawWall(ctx, layout, cell.x, cell.y);
    }

    for (const target of options.result.targets) if (visible(target)) drawTarget(ctx, layout, target);

    drawBeams(ctx, layout, options.result.segments);

    // 棱镜要按「光从哪边来、带什么颜色」摆色点，先扫一遍光段记住每格的入射光
    const incomingByCell = new Map();
    for (const segment of options.result.segments) {
      const key = segment.to.x + "," + segment.to.y;
      const incoming = {
        dir: core.directionIndexFromVector(Math.sign(segment.to.x - segment.from.x), Math.sign(segment.to.y - segment.from.y)),
        color: segment.color,
      };
      if (!incomingByCell.has(key)) incomingByCell.set(key, incoming);
      const dirKey = key + ":" + incoming.dir;
      incomingByCell.set(dirKey, { ...incoming, color: incoming.color | (incomingByCell.get(dirKey)?.color || 0) });
    }

    for (const cellData of cells) {
        if (cellData.type === "chipPart") continue;
        if (!visible(cellData)) continue;
        const { x, y } = cellData;

        const center = cellCenter(layout, x, y);

        // 逐个元件兜底：drawScene 是顺序绘制，任何一处未捕获异常都会让排在后面的
        // 元件一个都画不出来 —— 症状是「除了网格和光，场上元件全没了」，
        // 而真正出错的往往只是一个格子。玩家曾经就是这么遇到「放下棱镜后其他元件消失」的。
        //
        // 这里继续画剩余元件，但不静默吞掉错误：记到控制台后，
        // app.smoke.spec.js 的「运行期间控制台无报错」会把它变成红灯。
        try {
          if (cellData.type === core.TILE.EMITTER) {
            drawEmitter(ctx, layout, x, y, cellData);
          } else if (cellData.type === core.TILE.MIRROR) {
            drawMirror(ctx, layout, center, cellData.orient);
          } else if (cellData.type === core.TILE.SPLITTER) {
            drawSplitter(ctx, layout, center, cellData.orient);
          } else if (cellData.type === core.TILE.PRISM) {
            const key = x + "," + y;
            const entry = (2 + (cellData.facing || 0) * 2) % 8;
            drawPrism(ctx, layout, center, cellData.orient,
              incomingByCell.get(key + ":" + entry) || incomingByCell.get(key), cellData.facing);
          } else if (cellData.type === "coldMirror" || cellData.type === "hotMirror") {
            ctx.strokeStyle = cellData.type === "hotMirror" ? "#ff896d" : "#77d4ff";
            ctx.lineWidth = Math.max(2, layout.cell * 0.12);
            const half = layout.cell * 0.34;
            const enabled = cellData.open === undefined ? cellData.type === "coldMirror" : cellData.open;
            const gap = enabled ? layout.cell * 0.11 : 0;
            const travelAxis = core.thermalAxis(cellData.type, cellData.orient);
            const axis = { dx: -travelAxis.dy, dy: travelAxis.dx };
            ctx.beginPath();
            ctx.moveTo(center.x - axis.dx * half, center.y - axis.dy * half);
            ctx.lineTo(center.x - axis.dx * gap, center.y - axis.dy * gap);
            ctx.moveTo(center.x + axis.dx * gap, center.y + axis.dy * gap);
            ctx.lineTo(center.x + axis.dx * half, center.y + axis.dy * half);
            ctx.stroke();
            if (cellData.type === "coldMirror") {
              // 非门就在本格内，位置随通光轴旋转；控制光不接入通光路径。
              ctx.fillStyle = cellData.receiving ? "#ffe3a3" : "#77d4ff";
              ctx.font = Math.max(8, layout.cell * 0.25) + "px sans-serif";
              ctx.textAlign = "center"; ctx.textBaseline = "middle";
              ctx.fillText("¬", center.x - axis.dx * half * 1.25, center.y - axis.dy * half * 1.25);
            }
            if (cellData.temperature !== undefined) {
              ctx.fillStyle = "#343b48";
              ctx.fillRect(center.x - half, center.y + layout.cell * 0.37, half * 2, Math.max(2, layout.cell * 0.06));
              ctx.fillStyle = "#ffac68";
              ctx.fillRect(center.x - half, center.y + layout.cell * 0.37, half * 2 * cellData.temperature, Math.max(2, layout.cell * 0.06));
            }
          } else if (core.CHIP_PORT_TYPES.includes(cellData.type)) {
            drawArrow(ctx, layout, center, cellData.orient * 2,
              cellData.inputColor || cellData.outputColor ? "#baffd2" : "#54e58b");
          } else if (cellData.type === "chip") {
            drawChip(ctx, layout, center, cellData, options.chips);
          }
          if (cellData.waiting) {
            ctx.fillStyle = "#ffd479";
            ctx.beginPath(); ctx.arc(center.x + layout.cell * 0.32, center.y - layout.cell * 0.32,
              Math.max(2, layout.cell * 0.06), 0, Math.PI * 2); ctx.fill();
          }
        } catch (error) {
          console.error(`绘制元件失败，已跳过该元件：${cellData.type} @ (${x}, ${y})`, error);
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
