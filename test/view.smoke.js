/**
 * 视图模块冒烟测试（最小 DOM 桩）：node test/view.smoke.js
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeElement(tag = "div") {
  return {
    tagName: String(tag).toUpperCase(),
    innerHTML: "",
    textContent: "",
    value: "",
    className: "",
    checked: false,
    disabled: false,
    dataset: {},
    _listeners: {},
    _elListeners: {},
    classList: {
      add() {},
      remove() {},
      contains() {
        return false;
      }
    },
    addEventListener(type, fn) {
      (this._elListeners[type] ||= []).push(fn);
    },
    dispatch(type, event = {}) {
      (this._elListeners[type] || []).forEach((fn) => fn.call(this, { target: this, ...event }));
    },
    closest() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
}

const elements = [
  "grid", "savedList", "structure", "notesList", "pieceName", "bpmInput",
  "baselineText", "resetTempoBtn", "hallSelect", "measureSelect", "loopSelect",
  "noteInput", "soloMode", "banner", "toast", "seatBoard", "boardHallName",
  "rearrangeBtn", "pendingList", "conflictList", "clearConflictsBtn", "roster",
  "saveBtn", "playBtn", "stopBtn"
];
const els = Object.fromEntries(elements.map((id) => [id, makeElement("input")]));
els.grid = makeElement();
els.savedList = makeElement();
els.structure = makeElement();
els.notesList = makeElement();
els.baselineText = makeElement();
els.banner = makeElement();
els.toast = makeElement();
els.seatBoard = makeElement();
els.boardHallName = makeElement();
els.pendingList = makeElement();
els.conflictList = makeElement();
els.roster = makeElement();
els.rearrangeBtn = makeElement("button");
els.resetTempoBtn = makeElement("button");
els.clearConflictsBtn = makeElement("button");
els.saveBtn = makeElement("button");

const storeMap = {};
const sandbox = {
  console,
  Date,
  Math,
  JSON,
  crypto: { randomUUID: () => `id-${Math.random().toString(36).slice(2)}` },
  setTimeout: (fn) => 0,
  clearTimeout() {},
  setInterval: () => 0,
  clearInterval() {},
  document: {
    _ready: [],
    addEventListener(type, fn) {
      if (type === "DOMContentLoaded") this._ready.push(fn);
    },
    fireReady() {
      this._ready.forEach((fn) => fn());
    },
    querySelector(selector) {
      const id = selector.replace("#", "");
      return els[id] || null;
    },
    querySelectorAll() {
      return [];
    },
    activeElement: null
  },
  localStorage: {
    getItem: (key) => storeMap[key] ?? null,
    setItem: (key, value) => {
      storeMap[key] = value;
    }
  }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "rules.js"), "utf8"), sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "store.js"), "utf8"), sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "view.js"), "utf8"), sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8"), sandbox);

sandbox.document.fireReady();

const R = sandbox.LuoguRules;
const S = sandbox.LuoguStore;

// 渲染已完成
assert.ok(els.grid.innerHTML.includes("大锣"));
assert.ok(els.seatBoard.innerHTML.includes("空席"));
assert.ok(els.banner.className.includes("hidden"));

// 模拟确认席位后重新渲染
R.bindSeat(S.getState(), { hallId: "h1", measure: 1, instrument: 0, musicianId: "m1" });
S.save();
assert.ok(els.seatBoard.innerHTML.includes("周大锣"));
assert.ok(els.roster.innerHTML.includes("周大锣"));

// 速度偏离 → 横幅出现警告
S.update((draft) => {
  draft.bpm = 120;
});
assert.ok(els.banner.className.includes("warn"));

// 标注独奏（第2小节）并切到当前小节 2 → 横幅预警
S.update((draft) => {
  draft.bpm = 96;
  draft.currentMeasure = 2;
});
R.setSolo(S.getState(), { row: 0, step: 4, solo: true });
S.save();
assert.ok(els.banner.className.includes("warn"));
R.requestSubstitute(S.getState(), { hallId: "h1", measure: 2, instrument: 0, musicianId: "m5" });
S.save();
assert.ok(els.banner.className.includes("danger"));
assert.ok(els.conflictList.innerHTML.includes("拒绝"));

// 重排按钮解禁并可执行；重排后解除待重排（danger 消失，独奏软预警可保留）
assert.equal(els.rearrangeBtn.disabled, false);
R.executeRearrange(S.getState());
S.save();
assert.ok(!els.banner.className.includes("danger"));
assert.equal(els.rearrangeBtn.disabled, true);

// 持久化
assert.ok(storeMap[S.STORAGE_KEY]);
console.log("视图冒烟测试通过：初始化渲染、绑定/冲突/阻断/重排展示与持久化均正常。");
