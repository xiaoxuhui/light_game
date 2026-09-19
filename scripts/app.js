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
  if (!core || !engine || !levels || !renderer || !storage) return;

  /** 存档仓库。localStorage 不可用时自动降级为内存存档，游戏照常可玩。 */
  const store = storage.createStore();

  const ERASER = "__eraser";

  /** 撤销栈上限。每个快照只是布局数组的浅拷贝，100 步既够用又不会无限吃内存。 */
  const MAX_HISTORY = 100;

  /** 「清空」的二次确认窗口：这段时间内不再点，就当作误触自动复位 */
  const CLEAR_CONFIRM_MS = 3000;

  const TYPE_NAMES = {
    mirror: "反射镜",
    splitter: "分光镜",
    prism: "棱镜",
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

  // 关于 prefers-reduced-motion：画布里没有任何时间驱动的动画（每帧都是静态绘制，
  // 静置时脏标记为假、一帧都不画），所以没有需要在 JS 里冻结的东西。
  // 唯一的动效是按钮过渡，由 styles/main.css 的媒体查询负责关掉。
  // 阶段 3 复查时删掉了原先那个只挂 change 监听、从不被读取的 matchMedia 变量 —— 它是死代码。

  const state = {
    levelId: null,
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

  /** 一次会写进撤销栈的改动：先记历史，再重算，最后落盘 */
  function commit() {
    pushHistory();
    refresh(false);
    rememberBoard();
  }

  /** 重算 + 刷 HUD + 重绘，不碰历史栈。silent = 通关时不弹结算浮层 */
  function refresh(silent) {
    recompute();
    updateHud();
    markDirty();
    checkCompletion(silent === true);
  }

  // ---------- 存档 ----------

  /**
   * 把当前关卡的布局写进存档并落盘。
   * 只留这一个写入点，撤销/重做也走它，避免出现「存档与画面不一致」。
   */
  function rememberBoard() {
    const level = currentLevel();
    if (!level) return;
    store.replace(storage.setBoard(store.data, level.id, state.placement));
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
    }));
  }

  function samePlacement(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (
        a[i].type !== b[i].type ||
        a[i].x !== b[i].x ||
        a[i].y !== b[i].y ||
        a[i].orient !== b[i].orient
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
    // 态数由元件决定：反射镜 / 分光镜 2 态，棱镜 3 态
    item.orient = core.cycleOrient(item.type, item.orient);
    commit();
  }

  function removeAt(x, y) {
    const index = state.placement.findIndex((item) => item.x === x && item.y === y);
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
    if (dom.btnClear.disabled) disarmClear();
    dom.btnUndo.disabled = !canUndo();
    dom.btnRedo.disabled = !canRedo();

    // 状态行承载两种反馈，按优先级拼接：
    //   1. 光路过载 —— 这是「显示可能不完整」，必须说清楚，否则玩家会以为关卡坏了
    //   2. 通关 —— 静默通关（进关时目标就已满足）没有结算浮层，只能靠这一行
    const overloaded = Boolean(state.result && state.result.overflow);
    const messages = [];
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
          state.placement = clonePlacement(item.placement);
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

    const text = storage.serializeLevelFile(level, state.placement);
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

  function selectLevel(id) {
    const level = levels.getLevel(id);
    if (!level) return;

    state.levelId = id;
    // 回到某关时接着上次的布局继续 —— 自动存档的意义就在这儿
    state.placement = clonePlacement(storage.getBoard(store.data, id));
    state.selectedType = null;
    state.cursor = null;
    state.hover = null;
    state.wasAllLit = false;

    buildToolbar(level);
    disarmClear();
    resetHistory();

    // 进入关卡时静默判定一次：教学第 1 关不放元件就已通关，不该立刻弹结算
    refresh(true);
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
  dom.btnClear.addEventListener("click", requestClear);
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
  state.stars = store.data.stars;

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
    requestClear,
    undo,
    redo,
    showLevelList,
    starText,
  };
})();
