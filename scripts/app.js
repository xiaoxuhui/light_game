"use strict";

// 编排层：输入 → 引擎 → 渲染 → HUD。
//
// 职责边界 —— 只做协调，不写规则、不写绘制：
//   · 光怎么走由 LightEngine 决定，这里只把结果喂给渲染器
//   · 元件长什么样由 LightRenderer 决定，这里只负责告诉它画哪一关、光标在哪
//   · 渲染循环用脏标记驱动：没有状态变化就不重绘，静置时几乎不占 CPU
//
// 依赖顺序（见 index.html）：light-core → light-engine → levels → renderer → app

(function () {
  const canvas = document.getElementById("stage");
  if (!(canvas instanceof HTMLCanvasElement)) return;

  const context = canvas.getContext("2d");
  if (!context) return;

  const core = globalThis.LightCore;
  const engine = globalThis.LightEngine;
  const levels = globalThis.LightLevels;
  const renderer = globalThis.LightRenderer;
  if (!core || !engine || !levels || !renderer) return;

  const ERASER = "__eraser";

  const TYPE_NAMES = {
    mirror: "反射镜",
    splitter: "分光镜",
    dichroicR: "红镜",
    dichroicG: "绿镜",
    dichroicB: "蓝镜",
    [ERASER]: "橡皮",
  };

  const dom = {
    title: document.getElementById("level-title"),
    sub: document.getElementById("level-sub"),
    stars: document.getElementById("level-stars"),
    hint: document.getElementById("level-hint"),
    toolbar: document.getElementById("toolbar"),
    btnLevels: document.getElementById("btn-levels"),
    btnClear: document.getElementById("btn-clear"),
    status: document.getElementById("level-status"),
    btnNext: document.getElementById("btn-next"),
    overlay: document.getElementById("overlay"),
    sheetTitle: document.getElementById("sheet-title"),
    sheetBody: document.getElementById("sheet-body"),
    sheetActions: document.getElementById("sheet-actions"),
  };

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const state = {
    levelId: null,
    placement: [],
    selectedType: null,
    cursor: null,
    hover: null,
    result: null,
    layout: null,
    stars: {},
    dirty: true,
    running: false,
    frameId: 0,
    wasAllLit: false,
    dpr: 1,
  };

  const toolButtons = new Map();

  // ---------- 画布尺寸与 DPR ----------

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));

    state.dpr = dpr;

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      context.setTransform(1, 0, 0, 1, 0, 0);
    }
    markDirty();
  }

  // ---------- 关卡与求解 ----------

  function currentLevel() {
    return state.levelId ? levels.getLevel(state.levelId) : null;
  }

  function cellIndex(x, y) {
    const level = currentLevel();
    if (!level) return -1;
    return y * level.cols + x;
  }

  function cellOf(x, y) {
    if (!state.result) return null;
    return state.result.grid.cells[cellIndex(x, y)] || null;
  }

  function findPlacement(x, y) {
    for (const item of state.placement) {
      if (item.x === x && item.y === y) return item;
    }
    return null;
  }

  function usedCount(type) {
    let count = 0;
    for (const item of state.placement) {
      if (item.type === type) count += 1;
    }
    return count;
  }

  function quotaLeft(type) {
    const level = currentLevel();
    if (!level) return 0;
    return (level.inventory[type] || 0) - usedCount(type);
  }

  function recompute() {
    const level = currentLevel();
    if (!level) return;
    state.result = engine.solve(level, state.placement);
  }

  function commit() {
    recompute();
    updateHud();
    markDirty();
    checkCompletion(false);
  }

  // ---------- 渲染 ----------

  function markDirty() {
    state.dirty = true;
  }

  function paint() {
    const level = currentLevel();
    if (!level || !state.result) return;
    if (canvas.width <= 1 || canvas.height <= 1) return;

    state.layout = renderer.drawScene(context, {
      width: canvas.width,
      height: canvas.height,
      padding: Math.round(14 * state.dpr),
      level,
      result: state.result,
      cursor: state.cursor,
      hover: state.hover,
    });
  }

  function frame() {
    state.frameId = requestAnimationFrame(frame);
    if (!state.dirty) return;
    state.dirty = false;
    paint();
  }

  function start() {
    if (state.running) return;
    state.running = true;
    state.frameId = requestAnimationFrame(frame);
  }

  function stop() {
    if (!state.running) return;
    state.running = false;
    cancelAnimationFrame(state.frameId);
  }

  // ---------- 操作 ----------

  function handleCell(x, y) {
    const level = currentLevel();
    if (!level) return;

    const existing = findPlacement(x, y);

    if (state.selectedType === ERASER) {
      if (existing) removeAt(x, y);
      return;
    }

    if (existing) {
      rotateAt(x, y);
      return;
    }

    if (!state.selectedType) return;
    if (cellOf(x, y)) return; // 关卡预设元件不可覆盖
    if (quotaLeft(state.selectedType) <= 0) return;

    state.placement.push({
      type: state.selectedType,
      x,
      y,
      orient: core.ORIENT.SLASH,
    });
    commit();
  }

  function rotateAt(x, y) {
    const item = findPlacement(x, y);
    if (!item || !core.isRotatable(item.type)) return;
    item.orient = core.toggleOrient(item.orient);
    commit();
  }

  function removeAt(x, y) {
    const index = state.placement.findIndex((item) => item.x === x && item.y === y);
    if (index === -1) return;
    state.placement.splice(index, 1);
    commit();
  }

  function clearBoard() {
    if (state.placement.length === 0) return;
    state.placement = [];
    commit();
  }

  // ---------- 通关 ----------

  function starText(stars) {
    let text = "";
    for (let i = 0; i < 3; i += 1) text += i < stars ? "★" : "☆";
    return text;
  }

  /**
   * @param {boolean} silent 进入关卡时的首次判定不弹结算，只记录成绩
   */
  function checkCompletion(silent) {
    const level = currentLevel();
    if (!level || !state.result) return;

    const lit = state.result.allLit;
    if (lit && !state.wasAllLit) {
      const stars = engine.starsFor(true, state.result.placedCount, level.par);
      const previous = state.stars[level.id] || 0;
      if (stars > previous) state.stars[level.id] = stars;
      updateHud();
      if (!silent) showResult(stars, level);
    }
    state.wasAllLit = lit;
  }

  // ---------- HUD ----------

  function updateHud() {
    const level = currentLevel();
    if (!level) return;

    dom.title.textContent = level.title;

    const chapters = levels.listChapters();
    let chapterName = "教学";
    for (const chapter of chapters) {
      if (chapter.levelIds.indexOf(level.id) !== -1) chapterName = chapter.title;
    }
    dom.sub.textContent = "第 " + level.chapter + " 章 · " + chapterName;

    const best = state.stars[level.id] || 0;
    const cleared = best > 0;
    const nextId = levels.nextLevelId(level.id);

    dom.stars.textContent = cleared ? starText(best) : "";
    dom.stars.setAttribute("aria-label", cleared ? "已获得 " + best + " 星" : "尚未通关");

    // 「下一关」是常驻入口：通关结算浮层被关掉之后，玩家仍然有路可走
    dom.btnNext.hidden = !nextId;
    dom.btnNext.disabled = !cleared;

    dom.hint.textContent = level.hint;
    dom.btnClear.disabled = state.placement.length === 0;

    // 静默通关（进入关卡时目标就已被满足）不会有结算浮层，靠这一行给出反馈
    dom.status.hidden = !cleared;
    if (cleared) {
      dom.status.textContent = nextId
        ? "已通关 " + starText(best) + " · 点右上角「下一关」继续"
        : "已通关 " + starText(best) + " · 你已完成全部关卡";
    }

    updateToolbar();
  }

  function updateToolbar() {
    for (const entry of toolButtons) {
      const type = entry[0];
      const button = entry[1];
      const count = button.querySelector(".tool__count");

      if (type === ERASER) {
        button.setAttribute("aria-pressed", String(state.selectedType === ERASER));
        button.disabled = state.placement.length === 0;
        continue;
      }

      const left = quotaLeft(type);
      count.textContent = "×" + left;
      button.setAttribute("aria-pressed", String(state.selectedType === type));
      button.disabled = left <= 0;
    }
  }

  function buildToolbar(level) {
    dom.toolbar.innerHTML = "";
    toolButtons.clear();

    const types = core.PLACEABLE_TYPES.filter((type) => (level.inventory[type] || 0) > 0);
    // 一个元件都不发的关卡（如教学第 1 关）不摆橡皮，免得只剩一个永远禁用的按钮让人困惑
    if (types.length === 0) return;
    types.push(ERASER);

    for (const type of types) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tool";
      button.dataset.type = type === ERASER ? "eraser" : type;
      button.setAttribute("aria-pressed", "false");
      button.title = TYPE_NAMES[type] || type;

      const glyph = document.createElement("span");
      glyph.className = type === ERASER ? "tool__glyph tool__glyph--eraser" : "tool__glyph";
      button.appendChild(glyph);

      const name = document.createElement("span");
      name.textContent = TYPE_NAMES[type] || type;
      button.appendChild(name);

      if (type === ERASER) {
        glyph.textContent = "×";
      } else {
        const count = document.createElement("span");
        count.className = "tool__count";
        count.textContent = "×0";
        button.appendChild(count);
      }

      button.addEventListener("click", () => {
        state.selectedType = state.selectedType === type ? null : type;
        updateToolbar();
      });

      dom.toolbar.appendChild(button);
      toolButtons.set(type, button);
    }
  }

  // ---------- 浮层 ----------

  function showOverlay() {
    dom.overlay.hidden = false;
    const first = dom.sheetActions.querySelector("button");
    if (first) first.focus();
  }

  function hideOverlay() {
    dom.overlay.hidden = true;
  }

  function addAction(label, handler, primary) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = primary ? "btn btn--primary" : "btn";
    button.textContent = label;
    button.addEventListener("click", handler);
    dom.sheetActions.appendChild(button);
    return button;
  }

  function showResult(stars, level) {
    const nextId = levels.nextLevelId(level.id);

    dom.sheetTitle.textContent = "通关";
    dom.sheetBody.innerHTML = "";
    dom.sheetActions.innerHTML = "";

    const starsLine = document.createElement("p");
    starsLine.className = "sheet__stars";
    starsLine.textContent = starText(stars);
    dom.sheetBody.appendChild(starsLine);

    const summary = document.createElement("p");
    summary.className = "sheet__summary";
    summary.textContent =
      "用了 " + state.result.placedCount + " 个元件（三星需要 ≤ " + level.par + " 个）";
    dom.sheetBody.appendChild(summary);

    if (nextId) {
      addAction("下一关", () => {
        hideOverlay();
        selectLevel(nextId);
      }, true);
    }
    addAction("重玩本关", () => {
      hideOverlay();
      state.placement = [];
      state.wasAllLit = false;
      commit();
    });
    addAction("关卡列表", showLevelList);

    showOverlay();
  }

  function isUnlocked(id) {
    const index = levels.indexOfLevel(id);
    if (index <= 0) return true;
    const previous = levels.LEVELS[index - 1];
    return (state.stars[previous.id] || 0) > 0;
  }

  function showLevelList() {
    dom.sheetTitle.textContent = "选择关卡";
    dom.sheetBody.innerHTML = "";
    dom.sheetActions.innerHTML = "";

    const list = document.createElement("div");
    list.className = "level-list";

    for (const chapter of levels.listChapters()) {
      const heading = document.createElement("p");
      heading.className = "sheet__chapter";
      heading.textContent = "第 " + chapter.id + " 章 · " + chapter.title;
      list.appendChild(heading);

      for (const id of chapter.levelIds) {
        const level = levels.getLevel(id);
        const unlocked = isUnlocked(id);

        const item = document.createElement("button");
        item.type = "button";
        item.className = "level-item";
        item.disabled = !unlocked;

        const label = document.createElement("span");
        label.textContent = unlocked ? level.title : "未解锁";
        item.appendChild(label);

        const stars = document.createElement("span");
        stars.className = "level-item__stars";
        stars.textContent = unlocked ? starText(state.stars[id] || 0) : "";
        item.appendChild(stars);

        item.addEventListener("click", () => {
          hideOverlay();
          selectLevel(id);
        });

        list.appendChild(item);
      }
    }

    dom.sheetBody.appendChild(list);
    addAction("继续游戏", hideOverlay, true);
    showOverlay();
  }

  // ---------- 关卡切换 ----------

  function selectLevel(id) {
    const level = levels.getLevel(id);
    if (!level) return;

    state.levelId = id;
    state.placement = [];
    state.selectedType = null;
    state.cursor = null;
    state.hover = null;
    state.wasAllLit = false;

    buildToolbar(level);
    recompute();
    updateHud();
    markDirty();

    // 进入关卡时静默判定一次：教学第 1 关不放元件就已通关，不该立刻弹结算
    checkCompletion(true);
  }

  // ---------- 输入 ----------

  function toCanvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * state.dpr,
      y: (event.clientY - rect.top) * state.dpr,
    };
  }

  function cellFromEvent(event) {
    if (!state.layout) return null;
    const point = toCanvasPoint(event);
    return renderer.pointToCell(state.layout, point.x, point.y);
  }

  canvas.addEventListener("pointerdown", (event) => {
    const cell = cellFromEvent(event);
    if (!cell) return;
    event.preventDefault();

    if (event.button === 2) {
      removeAt(cell.x, cell.y);
      state.cursor = cell;
      markDirty();
      return;
    }

    state.cursor = cell;
    handleCell(cell.x, cell.y);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return;
    const cell = cellFromEvent(event);
    const changed =
      (cell === null) !== (state.hover === null) ||
      (cell && state.hover && (cell.x !== state.hover.x || cell.y !== state.hover.y)) ||
      (cell && !state.hover);

    if (changed) {
      state.hover = cell;
      markDirty();
    }
  });

  canvas.addEventListener("pointerleave", () => {
    if (state.hover) {
      state.hover = null;
      markDirty();
    }
  });

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  function moveCursor(dx, dy) {
    const level = currentLevel();
    if (!level) return;

    const start = state.cursor || { x: 0, y: 0 };
    const x = Math.max(0, Math.min(level.cols - 1, start.x + dx));
    const y = Math.max(0, Math.min(level.rows - 1, start.y + dy));
    state.cursor = { x, y };
    markDirty();
  }

  function selectByIndex(index) {
    const level = currentLevel();
    if (!level) return;
    const available = core.PLACEABLE_TYPES.filter((type) => (level.inventory[type] || 0) > 0);
    const type = available[index];
    if (!type) return;
    state.selectedType = state.selectedType === type ? null : type;
    updateToolbar();
  }

  document.addEventListener("keydown", (event) => {
    const level = currentLevel();
    if (!level) return;

    if (event.key === "Escape") {
      event.preventDefault();
      if (!dom.overlay.hidden) hideOverlay();
      else if (state.selectedType) {
        state.selectedType = null;
        updateToolbar();
      } else showLevelList();
      return;
    }

    if (!dom.overlay.hidden) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const cursor = state.cursor;

    switch (event.key) {
      case "ArrowUp":
        event.preventDefault();
        moveCursor(0, -1);
        return;
      case "ArrowDown":
        event.preventDefault();
        moveCursor(0, 1);
        return;
      case "ArrowLeft":
        event.preventDefault();
        moveCursor(-1, 0);
        return;
      case "ArrowRight":
        event.preventDefault();
        moveCursor(1, 0);
        return;
      case "Enter":
      case " ":
        if (cursor) {
          event.preventDefault();
          handleCell(cursor.x, cursor.y);
        }
        return;
      case "r":
      case "R":
        if (cursor) {
          event.preventDefault();
          rotateAt(cursor.x, cursor.y);
        }
        return;
      case "Delete":
      case "Backspace":
        if (cursor) {
          event.preventDefault();
          removeAt(cursor.x, cursor.y);
        }
        return;
      case "e":
      case "E":
        event.preventDefault();
        state.selectedType = state.selectedType === ERASER ? null : ERASER;
        updateToolbar();
        return;
      default:
        break;
    }

    const digit = Number.parseInt(event.key, 10);
    if (Number.isInteger(digit) && digit >= 1 && digit <= 5) {
      event.preventDefault();
      selectByIndex(digit - 1);
    }
  });

  // ---------- 装配 ----------

  dom.btnLevels.addEventListener("click", showLevelList);
  dom.btnClear.addEventListener("click", clearBoard);
  dom.btnNext.addEventListener("click", () => {
    const nextId = levels.nextLevelId(state.levelId);
    if (nextId) selectLevel(nextId);
  });

  dom.overlay.addEventListener("click", (event) => {
    if (event.target === dom.overlay) hideOverlay();
  });

  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(canvas);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else {
      markDirty();
      start();
    }
  });

  reducedMotion.addEventListener("change", markDirty);

  resize();
  selectLevel(levels.LEVELS[0].id);
  start();

  globalThis.__lightGame = {
    state,
    start,
    stop,
    resize,
    selectLevel,
    handleCell,
    rotateAt,
    removeAt,
    clearBoard,
    showLevelList,
    starText,
  };
})();
