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
  const storage = globalThis.LightStorage;
  const simulationApi = globalThis.LightSimulation;
  if (!core || !engine || !levels || !renderer || !storage || !simulationApi) return;
  const simulation = simulationApi.createSimulation();

  /** 存档仓库。localStorage 不可用时自动降级为内存存档，游戏照常可玩。 */
  const store = storage.createStore();

  const ERASER = "__eraser";
  const PAN = "__pan";

  /** 撤销栈上限。每个快照只是布局数组的浅拷贝，100 步既够用又不会无限吃内存。 */
  const MAX_HISTORY = 100;

  /** 「清空」的二次确认窗口：这段时间内不再点，就当作误触自动复位 */
  const CLEAR_CONFIRM_MS = 3000;

  const TYPE_NAMES = {
    mirror: "反射镜",
    splitter: "分光镜",
    prism: "棱镜",
    wall: "墙壁",
    emitter: "四面光源",
    bulb: "输出灯泡",
    coldMirror: "冷镜",
    hotMirror: "热镜",
    directionalEmitter: "单向光源",
    chip: "芯片",
    io: "IO 口",
    inputPort: "IO口",
    outputPort: "IO口",
    [ERASER]: "橡皮",
  };

  const dom = {
    title: document.getElementById("level-title"),
    sub: document.getElementById("level-sub"),
    stars: document.getElementById("level-stars"),
    hint: document.getElementById("level-hint"),
    toolbar: document.getElementById("toolbar"),
    btnLevels: document.getElementById("btn-levels"),
    btnMode: document.getElementById("btn-mode"),
    btnChallenge: document.getElementById("btn-challenge"),
    modeHint: document.getElementById("mode-hint"),
    btnCopyLevel: document.getElementById("btn-copy-level"),
    btnApplyLevel: document.getElementById("btn-apply-level"),
    viewControls: document.getElementById("view-controls"),
    btnPan: document.getElementById("btn-pan"),
    btnZoomIn: document.getElementById("btn-zoom-in"),
    btnZoomOut: document.getElementById("btn-zoom-out"),
    btnHome: document.getElementById("btn-home"),
    btnChips: document.getElementById("btn-chips"),
    chipEditor: document.getElementById("chip-editor"),
    chipName: document.getElementById("chip-name"),
    btnChipDone: document.getElementById("btn-chip-done"),
    btnAppearance: document.getElementById("btn-appearance"),
    btnCellAppearance: document.getElementById("btn-cell-appearance"),
    chipEditorHint: document.getElementById("chip-editor-hint"),
    chipShapeEditor: document.getElementById("chip-shape-editor"),
    chipShapeName: document.getElementById("chip-shape-name"),
    btnShapeNext: document.getElementById("btn-shape-next"),
    btnShapeCancel: document.getElementById("btn-shape-cancel"),
    btnShapeClear: document.getElementById("btn-shape-clear"),
    btnRun: document.getElementById("btn-run"),
    btnStep: document.getElementById("btn-step"),
    btnReset: document.getElementById("btn-reset"),
    stepSeconds: document.getElementById("step-seconds"),
    simulationStatus: document.getElementById("simulation-status"),
    chipInspection: document.getElementById("chip-inspection"),
    chipInspectionName: document.getElementById("chip-inspection-name"),
    btnInspectionBack: document.getElementById("btn-inspection-back"),
    btnClear: document.getElementById("btn-clear"),
    btnPrismColors: document.getElementById("btn-prism-colors"),
    btnUndo: document.getElementById("btn-undo"),
    btnRedo: document.getElementById("btn-redo"),
    btnSnapshots: document.getElementById("btn-snapshots"),
    btnExport: document.getElementById("btn-export"),
    btnImport: document.getElementById("btn-import"),
    fileImport: document.getElementById("file-import"),
    status: document.getElementById("level-status"),
    btnNext: document.getElementById("btn-next"),
    overlay: document.getElementById("overlay"),
    sheetTitle: document.getElementById("sheet-title"),
    sheetBody: document.getElementById("sheet-body"),
    sheetActions: document.getElementById("sheet-actions"),
  };

  // prefers-reduced-motion 关闭按钮过渡；离散组件时钟属于玩法，用空格暂停。
  // 两拍之间仍用脏标记绘制，不增加逐帧的光线移动动画。

  const state = {
    levelId: null,
    mode: "level",
    freeLevel: null,
    camera: null,
    chipDraft: null,
    shapeDraft: null,
    cellDraft: null,
    parentWorkspace: null,
    selectedChipId: null,
    inspection: null,
    paused: false,
    lastStep: 0,
    stepMs: simulationApi.STEP_MS,
    simulationPending: false,
    silentInitialization: true,
    placement: [],
    selectedType: null,
    cursor: null,
    hover: null,
    result: null,
    layout: null,
    stars: {},
    history: [],
    historyIndex: -1,
    dirty: true,
    running: false,
    frameId: 0,
    wasAllLit: false,
    dpr: 1,
  };

  const toolButtons = new Map();
  let chipDeleteUndo = null;

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
    if (state.mode === "free") recompute();
    markDirty();
  }

  // ---------- 关卡与求解 ----------

  function currentLevel() {
    if (state.mode === "free") return state.freeLevel;
    return state.levelId ? levels.getLevel(state.levelId) : null;
  }

  function cellOf(x, y) {
    if (!state.result) return null;
    return engine.cellAt(state.result.grid, x, y);
  }

  function findPlacement(x, y) {
    const part = state.result?.grid.infinite && state.result.grid.byPosition.get(x + "," + y);
    if (part?.type === "chipPart") {
      const owner = state.result.grid.byPosition.get(part.chipAnchor);
      x = owner.x; y = owner.y;
    }
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

  function availableTypes(level) {
    if (state.shapeDraft) return [];
    if (state.chipDraft?.appearance && !state.cellDraft) return [];
    const types = state.chipDraft ? [...core.FREE_PLACEABLE_TYPES, "inputPort"]
      : state.mode === "free" ? core.FREE_PLACEABLE_TYPES : core.PLACEABLE_TYPES;
    return types.filter((type) => (level.inventory[type] || 0) > 0);
  }

  function quotaLeft(type) {
    const level = currentLevel();
    if (!level) return 0;
    return (level.inventory[type] || 0) - usedCount(type);
  }

  function recompute() {
    const level = currentLevel();
    if (!level) return;
    const camera = state.camera;
    const halfW = camera ? canvas.width / state.dpr / camera.cell / 2 : 0;
    const halfH = camera ? canvas.height / state.dpr / camera.cell / 2 : 0;
    const view = camera ? {
      minX: camera.x - halfW, maxX: camera.x + halfW,
      minY: camera.y - halfH, maxY: camera.y + halfH,
    } : undefined;
    if (state.shapeDraft) {
      state.result = engine.solve({ ...level, infinite: true }, [], { view });
      state.simulationPending = false;
      return;
    }
    if (state.inspection) {
      const root = state.inspection.root;
      const rootResult = simulation.solve({ ...root.level, chips: store.data.chips || [] }, root.placement,
        { inspection: { path: state.inspection.path, view } });
      const parentResult = state.inspection.parentPath === "root" ? rootResult : simulation.getView(state.inspection.parentPath);
      state.inspection.signals = parentResult?.grid.cells.find((cell) => cell.type === "chip" &&
        cell.x === state.inspection.cell.x && cell.y === state.inspection.cell.y);
      state.result = simulation.getView(state.inspection.path);
    } else state.result = simulation.solve({ ...level, chips: store.data.chips || [] }, state.placement, { view });
    state.simulationPending = simulation.pending;
  }

  /** 一次会写进撤销栈的改动：先记历史，再重算，最后落盘 */
  function commit() {
    state.silentInitialization = false;
    pushHistory();
    refresh(false);
    rememberBoard();
  }

  /** 重算 + 刷 HUD + 重绘，不碰历史栈。silent = 通关时不弹结算浮层 */
  function refresh(silent) {
    recompute();
    updateHud();
    markDirty();
    checkCompletion(silent === true || state.silentInitialization);
    if (!state.simulationPending) state.silentInitialization = false;
  }

  // ---------- 存档 ----------

  /**
   * 把当前关卡的布局写进存档并落盘。
   * 只留这一个写入点，撤销/重做也走它，避免出现「存档与画面不一致」。
   */
  function rememberBoard() {
    if (state.inspection || state.shapeDraft) return;
    const level = currentLevel();
    if (!level) return;
    if (state.chipDraft) {
      if (state.cellDraft) {
        const cell = { x: state.cellDraft.x, y: state.cellDraft.y, placement: clonePlacement(state.placement) };
        state.chipDraft.circuits = [...state.chipDraft.circuits.filter((entry) => entry.x !== cell.x || entry.y !== cell.y), cell];
      }
      const entry = { id: state.chipDraft.id, name: state.chipDraft.name,
        placement: state.chipDraft.appearance ? clonePlacement(state.chipDraft.basePlacement || []) : clonePlacement(state.placement),
        ...(state.chipDraft.appearance ? { appearance: state.chipDraft.appearance,
          circuits: state.chipDraft.circuits.map((cell) => ({ ...cell, placement: clonePlacement(cell.placement) })) } : {}) };
      store.replace({ ...store.data, chips: [...(store.data.chips || []).filter((c) => c.id !== entry.id), entry] });
      store.persist();
      return;
    }
    if (state.mode === "free") {
      store.replace({ ...store.data, freeBoardVersions: {
        ...store.data.freeBoardVersions, [state.levelId]: 2,
      }, freeViews: { ...store.data.freeViews, [state.levelId]: state.camera }, freeBoards: {
        ...store.data.freeBoards, [state.levelId]: clonePlacement(state.placement),
      } });
    } else {
      store.replace(storage.setBoard(store.data, level.id, state.placement));
    }
    store.persist();
  }

  /** 记录历史最好成绩。只在刷新记录时才落盘，避免无谓的写入。 */
  function rememberStars(levelId, stars) {
    const result = storage.updateStars(store.data, levelId, stars);
    if (!result.improved) return;
    store.replace(result.save);
    store.persist();
    state.stars = store.data.stars;
  }

  // ---------- 撤销 / 重做 ----------
  //
  // 快照式：栈里存的是「每一步操作之后的元件布局」。
  // 只记录布局，不记录渲染或派生状态，因此重做的结果是确定的。

  function clonePlacement(list) {
    return list.map((item) => ({
      type: item.type,
      x: item.x,
      y: item.y,
      orient: item.orient,
      ...(item.type === "chip" ? { chipId: item.chipId } : {}),
      ...(item.type === "prism" ? { facing: item.facing || 0 } : {}),
    }));
  }

  function samePlacement(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (
        a[i].type !== b[i].type ||
        a[i].x !== b[i].x ||
        a[i].y !== b[i].y ||
        a[i].orient !== b[i].orient || a[i].chipId !== b[i].chipId || a[i].facing !== b[i].facing
      ) {
        return false;
      }
    }
    return true;
  }

  function resetHistory() {
    state.history = [clonePlacement(state.placement)];
    state.historyIndex = 0;
  }

  function pushHistory() {
    const current = clonePlacement(state.placement);
    const last = state.history[state.historyIndex];
    if (last && samePlacement(last, current)) return;

    // 产生新分支时砍掉原来的重做链
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(current);
    if (state.history.length > MAX_HISTORY) state.history.shift();
    state.historyIndex = state.history.length - 1;
  }

  function canUndo() {
    return state.historyIndex > 0;
  }

  function canRedo() {
    return state.historyIndex >= 0 && state.historyIndex < state.history.length - 1;
  }

  /** 撤销（delta = −1）与重做（delta = +1）走同一条路径，保证两者行为对称 */
  function stepHistory(delta) {
    if (state.inspection) return false;
    const next = state.historyIndex + delta;
    if (next < 0 || next >= state.history.length) return false;

    state.historyIndex = next;
    state.placement = clonePlacement(state.history[next]);
    disarmClear();
    refresh(true); // 撤销/重做不算「玩家刚通关」，静默判定
    rememberBoard();
    return true;
  }

  function undo() {
    return stepHistory(-1);
  }

  function redo() {
    return stepHistory(1);
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
      camera: state.mode === "free" ? state.camera : null,
      dpr: state.dpr,
      chips: [...(store.data.chips || []), ...(state.inspection?.virtualDefinitions || [])],
      compositeEditor: state.chipDraft?.appearance && !state.cellDraft ? state.chipDraft : null,
      shapeEditor: state.shapeDraft ? { ...state.shapeDraft.chip, appearance: {
        shape: state.placement.map((point) => ({ x: point.x, y: point.y })),
        cells: (state.shapeDraft.chip.appearance?.cells || []).filter((cell) => state.placement.some((point) => point.x === cell.x && point.y === cell.y)),
        showName: false,
      } } : null,
    });
  }

  function frame(now) {
    state.frameId = requestAnimationFrame(frame);
    if (!state.paused && now - state.lastStep >= state.stepMs) {
      state.lastStep = now;
      simulation.advance();
      refresh(false);
    }
    if (!state.dirty) return;
    state.dirty = false;
    paint();
  }

  function start() {
    if (state.running) return;
    state.running = true;
    state.lastStep = performance.now();
    state.frameId = requestAnimationFrame(frame);
  }

  function stop() {
    if (!state.running) return;
    state.running = false;
    cancelAnimationFrame(state.frameId);
  }

  // ---------- 操作 ----------

  function handleCell(x, y) {
    if (state.inspection) return;
    if (state.shapeDraft) {
      const index = state.placement.findIndex((point) => point.x === x && point.y === y);
      if (index >= 0) state.placement.splice(index, 1);
      else {
        if (state.placement.length >= core.MAX_CHIP_CELLS) return;
        state.placement.push({ type: "shape", x, y, orient: 0 });
      }
      commit(); return;
    }
    if (state.chipDraft?.appearance && !state.cellDraft) {
      if (core.shapeContains(state.chipDraft.appearance, x, y)) openChipCell(x, y);
      return;
    }
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

    if (!state.selectedType || state.selectedType === PAN) return;
    if (state.placement.length >= levels.MAX_UNITS) return;
    if (cellOf(x, y)) return; // 关卡预设元件不可覆盖
    if (quotaLeft(state.selectedType) <= 0) return;
    if (state.selectedType === "chip" && !state.selectedChipId) {
      showChipLibrary();
      return;
    }
    if (state.selectedType === "chip" && state.chipDraft &&
        core.chipDependsOn(store.data.chips || [], state.selectedChipId, state.chipDraft.id)) {
      showErrors("无法放置", ["芯片不能直接或间接包含自身。"]);
      return;
    }

    const candidate = {
      type: state.selectedType,
      x,
      y,
      orient: core.ORIENT.SLASH,
      ...(state.selectedType === "chip" ? { chipId: state.selectedChipId } : {}),
      ...(state.selectedType === "prism" ? { facing: 0 } : {}),
    };
    if (state.mode === "free" && core.placementCollisions([...state.placement, candidate], store.data.chips || [])) {
      showErrors("无法放置", ["芯片占用的格子与其他元件重叠，请选择空旷的位置。"]);
      return;
    }
    state.placement.push(candidate);
    commit();
  }

  function rotateAt(x, y) {
    if (state.inspection) return;
    const item = findPlacement(x, y);
    if (!item || !core.isRotatable(item.type)) return;
    const previous = { ...item };
    rotateItem(item);
    if (state.mode === "free" && core.placementCollisions(state.placement, store.data.chips || [])) {
      Object.assign(item, previous);
      showErrors("无法旋转", ["旋转后的芯片会与其他元件重叠，请先移开相邻元件。"]);
      return;
    }
    commit();
  }

  function rotateItem(item) {
    if (item.type === "prism") item.facing = ((item.facing || 0) + 1) % 4;
    else item.orient = core.cycleOrient(item.type, item.orient);
  }

  function rotateAll() {
    if (state.inspection) return;
    let changed = false;
    const previous = clonePlacement(state.placement);
    for (const item of state.placement) {
      if (!core.isRotatable(item.type)) continue;
      rotateItem(item); changed = true;
    }
    if (changed && state.mode === "free" && core.placementCollisions(state.placement, store.data.chips || [])) {
      state.placement = previous;
      showErrors("无法整体旋转", ["旋转后的芯片与其他元件重叠。"]);
    } else if (changed) commit();
  }

  function deleteAll() {
    if (state.inspection || state.placement.length === 0) return;
    state.placement = [];
    disarmClear(); commit();
  }

  function togglePause() {
    state.paused = !state.paused;
    state.lastStep = performance.now();
    updateHud(); markDirty();
  }

  function stepOnce() {
    if (!state.paused) return;
    simulation.advance();
    state.lastStep = performance.now();
    refresh(false);
  }

  function resetSimulation() {
    simulation.reset();
    state.lastStep = performance.now();
    state.silentInitialization = true;
    refresh(true);
  }

  function changeStepDuration() {
    const seconds = Number(dom.stepSeconds.value);
    if (!Number.isFinite(seconds) || seconds < 0.05 || seconds > 3600) {
      dom.stepSeconds.value = String(state.stepMs / 1000);
      return;
    }
    state.stepMs = Math.round(seconds * 1000);
    state.lastStep = performance.now();
    dom.stepSeconds.value = String(state.stepMs / 1000);
    store.replace({ ...store.data, stepMs: state.stepMs }); store.persist();
    updateHud();
  }

  function cyclePrismColors() {
    if (state.inspection) return;
    const item = state.cursor && findPlacement(state.cursor.x, state.cursor.y);
    if (!item || item.type !== "prism") return;
    item.orient = core.cycleOrient("prism", item.orient);
    commit();
  }

  function removeAt(x, y) {
    if (state.inspection) return;
    const index = state.placement.indexOf(findPlacement(x, y));
    if (index === -1) return;
    state.placement.splice(index, 1);
    commit();
  }

  let clearArmed = false;
  let clearTimer = 0;

  /** 复位「清空」的确认态；误触时到点自动复原，不打断玩家 */
  function disarmClear() {
    if (!clearArmed) return;
    clearArmed = false;
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = 0;
    }
    dom.btnClear.textContent = "清空";
    dom.btnClear.classList.remove("btn--danger");
  }

  /** 清空会一次性抹掉整个布局，因此要点两次 —— 第一次把按钮切成确认态 */
  function requestClear() {
    if (state.inspection) return;
    if (state.placement.length === 0) return;

    if (!clearArmed) {
      clearArmed = true;
      dom.btnClear.textContent = "确认清空？";
      dom.btnClear.classList.add("btn--danger");
      clearTimer = setTimeout(disarmClear, CLEAR_CONFIRM_MS);
      return;
    }

    disarmClear();
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
    if (state.mode === "free" || state.inspection) return;
    const level = currentLevel();
    if (!level || !state.result) return;

    const lit = state.result.allLit;
    if (lit && !state.wasAllLit) {
      const stars = engine.starsFor(true, state.result.placedCount, level.par);
      const previous = state.stars[level.id] || 0;
      if (stars > previous) {
        state.stars[level.id] = stars;
        rememberStars(level.id, stars);
      }
      updateHud();
      if (!silent && !(level.par === 0 && state.placement.length === 0)) showResult(stars, level);
    }
    state.wasAllLit = lit;
  }

  // ---------- HUD ----------

  function chipSignalText(cell) {
    const sides = ["上", "右上", "右", "右下", "下", "左下", "左", "左上"];
    const ports = cell.portDirections || [];
    const directions = ports.map((dir) => sides[dir]).join("、") || "无";
    const inputs = (cell.inputColors || []).map((color, dir) => color ? dir : -1).filter((dir) => dir >= 0);
    const matched = inputs.filter((dir) => cell.acceptedInputColors ? cell.acceptedInputColors[dir] : ports.includes(dir));
    const outputs = (cell.outputColors || []).map((color, dir) => color ? sides[dir] : "").filter(Boolean);
    const status = !inputs.length ? "尚无外部来光" : matched.length ? "已接收入光" : "来光未匹配IO口，已挡光";
    const outputStatus = !ports.length ? "未设置IO口" : outputs.length ? "正在向" + outputs.join("、") + "输出" :
      matched.length ? "IO口已设置，本拍无输出信号" : "IO口已设置，等待信号";
    return "芯片IO箭头：" + directions + " · " + status + " · " + outputStatus;
  }

  function updateHud() {
    const level = currentLevel();
    if (!level) return;
    document.body.dataset.mode = state.mode;

    dom.title.textContent = level.title;
    if (state.inspection) dom.title.textContent = "运行过程 · " + state.inspection.name;
    if (state.chipDraft) dom.title.textContent = "编辑芯片 · " + state.chipDraft.name;
    if (state.shapeDraft) dom.title.textContent = "绘制芯片形状";
    const outerEditor = Boolean(state.chipDraft?.appearance && !state.cellDraft);
    if (outerEditor) dom.title.textContent = "外层网格 · " + state.chipDraft.name;
    else if (state.cellDraft && state.chipDraft) dom.title.textContent = "编辑格子 (" + state.cellDraft.x + "," + state.cellDraft.y + ") · " + state.chipDraft.name;
    dom.btnChipDone.textContent = state.cellDraft ? "保存并返回外层网格" : "保存并返回实验板";
    dom.btnShapeNext.disabled = !state.placement.length;
    dom.btnShapeClear.disabled = !state.placement.length;
    dom.btnCellAppearance.hidden = !state.cellDraft;
    dom.chipEditorHint.textContent = outerEditor ? "点击一个格子，进入它独立的内部网格。" :
      "每格内部沿用原芯片的四向 IO 规则。点击旋转，R 重置运行过程。";

    const chapters = levels.listChapters();
    let chapterName = "教学";
    for (const chapter of chapters) {
      if (chapter.levelIds.indexOf(level.id) !== -1) chapterName = chapter.title;
    }
    dom.sub.textContent = "第 " + level.chapter + " 章 · " + chapterName;
    const free = state.mode === "free";
    if (free) dom.sub.textContent = "自由模式 · 无限网格 · 不计星级";
    dom.btnMode.setAttribute("aria-pressed", String(free));
    dom.btnChallenge.setAttribute("aria-pressed", String(!free));
    dom.modeHint.textContent = free ? "自由实验，点「关卡模式」随时返回" : "挑战关卡，收集星星";
    const internal = Boolean(state.chipDraft || state.inspection || state.shapeDraft);
    dom.btnCopyLevel.hidden = !free || internal;
    dom.btnApplyLevel.hidden = !free || internal;
    dom.btnChips.hidden = !free || Boolean(state.inspection) || outerEditor || Boolean(state.shapeDraft);
    dom.btnMode.disabled = internal;
    dom.btnChallenge.disabled = internal;
    dom.btnLevels.disabled = internal;
    dom.btnImport.disabled = internal;
    dom.btnExport.disabled = internal;
    dom.btnSnapshots.disabled = internal;
    dom.toolbar.hidden = Boolean(state.inspection || state.shapeDraft) || outerEditor;
    dom.btnRun.textContent = state.paused ? "开始（空格）" : "暂停（空格）";
    dom.btnRun.setAttribute("aria-pressed", String(state.paused));
    dom.btnStep.hidden = !state.paused;
    dom.btnStep.disabled = !state.paused;
    dom.simulationStatus.textContent = (state.paused ? "已暂停" : "运行中") + " · 第 " + simulation.tick + " 拍 · 每拍 " + state.stepMs / 1000 + " 秒";
    dom.viewControls.hidden = !free;

    const best = free ? 0 : state.stars[level.id] || 0;
    const cleared = best > 0;
    const nextId = levels.nextLevelId(level.id);

    dom.stars.textContent = cleared ? starText(best) : "";
    dom.stars.setAttribute("aria-label", cleared ? "已获得 " + best + " 星" : "尚未通关");

    // 「下一关」是常驻入口：通关结算浮层被关掉之后，玩家仍然有路可走
    dom.btnNext.hidden = free || !nextId;
    dom.btnNext.disabled = !cleared;

    dom.hint.textContent = level.hint;

    dom.btnClear.disabled = state.placement.length === 0 || Boolean(state.inspection);
    if (dom.btnClear.disabled) disarmClear();
    dom.btnUndo.disabled = !canUndo() || Boolean(state.inspection);
    dom.btnRedo.disabled = !canRedo() || Boolean(state.inspection);
    dom.btnPrismColors.hidden = Boolean(state.inspection) || !(state.cursor && findPlacement(state.cursor.x, state.cursor.y)?.type === "prism");

    // 状态行承载两种反馈，按优先级拼接：
    //   1. 光路过载 —— 这是「显示可能不完整」，必须说清楚，否则玩家会以为关卡坏了
    //   2. 通关 —— 静默通关（进关时目标就已满足）没有结算浮层，只能靠这一行
    const overloaded = Boolean(state.result && state.result.overflow);
    const messages = [];
    if (state.shapeDraft) messages.push("独立无限网格 · 已选 " + state.placement.length + " 格 · 点击翻转，下一步后再进入方块内部 · 名字可以最后再取");
    else if (state.inspection) messages.push("当前实例实时状态 · 只读查看，不重置过程 · 空格暂停／继续");
    else if (state.chipDraft) messages.push("芯片自动保存 · 编辑完成后点「保存并返回实验板」");
    else if (free) messages.push("布局自动保存 · 点「关卡模式」保留两边布局，或「应用到关卡」带回镜片布局");
    if (outerEditor) messages.push("点击一个形状格，进入这格独立的内部网格 · 外环按对应格子收发光");
    if (state.chipDraft && !outerEditor) {
      const ports = state.placement.filter((cell) => core.isInputPort(cell.type)).length;
      messages.push("IO口 " + ports + " 个 · 箭头指向内部，向外出光方向相反 · 点击旋转");
      if (!ports) messages.push("未设置IO口，芯片无法与外部传光");
    }
    if (free && !state.chipDraft) {
      const focus = state.hover || state.cursor;
      let chip = state.inspection ? state.inspection.signals : focus && state.result.grid.cells.find((cell) =>
        cell.type === "chip" && cell.x === focus.x && cell.y === focus.y);
      if (!chip && !state.inspection) {
        const chips = state.result.grid.cells.filter((cell) => cell.type === "chip");
        if (chips.length === 1) chip = chips[0];
      }
      const focusedThermal = focus && state.result.grid.cells.some((cell) =>
        ["coldMirror", "hotMirror"].includes(cell.type) && cell.x === focus.x && cell.y === focus.y);
      if (chip && !focusedThermal) messages.push(chipSignalText(chip));
    }
    if (free) {
      const focus = state.hover || state.cursor;
      const thermal = focus && state.result.grid.cells.find((cell) =>
        ["coldMirror", "hotMirror"].includes(cell.type) && cell.x === focus.x && cell.y === focus.y);
      if (thermal) messages.push(TYPE_NAMES[thermal.type] + " · " + (thermal.open ? "开启通光" : "关闭挡光") +
        " · 通光轴：" + (core.thermalAxis(thermal.type, thermal.orient).dx ? "左右" : "上下") +
        (thermal.type === "coldMirror" ? " · 侧面输入：" + (thermal.receiving ? "有光 → 取反后关闭" : "无光 → 取反后开启") + " · 延迟1拍"
          : " · 侧面输入：" + (thermal.receiving ? "有光 → 正向开启" : "无光 → 正向关闭") + " · 延迟1拍"));
    }
    if (free && state.result.targets.length) {
      messages.push("灯泡亮起 " + state.result.targets.filter((t) => t.lit).length + " / " + state.result.targets.length);
    }
    if (overloaded) {
      messages.push("光路过于复杂，已停止追踪，画面可能不完整 · 减少一些元件再试");
    }
    if (cleared) {
      messages.push(
        nextId
          ? "已通关 " + starText(best) + " · 点右上角「下一关」继续"
          : "已通关 " + starText(best) + " · 你已完成全部关卡",
      );
    }
    dom.status.hidden = messages.length === 0;
    dom.status.textContent = messages.join(" · ");
    dom.status.classList.toggle("stage__status--warn", overloaded);

    updateToolbar();
  }

  function updateToolbar() {
    dom.btnPan.setAttribute("aria-pressed", String(state.selectedType === PAN));
    canvas.style.cursor = state.mode === "free" && (state.selectedType === PAN || !state.selectedType) ? "grab" : "crosshair";
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
      count.textContent = state.mode === "free" ? "不限" : "×" + left;
      button.setAttribute("aria-pressed", String(state.selectedType === type));
      button.disabled = left <= 0;
    }
  }

  function buildToolbar(level) {
    dom.toolbar.innerHTML = "";
    toolButtons.clear();

    const types = availableTypes(level);
    // 一个元件都不发的关卡（如教学第 1 关）不摆橡皮，免得只剩一个永远禁用的按钮让人困惑
    if (types.length === 0) return;
    types.push(ERASER);

    for (const type of types) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tool";
      button.dataset.type = type === ERASER ? "eraser" : type;
      button.setAttribute("aria-pressed", "false");
      button.title = type === "prism" ? "棱镜：左键旋转输入方向，C 切换 RGB 出口顺序"
        : type === "coldMirror" ? "冷镜：自带侧面非门，侧面有光一拍后关闭，无光一拍后开启；横镜通上下、竖镜通左右，通路光不触发开关，侧面控制光不穿透"
        : type === "hotMirror" ? "热镜：初始挡光，侧面有光一拍后开启、无光一拍后关闭；通路光不触发开关，横镜通上下、竖镜通左右，侧面控制光不穿透"
        : core.CHIP_PORT_TYPES.includes(type) ? "IO口：箭头表示外到内；向下箭头从上方接入、向上方输出，其他方向类推；侧面挡光；点击转90°，两次转180°" : TYPE_NAMES[type] || type;

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
        if (type === "chip") { showChipLibrary(); return; }
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
    chipDeleteUndo = null;
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

    const total = levels.totalStars(state.stars);
    const summary = document.createElement("p");
    summary.className = "sheet__summary";
    summary.textContent = "共获得 " + total.earned + " / " + total.max + " 星";
    dom.sheetBody.appendChild(summary);

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

  /** 统一的错误展示：导入失败、快照失败都走这里，把原因逐条列出来 */
  function showErrors(title, errors) {
    dom.sheetTitle.textContent = title;
    dom.sheetBody.innerHTML = "";
    dom.sheetActions.innerHTML = "";

    const list = document.createElement("ul");
    list.className = "error-list";
    for (const error of errors) {
      const item = document.createElement("li");
      item.textContent = error;
      list.appendChild(item);
    }
    dom.sheetBody.appendChild(list);

    addAction("知道了", hideOverlay, true);
    showOverlay();
  }

  // ---------- 工作台快照 ----------

  function showSnapshotSheet() {
    const level = currentLevel();
    if (!level) return;

    dom.sheetTitle.textContent = "工作台 · " + level.title;
    dom.sheetBody.innerHTML = "";
    dom.sheetActions.innerHTML = "";

    const mine = store.data.snapshots.filter((item) => item.levelId === level.id);

    if (mine.length === 0) {
      const empty = document.createElement("p");
      empty.className = "sheet__summary";
      empty.textContent = "这一关还没有存过工作台。";
      dom.sheetBody.appendChild(empty);
    } else {
      const list = document.createElement("div");
      list.className = "level-list";
      for (const item of mine) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "level-item";
        button.dataset.snapshot = item.name;

        const label = document.createElement("span");
        label.textContent = item.name;
        button.appendChild(label);

        const count = document.createElement("span");
        count.className = "level-item__stars";
        count.textContent = item.placement.length + " 个元件";
        button.appendChild(count);

        button.addEventListener("click", () => {
          state.placement = state.mode === "free" && item.sceneVersion !== 2
            ? seedFreeBoard(levels.getLevel(state.levelId), item.placement) : clonePlacement(item.placement);
          state.wasAllLit = false;
          hideOverlay();
          commit();
        });

        list.appendChild(button);
      }
      dom.sheetBody.appendChild(list);
    }

    if (state.placement.length > 0) {
      addAction("保存当前布局", showSaveSheet, true);
    }
    addAction("关闭", hideOverlay, state.placement.length === 0);
    showOverlay();
  }

  function showSaveSheet() {
    const level = currentLevel();
    if (!level) return;

    dom.sheetTitle.textContent = "保存工作台";
    dom.sheetBody.innerHTML = "";
    dom.sheetActions.innerHTML = "";

    const field = document.createElement("input");
    field.type = "text";
    field.className = "field";
    field.id = "snapshot-name";
    field.maxLength = storage.MAX_NAME_LENGTH;
    field.value = "工作台 " + (store.data.snapshots.length + 1);
    field.setAttribute("aria-label", "工作台名称");
    dom.sheetBody.appendChild(field);

    const tip = document.createElement("p");
    tip.className = "sheet__summary";
    tip.textContent = "存下来之后，随时可以在「工作台」里载入。";
    dom.sheetBody.appendChild(tip);

    const save = () => {
      const result = storage.addSnapshot(store.data, {
        name: field.value,
        levelId: level.id,
        placement: state.placement,
        savedAt: new Date().toISOString(),
        ...(state.mode === "free" ? { sceneVersion: 2 } : {}),
      });

      if (!result.ok) {
        showErrors("保存失败", result.errors);
        return;
      }

      store.replace(result.save);
      store.persist();
      showSnapshotSheet();
    };

    addAction("保存", save, true);
    addAction("返回", showSnapshotSheet);

    showOverlay();
    field.focus();
    field.select();
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        save();
      }
    });
  }

  // ---------- 导入 / 导出 ----------

  function exportCurrentLevel() {
    const level = currentLevel();
    if (!level) return;

    const text = storage.serializeLevelFile(state.mode === "free"
      ? { ...level, chips: store.data.chips || [] } : level, state.placement);
    const blob = new Blob([text], { type: "application/json" });
    if (!storage.downloadFile(storage.levelFileName(level), blob)) {
      showErrors("导出失败", ["当前环境不支持直接下载文件"]);
    }
  }

  async function importLevelFile(file) {
    let text = "";
    try {
      text = await file.text();
    } catch (error) {
      showErrors("导入失败", ["读不到文件内容：" + (error && error.message ? error.message : "")]);
      return;
    }

    const parsed = storage.parseLevelFile(text);
    if (!parsed.ok) {
      showErrors("导入失败 · " + file.name, parsed.errors);
      return;
    }

    if (parsed.level.mode === "free") {
      const source = levels.getLevel(parsed.level.sourceLevelId);
      const expected = source ? createFreeLevel(source) : null;
      const legacy = source ? { ...source, fixed: source.fixed.map((item) => item.type === "emitter"
        ? { ...item, dir: "all", color: 7 } : item) } : null;
      const definition = parsed.level.infinite ? expected : legacy;
      const matches = definition && ["cols", "rows", "fixed", "targets"].every((key) =>
        JSON.stringify(definition[key]) === JSON.stringify(parsed.level[key]));
      if (!matches) {
        showErrors("导入失败", ["找不到匹配的原关卡，请先导入原关卡，再导入自由布局。"]);
        return;
      }
      selectLevel(source.id);
      enterFreeMode();
      if (parsed.level.chips) {
        const imported = parsed.level.chips;
        store.replace({ ...store.data, chips: [...(store.data.chips || []).filter((chip) =>
          !imported.some((other) => other.id === chip.id)), ...imported] });
      }
      state.placement = parsed.level.infinite ? clonePlacement(parsed.placement) : seedFreeBoard(source, parsed.placement);
      commit();
      return;
    }

    // 与已有 id 冲突时（内置关卡，或先前导入过的同名关卡）不覆盖关卡定义，
    // 只把文件里的布局应用上去：关卡是骨架，布局才是玩家改出来的东西。
    const registered = levels.registerLevel(parsed.level);
    const idConflict = registered.errors.some((error) => error.indexOf("冲突") !== -1);
    if (!registered.ok && !idConflict) {
      showErrors("导入失败 · " + file.name, registered.errors);
      return;
    }

    hideOverlay();
    selectLevel(parsed.level.id);
    state.placement = clonePlacement(parsed.placement);
    if (state.placement.length > 0) commit();
  }

  // ---------- 关卡切换 ----------

  function rememberSession() {
    store.replace({ ...store.data, session: { levelId: state.levelId, mode: state.mode } });
    store.persist();
  }

  function enterFreeMode() {
    const source = levels.getLevel(state.levelId);
    if (!source || state.mode === "free") return;
    rememberBoard();
    simulation.reset(); state.lastStep = performance.now();
    const saved = store.data.freeBoards && store.data.freeBoards[source.id];
    state.freeLevel = createFreeLevel(source);
    state.mode = "free";
    state.placement = saved && store.data.freeBoardVersions && store.data.freeBoardVersions[source.id] === 2
      ? clonePlacement(saved) : seedFreeBoard(source, saved || state.placement);
    state.camera = store.data.freeViews && store.data.freeViews[source.id]
      ? { ...store.data.freeViews[source.id] } : homeCamera(source);
    resetBoardView();
    rememberBoard();
    rememberSession();
  }

  function createFreeLevel(source) {
    return {
      ...source,
      mode: "free",
      infinite: true,
      sceneVersion: 2,
      sourceLevelId: source.id,
      id: "free:" + source.id,
      title: "自由实验 · " + source.title,
      fixed: [],
      targets: [],
      inventory: Object.fromEntries(core.FREE_PLACEABLE_TYPES.map((type) => [type, levels.MAX_UNITS])),
      hint: "点击旋转元件，R 重置运行过程。拖动画布平移，滚轮或＋／－缩放。",
    };
  }

  function seedFreeBoard(source, optics) {
    return [...clonePlacement(optics), ...source.fixed.map((item) => ({
      type: item.type, x: item.x, y: item.y, orient: 0,
    })), ...source.targets.map((item) => ({ type: "bulb", x: item.x, y: item.y, orient: 0 }))];
  }

  function homeCamera(source) {
    return { x: source.cols / 2, y: source.rows / 2, cell: 36 };
  }

  function openShapeGrid(chip, creating = false) {
    if (!chip || state.shapeDraft || state.inspection) return;
    rememberBoard(); hideOverlay();
    const workspace = {};
    for (const key of ["placement", "freeLevel", "camera", "history", "historyIndex", "selectedType", "cursor", "hover", "chipDraft", "cellDraft", "parentWorkspace"]) workspace[key] = state[key];
    state.shapeDraft = { chip: globalThis.structuredClone(chip), creating, workspace };
    state.chipDraft = null; state.cellDraft = null;
    state.freeLevel = { ...workspace.freeLevel, infinite: true, insideChip: false,
      hint: "这是独立的无限形状网格。点击任意格子翻转选中／取消；拖动平移，滚轮缩放。下一步后再进入方块内部。" };
    const points = chip.appearance ? core.appearancePoints(chip.appearance) : creating ? [] : [{ x: 0, y: 0 }];
    state.placement = points.map((point) => ({ type: "shape", x: point.x, y: point.y, orient: 0 }));
    const anchor = chip.appearance ? core.appearanceAnchor(chip.appearance) : { x: 0, y: 0 };
    state.camera = { x: anchor.x, y: anchor.y, cell: 36 };
    state.selectedType = null; state.cursor = null; state.hover = null;
    dom.chipEditor.hidden = true; dom.chipShapeEditor.hidden = false;
    dom.chipShapeName.value = creating ? "" : chip.name;
    simulation.reset(); state.lastStep = performance.now();
    resetHistory(); buildToolbar(currentLevel()); refresh(true);
  }

  function restoreShapeWorkspace() {
    if (!state.shapeDraft) return;
    const workspace = state.shapeDraft.workspace;
    state.shapeDraft = null; Object.assign(state, workspace);
    dom.chipShapeEditor.hidden = true; dom.chipEditor.hidden = !state.chipDraft;
    simulation.reset(); state.lastStep = performance.now();
    buildToolbar(currentLevel()); refresh(true);
  }

  function finishShapeGrid() {
    if (!state.shapeDraft || !state.placement.length) return;
    const draft = state.shapeDraft;
    const current = (store.data.chips || []).find((chip) => chip.id === draft.chip.id) || draft.chip;
    const shape = state.placement.map((point) => ({ x: point.x, y: point.y }));
    const selected = new Set(shape.map((point) => point.x + "," + point.y));
    const appearance = core.normalizeChipAppearance({ shape, showName: current.appearance?.showName !== false,
      cells: (current.appearance?.cells || []).filter((cell) => selected.has(cell.x + "," + cell.y)) });
    if (!appearance) { showErrors("无法使用这个形状", ["请检查所选格子的坐标。"]); return; }
    const updated = { ...current, name: dom.chipShapeName.value.trim().slice(0, 24) || current.name || "未命名芯片", appearance,
      ...(current.circuits ? { circuits: current.circuits.filter((cell) => cell.placement.length || selected.has(cell.x + "," + cell.y)) } : {}) };
    const chips = (store.data.chips || []).some((chip) => chip.id === updated.id)
      ? store.data.chips.map((chip) => chip.id === updated.id ? updated : chip) : [...(store.data.chips || []), updated];
    for (const chip of chips) {
      const error = core.chipLayoutError(chip, chips);
      if (error) { showErrors("不能移除已有线路的格子", ["芯片「" + chip.name + "」：" + error + "。请先清空该格内部线路。"]); return; }
    }
    const boards = [...Object.values(store.data.freeBoards || {}), ...chips.flatMap((chip) =>
      [chip.placement, ...(chip.circuits || []).map((cell) => cell.placement)])];
    if (boards.some((board) => core.placementCollisions(board, chips))) {
      showErrors("形状发生重叠", ["新形状会碰到现有元件，请先移动相邻元件。"]); return;
    }
    store.replace({ ...store.data, chips }); store.persist();
    restoreShapeWorkspace();
    if (state.chipDraft) {
      if (state.cellDraft) { const outer = state.cellDraft.outer; state.cellDraft = null; Object.assign(state, outer); }
      if (state.chipDraft.id === updated.id) Object.assign(state.chipDraft, { name: updated.name, appearance,
        circuits: globalThis.structuredClone(core.chipCircuits(updated)), basePlacement: clonePlacement(updated.placement) });
      closeChipEditor();
    }
    openChipEditor(updated);
  }

  function showCellAppearance() {
    if (!state.chipDraft?.appearance || !state.cellDraft) return;
    rememberBoard();
    const chip = (store.data.chips || []).find((entry) => entry.id === state.chipDraft.id);
    const { x, y } = state.cellDraft;
    const previous = chip.appearance.cells.find((cell) => cell.x === x && cell.y === y);
    dom.sheetTitle.textContent = "本格外观 (" + x + "," + y + ")";
    dom.sheetBody.innerHTML = ""; dom.sheetActions.innerHTML = "";
    const controls = document.createElement("div"); controls.className = "appearance-controls"; dom.sheetBody.appendChild(controls);
    function input(label, type) {
      const wrapper = document.createElement("label"); wrapper.textContent = label + " ";
      const field = document.createElement("input"); field.type = type; field.setAttribute("aria-label", label);
      wrapper.appendChild(field); controls.appendChild(wrapper); return field;
    }
    const color = input("格子颜色", "color"); color.value = previous?.color || "#20373c";
    const text = input("格子文字", "text"); text.value = previous?.text || ""; text.maxLength = 12;
    const arrow = input("绿色朝上箭头", "checkbox"); arrow.checked = Boolean(previous?.arrow);
    function apply(clear) {
      let cells = chip.appearance.cells.filter((cell) => cell.x !== x || cell.y !== y);
      if (!clear) {
        if (arrow.checked) cells = cells.map((cell) => ({ ...cell, arrow: false }));
        cells.push({ x, y, color: color.value, text: text.value, arrow: arrow.checked });
      }
      const appearance = core.normalizeChipAppearance({ ...chip.appearance, cells });
      store.replace({ ...store.data, chips: store.data.chips.map((entry) => entry.id === chip.id ? { ...entry, appearance } : entry) });
      store.persist(); state.chipDraft.appearance = appearance;
      hideOverlay(); refresh(true); rememberBoard();
    }
    addAction("应用本格外观", () => apply(false), true);
    addAction("清除本格样式", () => apply(true));
    addAction("取消", hideOverlay); showOverlay();
  }

  function showChipLibrary() {
    if (state.mode !== "free" || state.inspection) return;
    const nesting = Boolean(state.chipDraft);
    dom.sheetTitle.textContent = nesting ? "选择内部芯片" : "芯片库";
    dom.sheetBody.innerHTML = "";
    dom.sheetActions.innerHTML = "";
    const help = document.createElement("p");
    help.textContent = nesting ? "选择已有芯片放到当前芯片内。不能包含自身或形成循环嵌套。" :
      "创建后先进入独立无限网格画形状，再点进各格设计内部。旧芯片仍可编辑、放置和嵌套。";
    dom.sheetBody.appendChild(help);
    for (const chip of store.data.chips || []) {
      const row = document.createElement("div");
      row.className = "chip-library-row";
      const cyclic = nesting && core.chipDependsOn(store.data.chips || [], chip.id, state.chipDraft.id);
      const actions = [["放置 " + chip.name, () => {
        state.selectedChipId = chip.id;
        state.selectedType = "chip";
        hideOverlay(); updateToolbar();
      }]];
      if (!nesting) actions.push(["编辑 " + chip.name, () => openChipEditor(chip)],
        ["形状 " + chip.name, () => openShapeGrid(chip)],
        ["删除 " + chip.name, () => showDeleteChip(chip)]);
      for (const [label, action] of actions) {
        const button = document.createElement("button");
        button.className = "btn"; button.type = "button"; button.textContent = label;
        if (label.startsWith("删除 ")) button.classList.add("btn--danger");
        if (cyclic) { button.disabled = true; button.title = "会形成循环嵌套，无法放置"; }
        button.addEventListener("click", action); row.appendChild(button);
      }
      dom.sheetBody.appendChild(row);
    }
    if (chipDeleteUndo) {
      addAction("撤销删除芯片", () => {
        const previous = chipDeleteUndo;
        chipDeleteUndo = null;
        store.replace(previous.save); store.persist();
        Object.assign(state, previous.state);
        state.stars = store.data.stars;
        refresh(true);
        showChipLibrary();
      });
    }
    if (!nesting) addAction("新建芯片", () => {
      const chips = store.data.chips || [];
      if (chips.length >= 64) { showErrors("芯片库已满", ["最多保存 64 个芯片。"]); return; }
      const chip = { id: "chip-" + Date.now() + "-" + chips.length,
        name: "芯片 " + (chips.length + 1), placement: [] };
      openShapeGrid(chip, true);
    }, true);
    addAction("关闭", hideOverlay);
    showOverlay();
  }

  function showDeleteChip(chip) {
    rememberBoard();
    const preview = storage.removeChip(store.data, chip.id);
    dom.sheetTitle.textContent = "删除芯片「" + chip.name + "」？";
    dom.sheetBody.textContent = "将删除芯片定义，并移除各实验板上的 " + preview.removedInstances +
      " 个实例、工作台中的 " + preview.removedSnapshotInstances +
      " 个实例、其他芯片内的 " + preview.removedNestedInstances +
      " 个实例。其他元件保留。删除后可在关闭芯片库前点击「撤销删除芯片」恢复。";
    dom.sheetActions.innerHTML = "";
    const confirm = addAction("确认删除芯片", () => {
      chipDeleteUndo = { save: storage.parseSave(storage.serializeSave(store.data)), state: {
        placement: clonePlacement(state.placement), history: state.history.map(clonePlacement),
        historyIndex: state.historyIndex, selectedChipId: state.selectedChipId, selectedType: state.selectedType,
      } };
      const result = storage.removeChip(store.data, chip.id);
      store.replace(result.save); store.persist();
      const keep = (item) => !(item.type === "chip" && item.chipId === chip.id);
      state.placement = state.placement.filter(keep);
      state.history = state.history.map((board) => board.filter(keep));
      if (state.selectedChipId === chip.id) {
        state.selectedChipId = null;
        if (state.selectedType === "chip") state.selectedType = null;
      }
      refresh(true);
      showChipLibrary();
    });
    confirm.classList.add("btn--danger");
    addAction("取消", showChipLibrary, true);
    showOverlay();
  }

  function openChipEditor(chip) {
    rememberBoard();
    simulation.reset(); state.lastStep = performance.now();
    state.parentWorkspace = { placement: clonePlacement(state.placement), freeLevel: state.freeLevel,
      camera: { ...state.camera }, history: state.history, historyIndex: state.historyIndex };
    state.cellDraft = null;
    state.chipDraft = { id: chip.id, name: chip.name,
      ...(chip.appearance ? { appearance: globalThis.structuredClone(chip.appearance),
        circuits: globalThis.structuredClone(core.chipCircuits(chip)), basePlacement: clonePlacement(chip.placement) } : {}) };
    state.freeLevel = { ...state.freeLevel, insideChip: true, chipShape: undefined,
      hint: chip.appearance ? "点击外层网格中的一格，编辑它独立的内部网格。相邻格按原芯片规则上下左右连接。" :
        "每个 IO 按原规则接收、输出上下左右信号。左键旋转，R 重置运行过程。",
      inventory: { ...state.freeLevel.inventory, inputPort: levels.MAX_UNITS, outputPort: levels.MAX_UNITS } };
    state.placement = chip.appearance ? [] : clonePlacement(chip.placement);
    const anchor = core.appearanceAnchor(chip.appearance);
    state.camera = chip.appearance ? { x: anchor.x + 1, y: anchor.y + 1, cell: 36 } : { x: 4, y: 3, cell: 36 };
    dom.chipEditor.hidden = false; dom.chipName.value = chip.name;
    resetBoardView(); rememberBoard();
  }

  function openChipCell(x, y) {
    if (!state.chipDraft?.appearance || state.cellDraft) return;
    rememberBoard();
    const outer = { placement: state.placement, freeLevel: state.freeLevel, camera: { ...state.camera },
      history: state.history, historyIndex: state.historyIndex, selectedType: state.selectedType, cursor: state.cursor, hover: state.hover };
    state.cellDraft = { x, y, outer };
    state.freeLevel = { ...state.freeLevel, chipShape: undefined,
      hint: "正在编辑格子 (" + x + "," + y + ") 的独立内部网格，仍使用原芯片的四向 IO 规则。" };
    state.placement = clonePlacement(state.chipDraft.circuits.find((cell) => cell.x === x && cell.y === y)?.placement || []);
    state.camera = { x: 4, y: 3, cell: 36 };
    simulation.reset(); state.lastStep = performance.now(); resetBoardView(); rememberBoard();
  }

  function closeChipCell() {
    if (!state.cellDraft) return;
    rememberBoard();
    const outer = state.cellDraft.outer;
    state.cellDraft = null;
    Object.assign(state, outer);
    simulation.reset(); state.lastStep = performance.now();
    buildToolbar(currentLevel()); refresh(true);
  }

  function closeChipEditor() {
    if (!state.chipDraft) return;
    if (state.cellDraft) closeChipCell();
    rememberBoard();
    simulation.reset(); state.lastStep = performance.now();
    Object.assign(state, state.parentWorkspace);
    state.parentWorkspace = null; state.chipDraft = null; state.cellDraft = null;
    state.selectedType = null; state.cursor = null; state.hover = null;
    dom.chipEditor.hidden = true;
    buildToolbar(currentLevel()); refresh(true); rememberBoard();
  }

  function inspectChip(cell) {
    if (state.mode !== "free") return;
    const chip = [...(store.data.chips || []), ...(state.inspection?.virtualDefinitions || [])].find((entry) => entry.id === cell.chipId);
    if (!chip) return;
    const parent = state.inspection;
    const root = parent ? parent.root : { level: currentLevel(), placement: clonePlacement(state.placement), camera: { ...state.camera },
      history: state.history, historyIndex: state.historyIndex, selectedType: state.selectedType,
      cursor: state.cursor, hover: state.hover, chipDraft: state.chipDraft };
    const trail = parent ? [...parent.trail, { ...parent, root: undefined, trail: undefined,
      level: state.freeLevel, placement: state.placement, camera: { ...state.camera } }] : [];
    const parentPath = parent ? parent.path : "root";
    state.inspection = { path: simulation.childPath(parentPath, cell), parentPath, name: chip.name,
      cell: { x: cell.x, y: cell.y }, root, trail,
      virtualDefinitions: chip.appearance ? core.chipComposite(chip).definitions : [] };
    state.chipDraft = null;
    dom.chipEditor.hidden = true;
    state.freeLevel = { ...root.level, insideChip: true,
      chipShape: undefined,
      hint: "这里显示被点击芯片实例的当前过程。空格暂停／继续，拖动平移；点「返回实验板」退出。" };
    state.placement = chip.appearance ? core.chipComposite(chip).placement : clonePlacement(chip.placement);
    state.camera = { x: 4, y: 3, cell: 36 };
    state.selectedType = PAN; state.cursor = null; state.hover = null;
    dom.chipInspectionName.textContent = "芯片 · " + chip.name;
    dom.btnInspectionBack.textContent = parent ? "返回上层芯片" : root.chipDraft ? "返回芯片编辑" : "返回实验板";
    dom.chipInspection.hidden = false;
    disarmClear(); buildToolbar(currentLevel()); refresh(true);
  }

  function closeInspection() {
    if (!state.inspection) return;
    const root = state.inspection.root;
    if (state.inspection.trail.length) {
      const trail = [...state.inspection.trail];
      const parent = trail.pop();
      state.inspection = { ...parent, root, trail };
      state.freeLevel = parent.level; state.placement = parent.placement; state.camera = parent.camera;
      dom.chipInspectionName.textContent = "芯片 · " + parent.name;
      dom.btnInspectionBack.textContent = trail.length ? "返回上层芯片" : root.chipDraft ? "返回芯片编辑" : "返回实验板";
      refresh(true);
      return;
    }
    state.inspection = null;
    state.freeLevel = root.level;
    state.chipDraft = root.chipDraft;
    dom.chipEditor.hidden = !state.chipDraft;
    for (const name of ["placement", "camera", "history", "historyIndex", "selectedType", "cursor", "hover"]) state[name] = root[name];
    dom.chipInspection.hidden = true;
    buildToolbar(currentLevel()); refresh(true);
  }

  function copyFromLevel() {
    dom.sheetTitle.textContent = "从关卡复制";
    dom.sheetBody.textContent = "用当前关卡的布局替换自由布局？可以用「撤销」恢复。";
    dom.sheetActions.innerHTML = "";
    addAction("复制布局", () => {
      state.placement = seedFreeBoard(levels.getLevel(state.levelId), storage.getBoard(store.data, state.levelId));
      hideOverlay();
      commit();
    }, true);
    addAction("取消", hideOverlay);
    showOverlay();
  }

  function applyToLevel() {
    const source = levels.getLevel(state.levelId);
    if (!source || state.mode !== "free") return;
    const placement = clonePlacement(state.placement.filter((item) => core.PLACEABLE_TYPES.includes(item.type)));
    const check = levels.validatePlacement(source, placement);
    if (!check.ok) {
      showErrors("暂不能应用到关卡", ["自由布局已保留，请调整以下元件后重试；也可以关闭提示后点「关卡模式」。", ...check.errors]);
      return;
    }
    selectLevel(source.id);
    state.placement = placement;
    commit();
  }

  function resetBoardView() {
    state.selectedType = null;
    state.cursor = null;
    state.hover = null;
    state.wasAllLit = false;
    hideOverlay();
    buildToolbar(currentLevel());
    disarmClear();
    resetHistory();
    refresh(true);
  }

  function selectLevel(id) {
    const level = levels.getLevel(id);
    if (!level) return;

    rememberBoard();
    simulation.reset(); state.lastStep = performance.now();
    state.mode = "level";
    state.silentInitialization = true;
    state.freeLevel = null;
    state.camera = null;
    state.levelId = id;
    // 回到某关时接着上次的布局继续 —— 自动存档的意义就在这儿
    state.placement = clonePlacement(storage.getBoard(store.data, id));
    // 进入关卡时静默判定一次：教学第 1 关不放元件就已通关，不该立刻弹结算
    resetBoardView();
    rememberSession();
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

  let pointerGesture = null;
  let viewSaveTimer = 0;

  function changeCamera(persist) {
    refresh(true);
    if (persist) rememberBoard();
  }

  function zoomCamera(factor, point) {
    if (state.mode !== "free" || !state.camera) return;
    const camera = state.camera;
    const px = point ? point.x - canvas.width / 2 : 0;
    const py = point ? point.y - canvas.height / 2 : 0;
    const worldX = camera.x + px / (camera.cell * state.dpr);
    const worldY = camera.y + py / (camera.cell * state.dpr);
    camera.cell = Math.max(12, Math.min(100, camera.cell * factor));
    camera.x = worldX - px / (camera.cell * state.dpr);
    camera.y = worldY - py / (camera.cell * state.dpr);
    changeCamera(false);
    clearTimeout(viewSaveTimer);
    viewSaveTimer = setTimeout(rememberBoard, 180);
  }

  canvas.addEventListener("wheel", (event) => {
    if (state.mode !== "free") return;
    event.preventDefault();
    zoomCamera(Math.exp(-event.deltaY * 0.0015), toCanvasPoint(event));
  }, { passive: false });

  canvas.addEventListener("pointerdown", (event) => {
    if (event.ctrlKey) {
      event.preventDefault();
      if (event.button === 0) rotateAll();
      else if (event.button === 2) deleteAll();
      return;
    }
    const cell = cellFromEvent(event);
    if (!cell) return;
    event.preventDefault();
    if (event.button === 1) {
      const item = findPlacement(cell.x, cell.y);
      if (item && item.type === "chip") inspectChip(item);
      return;
    }

    if (state.mode === "free" && event.button !== 2) {
      if (pointerGesture) return;
      pointerGesture = { id: event.pointerId, x: event.clientX, y: event.clientY,
        camera: { ...state.camera }, cell,
        moved: state.selectedType === PAN };
      canvas.setPointerCapture(event.pointerId);
      return;
    }

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
    if (pointerGesture && pointerGesture.id === event.pointerId) {
      const dx = event.clientX - pointerGesture.x;
      const dy = event.clientY - pointerGesture.y;
      if (Math.hypot(dx, dy) > 5) pointerGesture.moved = true;
      if (pointerGesture.moved) {
        state.camera.x = pointerGesture.camera.x - dx / state.camera.cell;
        state.camera.y = pointerGesture.camera.y - dy / state.camera.cell;
        state.hover = null;
        canvas.style.cursor = "grabbing";
        changeCamera(false);
      }
      return;
    }
    if (event.pointerType === "touch") return;
    const cell = cellFromEvent(event);
    const changed =
      (cell === null) !== (state.hover === null) ||
      (cell && state.hover && (cell.x !== state.hover.x || cell.y !== state.hover.y)) ||
      (cell && !state.hover);

    if (changed) {
      state.hover = cell;
      updateHud();
      markDirty();
    }
  });

  function finishPointer(event) {
    if (!pointerGesture || pointerGesture.id !== event.pointerId) return;
    const gesture = pointerGesture;
    pointerGesture = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (event.type !== "pointercancel" && !gesture.moved) {
      state.cursor = gesture.cell;
      handleCell(gesture.cell.x, gesture.cell.y);
      markDirty();
    }
    if (gesture.moved) rememberBoard();
    updateHud();
  }
  canvas.addEventListener("pointerup", finishPointer);
  canvas.addEventListener("pointercancel", finishPointer);
  canvas.addEventListener("lostpointercapture", finishPointer);

  canvas.addEventListener("pointerleave", () => {
    if (state.hover) {
      state.hover = null;
      updateHud();
      markDirty();
    }
  });

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  function moveCursor(dx, dy) {
    const level = currentLevel();
    if (!level) return;

    const start = state.cursor || { x: 0, y: 0 };
    const x = state.mode === "free" ? start.x + dx : Math.max(0, Math.min(level.cols - 1, start.x + dx));
    const y = state.mode === "free" ? start.y + dy : Math.max(0, Math.min(level.rows - 1, start.y + dy));
    state.cursor = { x, y };
    if (state.mode === "free") {
      const halfW = canvas.width / state.dpr / state.camera.cell / 2;
      const halfH = canvas.height / state.dpr / state.camera.cell / 2;
      if (Math.abs(x + 0.5 - state.camera.x) > halfW - 1 || Math.abs(y + 0.5 - state.camera.y) > halfH - 1) {
        state.camera.x = x + 0.5;
        state.camera.y = y + 0.5;
        changeCamera(true);
      }
    }
    markDirty();
  }

  function selectByIndex(index) {
    if (state.inspection) return;
    const level = currentLevel();
    if (!level) return;
    const available = availableTypes(level);
    const type = available[index];
    if (!type) return;
    state.selectedType = state.selectedType === type ? null : type;
    updateToolbar();
  }

  document.addEventListener("keydown", (event) => {
    if (event.target && ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
    const level = currentLevel();
    if (!level) return;

    if (event.key === "Escape") {
      event.preventDefault();
      if (!dom.overlay.hidden) hideOverlay();
      else if (state.shapeDraft) restoreShapeWorkspace();
      else if (state.inspection) closeInspection();
      else if (state.selectedType) {
        state.selectedType = null;
        updateToolbar();
      } else showLevelList();
      return;
    }

    if (!dom.overlay.hidden) return;
    if (event.code === "Space" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      if (!event.repeat) togglePause();
      return;
    }

    // 撤销 / 重做必须先于「带修饰键一律忽略」那一层，否则会被整个拦掉
    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (key === "y") {
        event.preventDefault();
        redo();
        return;
      }
    }

    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const cursor = state.cursor;

    switch (event.key) {
      case "n":
      case "N":
        event.preventDefault();
        if (!event.repeat) stepOnce();
        return;
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
        if (cursor) {
          event.preventDefault();
          handleCell(cursor.x, cursor.y);
        }
        return;
      case "r":
      case "R":
        event.preventDefault();
        if (!event.repeat) resetSimulation();
        return;
      case "c":
      case "C":
        event.preventDefault();
        cyclePrismColors();
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
    if (Number.isInteger(digit) && digit >= 1 && digit <= 6) {
      event.preventDefault();
      selectByIndex(digit - 1);
    }
  });

  // ---------- 装配 ----------

  dom.btnLevels.addEventListener("click", showLevelList);
  dom.btnMode.addEventListener("click", () => {
    enterFreeMode();
  });
  dom.btnChallenge.addEventListener("click", () => {
    if (state.mode === "free") selectLevel(state.levelId);
  });
  dom.btnCopyLevel.addEventListener("click", copyFromLevel);
  dom.btnApplyLevel.addEventListener("click", applyToLevel);
  dom.btnChips.addEventListener("click", showChipLibrary);
  dom.btnChipDone.addEventListener("click", () => state.cellDraft ? closeChipCell() : closeChipEditor());
  dom.btnRun.addEventListener("click", togglePause);
  dom.btnStep.addEventListener("click", stepOnce);
  dom.btnReset.addEventListener("click", resetSimulation);
  dom.btnAppearance.addEventListener("click", () => {
    if (!state.chipDraft) return;
    rememberBoard();
    openShapeGrid((store.data.chips || []).find((chip) => chip.id === state.chipDraft.id));
  });
  dom.btnCellAppearance.addEventListener("click", showCellAppearance);
  dom.btnShapeNext.addEventListener("click", finishShapeGrid);
  dom.btnShapeCancel.addEventListener("click", restoreShapeWorkspace);
  dom.btnShapeClear.addEventListener("click", () => {
    if (!state.shapeDraft || !state.placement.length) return;
    state.placement = []; commit();
  });
  dom.stepSeconds.addEventListener("change", changeStepDuration);
  dom.btnInspectionBack.addEventListener("click", closeInspection);
  dom.chipName.addEventListener("input", () => {
    if (!state.chipDraft) return;
    state.chipDraft.name = dom.chipName.value.trim().slice(0, 24) || "未命名芯片";
    rememberBoard(); updateHud();
  });
  dom.btnPan.addEventListener("click", () => {
    state.selectedType = state.selectedType === PAN ? null : PAN;
    updateToolbar();
  });
  dom.btnZoomIn.addEventListener("click", () => zoomCamera(1.25));
  dom.btnZoomOut.addEventListener("click", () => zoomCamera(0.8));
  dom.btnHome.addEventListener("click", () => {
    state.camera = state.shapeDraft ? { x: 0, y: 0, cell: 36 } : state.chipDraft || state.inspection
      ? { x: 4, y: 3, cell: 36 } : homeCamera(levels.getLevel(state.levelId));
    changeCamera(true);
  });
  dom.btnClear.addEventListener("click", requestClear);
  dom.btnPrismColors.addEventListener("click", cyclePrismColors);
  dom.btnUndo.addEventListener("click", undo);
  dom.btnRedo.addEventListener("click", redo);
  dom.btnSnapshots.addEventListener("click", showSnapshotSheet);
  dom.btnExport.addEventListener("click", exportCurrentLevel);
  dom.btnImport.addEventListener("click", () => dom.fileImport.click());
  dom.fileImport.addEventListener("change", () => {
    const file = dom.fileImport.files && dom.fileImport.files[0];
    dom.fileImport.value = ""; // 复位，同一个文件才能被再次选中
    if (!file) return;
    importLevelFile(file).catch((error) => {
      showErrors("导入失败", [String(error && error.message ? error.message : error)]);
    });
  });
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

  // 先读档再进关卡：selectLevel 会把该关上次的布局恢复出来
  store.load();
  state.stepMs = store.data.stepMs || simulationApi.STEP_MS;
  dom.stepSeconds.value = String(state.stepMs / 1000);
  state.stars = store.data.stars;

  resize();
  const session = store.data.session;
  selectLevel(session && levels.getLevel(session.levelId) ? session.levelId : levels.LEVELS[0].id);
  if (session && session.mode === "free") enterFreeMode();
  start();

  globalThis.__lightGame = {
    state,
    simulation,
    start,
    stop,
    resize,
    selectLevel,
    handleCell,
    rotateAt,
    removeAt,
    requestClear,
    undo,
    redo,
    showLevelList,
    starText,
  };
})();
