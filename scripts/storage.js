"use strict";

// 存档、工作台快照与关卡文件读写。
//
// 职责边界：
//   · localStorage 读写；不可用时降级为内存存档（隐私模式 / 存储被禁 / file:// 受限）
//   · 存档结构带 schema + version，为后续格式变更留迁移位
//   · 具名工作台快照，对应 RAX「存一下」的能力
//   · downloadFile() 是所有导出的唯一出口 —— 安卓阶段只替换这一个函数
//
// 两条硬约束（见 doc/需求与测试用例.md 一、4 工程约束）：
//   · 绝不信任外部文件：导入一律走 LightLevels 完整校验，任一项不过则整体拒绝，不做部分导入
//   · 读写失败不抛异常打断游戏，一律返回 { ok, errors } 交给调用方提示
//
// 变换函数一律「返回新对象、不改入参」，这样单测里比较往返结果最省事。

(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.LightStorage = api;
  }
})(globalThis, function (root) {
  const isNode = typeof module === "object" && module.exports;
  const core = isNode ? require("./light-core.js") : root.LightCore;
  const levels = isNode ? require("./levels.js") : root.LightLevels;

  const SAVE_SCHEMA = "light-game/save";
  const SAVE_VERSION = 1;
  const STORAGE_KEY = "light-game/save";
  const MAX_SNAPSHOTS = 20;
  const MAX_NAME_LENGTH = 24;
  const MAX_UNITS = levels.MAX_UNITS;

  // ---------- 存储后端 ----------

  /** 内存后备：localStorage 不可用时顶上，保证游戏本身照常可玩，只是关掉页面就没了 */
  function createMemoryBackend() {
    const map = new Map();
    return {
      getItem(key) {
        return map.has(key) ? map.get(key) : null;
      },
      setItem(key, value) {
        map.set(key, String(value));
      },
      removeItem(key) {
        map.delete(key);
      },
      get length() {
        return map.size;
      },
    };
  }

  /** 探测可用的 localStorage；受限环境回落到内存后端，而不是让游戏崩在启动阶段 */
  function detectBackend() {
    try {
      const storage = root.localStorage;
      if (!storage) return createMemoryBackend();
      const probe = STORAGE_KEY + "/probe";
      storage.setItem(probe, "1");
      storage.removeItem(probe);
      return storage;
    } catch {
      return createMemoryBackend();
    }
  }

  // ---------- 布局规范化 ----------

  const isInt = (value) => typeof value === "number" && Number.isInteger(value);

  /** 逐项过滤非法元件，只保留能进网格的那些。用于读档 / 导入的兜底。 */
  function normalizePlacement(list) {
    const out = [];
    if (!Array.isArray(list)) return out;

    for (const item of list) {
      if (out.length >= MAX_UNITS) break;
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      if (core.PLACEABLE_TYPES.indexOf(item.type) === -1) continue;
      if (!isInt(item.x) || !isInt(item.y) || item.x < 0 || item.y < 0) continue;
      out.push({
        type: item.type,
        x: item.x,
        y: item.y,
        orient: item.orient === core.ORIENT.BACKSLASH ? core.ORIENT.BACKSLASH : core.ORIENT.SLASH,
      });
    }

    return out;
  }

  // ---------- 存档结构 ----------

  function emptySave() {
    return {
      schema: SAVE_SCHEMA,
      version: SAVE_VERSION,
      stars: {},
      boards: {},
      snapshots: [],
    };
  }

  /**
   * 规范化一份存档。逐字段校验，坏字段丢弃而不是整体报废 ——
   * 存档损坏时尽量保住还能用的部分。
   */
  function normalizeSave(raw) {
    const save = emptySave();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return save;

    if (raw.stars && typeof raw.stars === "object" && !Array.isArray(raw.stars)) {
      for (const id of Object.keys(raw.stars)) {
        const value = raw.stars[id];
        if (isInt(value) && value > 0 && value <= 3) save.stars[id] = value;
      }
    }

    if (raw.boards && typeof raw.boards === "object" && !Array.isArray(raw.boards)) {
      for (const id of Object.keys(raw.boards)) {
        const board = normalizePlacement(raw.boards[id]);
        if (board.length > 0) save.boards[id] = board;
      }
    }

    if (Array.isArray(raw.snapshots)) {
      for (const item of raw.snapshots) {
        const entry = normalizeSnapshot(item);
        if (!entry) continue;
        save.snapshots.push(entry);
        if (save.snapshots.length >= MAX_SNAPSHOTS) break;
      }
    }

    return save;
  }

  /**
   * 版本迁移。当前只有 v1，未来格式变更时在这里按 version 逐级升级：
   *   let version = raw.version;
   *   while (version < SAVE_VERSION) { raw = upgradeFrom(version, raw); version += 1; }
   * schema 不符、版本非正整数、或版本高于当前实现（无法安全解释）一律返回空存档。
   */
  function migrate(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptySave();
    if (raw.schema !== SAVE_SCHEMA) return emptySave();
    if (!isInt(raw.version) || raw.version < 1) return emptySave();
    if (raw.version > SAVE_VERSION) return emptySave();
    return normalizeSave(raw);
  }

  function serializeSave(save) {
    return JSON.stringify(normalizeSave(save));
  }

  /** 解析存档文本。任何解析或结构问题都退化为空存档，绝不抛给调用方。 */
  function parseSave(text) {
    if (typeof text !== "string" || text.length === 0) return emptySave();
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return emptySave();
    }
    return migrate(raw);
  }

  // ---------- 存档变换（纯函数） ----------

  /** 记录最好成绩。返回新存档与「是否刷新了记录」。 */
  function updateStars(save, levelId, stars) {
    const next = normalizeSave(save);
    const previous = next.stars[levelId] || 0;
    const value = Math.max(0, Math.min(3, isInt(stars) ? stars : 0));

    if (value > previous) {
      next.stars[levelId] = value;
      return { save: next, improved: true, best: value };
    }
    return { save: next, improved: false, best: previous };
  }

  /** 写入某关的当前布局；布局为空则清除该关记录 */
  function setBoard(save, levelId, placement) {
    const next = normalizeSave(save);
    const board = normalizePlacement(placement);
    if (board.length > 0) next.boards[levelId] = board;
    else delete next.boards[levelId];
    return next;
  }

  function getBoard(save, levelId) {
    const board = save && save.boards ? save.boards[levelId] : null;
    return Array.isArray(board) ? normalizePlacement(board) : [];
  }

  // ---------- 工作台快照 ----------

  function normalizeSnapshot(item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;

    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name || name.length > MAX_NAME_LENGTH) return null;

    const levelId = typeof item.levelId === "string" ? item.levelId : "";
    if (!levelId) return null;

    const placement = normalizePlacement(item.placement);
    if (placement.length === 0) return null;

    return {
      name,
      levelId,
      placement,
      savedAt: typeof item.savedAt === "string" ? item.savedAt : "",
    };
  }

  /** 新增或覆盖同名快照；超出上限时挤掉最旧的一条 */
  function addSnapshot(save, entry) {
    const next = normalizeSave(save);
    const errors = [];

    const name = entry && typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) errors.push("快照名不能为空");
    else if (name.length > MAX_NAME_LENGTH) {
      errors.push("快照名不得超过 " + MAX_NAME_LENGTH + " 个字符");
    }

    const placement = normalizePlacement(entry ? entry.placement : null);
    if (placement.length === 0) errors.push("当前没有可保存的元件");

    if (errors.length > 0) return { ok: false, save: next, errors };

    const item = {
      name,
      levelId: entry && typeof entry.levelId === "string" ? entry.levelId : "",
      placement,
      savedAt: entry && typeof entry.savedAt === "string" ? entry.savedAt : "",
    };

    const index = next.snapshots.findIndex((existing) => existing.name === name);
    if (index === -1) next.snapshots.push(item);
    else next.snapshots[index] = item;

    while (next.snapshots.length > MAX_SNAPSHOTS) next.snapshots.shift();

    return { ok: true, save: next, errors: [] };
  }

  function removeSnapshot(save, name) {
    const next = normalizeSave(save);
    next.snapshots = next.snapshots.filter((item) => item.name !== name);
    return next;
  }

  function getSnapshot(save, name) {
    if (!save || !Array.isArray(save.snapshots)) return null;
    for (const item of save.snapshots) {
      if (item.name === name) return item;
    }
    return null;
  }

  // ---------- 关卡文件 ----------

  const LEVEL_FIELDS = Object.freeze([
    "schema",
    "version",
    "id",
    "title",
    "chapter",
    "cols",
    "rows",
    "par",
    "fixed",
    "targets",
    "inventory",
    "hint",
  ]);

  /**
   * 导出关卡文件：关卡定义 + 玩家布局。
   * 布局走 placement 字段，与关卡定义共用同一份 schema，导入端能一并校验。
   */
  function serializeLevelFile(level, placement) {
    const payload = {};
    for (const field of LEVEL_FIELDS) {
      if (level[field] !== undefined) payload[field] = level[field];
    }
    payload.placement = normalizePlacement(placement);
    return JSON.stringify(payload, null, 2);
  }

  function levelFileName(level) {
    return String((level && level.id) || "level") + ".json";
  }

  /** 导入关卡文件。任一项校验不通过则整体拒绝，不做部分导入。 */
  function parseLevelFile(text) {
    const fail = (errors) => ({ ok: false, errors, level: null, placement: [] });

    if (typeof text !== "string" || text.trim().length === 0) {
      return fail(["文件内容为空"]);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      return fail(["文件不是合法的 JSON：" + (error && error.message ? error.message : "")]);
    }

    const levelCheck = levels.validateLevel(data);
    if (!levelCheck.ok) return fail(levelCheck.errors);

    const placement = Array.isArray(data.placement) ? data.placement : [];
    const placementCheck = levels.validatePlacement(data, placement);
    if (!placementCheck.ok) return fail(placementCheck.errors);

    return {
      ok: true,
      errors: [],
      level: data,
      placement: normalizePlacement(placement),
    };
  }

  /**
   * 所有导出的唯一出口。安卓 WebView 不支持 Blob + <a download>，
   * 届时整体换成 JS 桥调用即可，调用点不必改。
   */
  /** 读出 Blob 的文本：优先 Blob.text()，老 WebView 回退 FileReader。读不到时回调 null */
  function readBlobText(blob, onDone) {
    if (blob && typeof blob.text === "function") {
      blob.text().then(onDone, () => onDone(null));
      return;
    }
    if (typeof root.FileReader !== "function") {
      onDone(null);
      return;
    }
    const reader = new root.FileReader();
    reader.onload = () => onDone(String(reader.result || ""));
    reader.onerror = () => onDone(null);
    reader.readAsText(blob);
  }

  /** 浏览器原生下载路径（Blob URL + <a download>） */
  function browserDownload(name, blob) {
    if (!root.document || typeof root.URL === "undefined") return false;

    const url = root.URL.createObjectURL(blob);
    const anchor = root.document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.rel = "noopener";
    root.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    // 交给下一轮事件循环再释放，避免部分浏览器在下载启动前就让地址失效
    root.setTimeout(() => root.URL.revokeObjectURL(url), 0);
    return true;
  }

  /**
   * 导出的唯一出口。
   *
   * 安卓外壳的 WebView 不支持 Blob + <a download>（会静默失败），因此先探测原生注入的
   * LightAndroid 桥，命中就把文本交给它写入系统下载目录。调用点完全不需要区分平台 ——
   * 这正是把所有导出收敛到这一个函数的意义。
   */
  function downloadFile(name, blob) {
    const bridge = root.LightAndroid;
    if (bridge && typeof bridge.saveFile === "function") {
      readBlobText(blob, (text) => {
        if (typeof text !== "string") return;
        try {
          bridge.saveFile(name, text);
        } catch {
          // 桥异常时原生侧会给出失败提示；WebView 里浏览器下载本就不可用，无需回退
        }
      });
      return true;
    }
    return browserDownload(name, blob);
  }

  // ---------- 带 I/O 的薄封装 ----------

  /**
   * 存档仓库。backend 可注入（单测用内存后端），缺省自动探测 localStorage。
   * @returns {{available: boolean, data: object, lastError: string, load, persist, reset, replace}}
   */
  function createStore(options) {
    const settings = options || {};
    const backend = settings.backend || detectBackend();

    let data = emptySave();
    let lastError = "";

    function record(error) {
      lastError = String(error && error.message ? error.message : error);
    }

    return {
      backend,
      get available() {
        return Boolean(backend);
      },
      get data() {
        return data;
      },
      get lastError() {
        return lastError;
      },
      load() {
        if (!backend) return data;
        try {
          data = parseSave(backend.getItem(STORAGE_KEY));
        } catch (error) {
          record(error);
          data = emptySave();
        }
        return data;
      },
      persist() {
        if (!backend) return false;
        try {
          backend.setItem(STORAGE_KEY, serializeSave(data));
          return true;
        } catch (error) {
          record(error);
          return false;
        }
      },
      replace(next) {
        data = normalizeSave(next);
        return data;
      },
      reset() {
        data = emptySave();
        return data;
      },
    };
  }

  return {
    SAVE_SCHEMA,
    SAVE_VERSION,
    STORAGE_KEY,
    MAX_SNAPSHOTS,
    MAX_NAME_LENGTH,
    createMemoryBackend,
    detectBackend,
    normalizePlacement,
    normalizeSnapshot,
    emptySave,
    normalizeSave,
    migrate,
    serializeSave,
    parseSave,
    updateStars,
    setBoard,
    getBoard,
    addSnapshot,
    removeSnapshot,
    getSnapshot,
    serializeLevelFile,
    levelFileName,
    parseLevelFile,
    downloadFile,
    createStore,
  };
});
