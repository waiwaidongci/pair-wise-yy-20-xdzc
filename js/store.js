/**
 * 记录存储模块：localStorage 持久化、旧版本迁移、订阅通知。
 * 所有业务变更只经过 getState/update + LuoguRules，页面刷新后席位、
 * 冲突清单与乐师履历从同一份记录派生，保持一致。
 */
globalThis.LuoguStore = (function () {
  "use strict";

  const STORAGE_KEY = "wxyy-4-luogujing-grid";
  const Rules = globalThis.LuoguRules;

  function readRaw() {
    try {
      const text = globalThis.localStorage?.getItem(STORAGE_KEY);
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  function writeRaw(data) {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* 存储不可用时仅保留内存态 */
    }
  }

  /** 旧版本（纯锣鼓格子 v1）数据迁移为 v2 排班记录 */
  function migrate(raw) {
    if (!raw || typeof raw !== "object") return Rules.createInitialState();
    if (raw.version === 2) return normalize(raw);
    // v1：保留剧目、速度、循环、批注、已存方案与锣鼓格子；排班相关字段全新生成
    const initial = Rules.createInitialState({
      pieceName: raw.pieceName,
      bpm: typeof raw.bpm === "number" ? raw.bpm : undefined,
      loop: raw.loop ?? "",
      notes: Array.isArray(raw.notes) ? raw.notes : [],
      saved: Array.isArray(raw.saved) ? raw.saved : [],
      pattern: Array.isArray(raw.pattern) ? raw.pattern : undefined
    });
    initial.version = 2;
    return initial;
  }

  /** 补齐新版本字段，容错外部直接改过的 localStorage */
  function normalize(raw) {
    const base = Rules.createInitialState(raw);
    const keys = [
      "version",
      "pieceName",
      "bpm",
      "baselineBpm",
      "loop",
      "notes",
      "saved",
      "pattern",
      "solo",
      "currentHall",
      "currentMeasure",
      "generation",
      "rearrangePending",
      "rearrangeReasons",
      "halls",
      "musicians",
      "attendance",
      "seats",
      "substitutions",
      "conflicts",
      "audit"
    ];
    for (const key of keys) {
      if (key in raw) base[key] = raw[key];
    }
    return base;
  }

  let state = migrate(readRaw());

  const listeners = new Set();

  function getState() {
    return state;
  }

  function save() {
    writeRaw(state);
    for (const listener of listeners) listener(state);
  }

  /** 在同一事务内修改状态并持久化、通知视图 */
  function update(mutator) {
    mutator(state);
    save();
    return state;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function reset(newState) {
    state = newState ? migrate(newState) : Rules.createInitialState();
    save();
  }

  return { STORAGE_KEY, getState, save, update, subscribe, reset };
})();
