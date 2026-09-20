// 记录存储模块：localStorage 中的事件流水与锣鼓谱状态，负责追加、归档留存与读取。
// 所有席位事实只存在 ledger 里（append-only），席位/冲突/履历均由规则模块回放得到，刷新后天然一致。

import { instruments, STEPS, derive } from "./seat-rules.js";

const STORAGE_KEY = "wxyy-4-luogujing-grid";

function emptySolo() {
  return instruments.map(() => Array.from({ length: STEPS }, () => false));
}

const defaultState = () => ({
  version: 2,
  pieceName: "出场锣鼓-慢起",
  bpm: 96,
  baseBpm: 96,
  loop: "",
  notes: [],
  currentSlot: 1,
  solo: emptySolo(),
  pattern: instruments.map((instrument) =>
    Array.from({ length: STEPS }, (_, index) => (index % 4 === 0 ? instrument.token : ""))
  ),
  saved: [],
  ledger: [] // 席位/替班/到场/拒绝/重排的完整流水
});

export const store = {
  state: null,

  load() {
    let parsed = null;
    try {
      parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch {
      parsed = null;
    }
    // v1 数据没有席位相关字段，先记下基准速度再与默认值合并
    const incomingBaseBpm = parsed && Object.prototype.hasOwnProperty.call(parsed, "baseBpm")
      ? parsed.baseBpm
      : (parsed?.bpm || null);
    const state = { ...defaultState(), ...(parsed || {}) };
    // v1 -> v2 迁移：补齐席位相关字段
    state.version = 2;
    if (!state.ledger) state.ledger = [];
    if (incomingBaseBpm != null) state.baseBpm = incomingBaseBpm;
    if (!state.currentSlot) state.currentSlot = 1;
    if (!Array.isArray(state.solo) || state.solo.length !== instruments.length) state.solo = emptySolo();
    state.solo = state.solo.map((row) => {
      const next = Array.from({ length: STEPS }, (_, i) => Boolean(row?.[i]));
      return next;
    });
    this.state = state;
    return state;
  },

  persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
  },

  saveScore() {
    this.persist();
  },

  // 保存锣鼓方案（含独奏口令与基准速度）
  saveScheme() {
    this.state.saved.unshift({
      id: crypto.randomUUID(),
      name: this.state.pieceName || "未命名片段",
      bpm: this.state.bpm,
      baseBpm: this.state.baseBpm,
      loop: this.state.loop,
      notes: [...this.state.notes],
      pattern: this.state.pattern.map((row) => [...row]),
      solo: this.state.solo.map((row) => [...row]),
      createdAt: new Date().toISOString()
    });
    this.persist();
  },

  loadScheme(item) {
    Object.assign(this.state, {
      pieceName: item.name,
      bpm: item.bpm,
      baseBpm: item.baseBpm || item.bpm || this.state.baseBpm,
      loop: item.loop,
      notes: [...item.notes],
      pattern: item.pattern.map((row) => [...row]),
      solo: Array.isArray(item.solo) && item.solo.length === instruments.length
        ? item.solo.map((row) => [...row])
        : emptySolo()
    });
    this.persist();
  },

  derived() {
    return derive(this.state.ledger);
  },

  // 追加一条或一批事件（拒绝事件也同样入流水，作为冲突清单依据）
  append(events) {
    if (!Array.isArray(events)) events = [events];
    for (const ev of events) this.state.ledger.push(ev);
    this.persist();
  },

  newId() {
    return crypto.randomUUID();
  }
};
