/**
 * 存储模块持久化测试：刷新后席位、冲突清单与乐师履历一致。
 * node test/store.test.js
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadContext(storeMap) {
  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: (key) => (key in storeMap ? storeMap[key] : null),
      setItem: (key, value) => {
        storeMap[key] = String(value);
      },
      removeItem: (key) => {
        delete storeMap[key];
      }
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "rules.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "js", "store.js"), "utf8"), sandbox);
  return sandbox;
}

// 1) 完整操作流写入
const storeMap = {};
let ctx = loadContext(storeMap);
const R1 = ctx.LuoguRules;
const S1 = ctx.LuoguStore;

R1.bindSeat(S1.getState(), { hallId: "h1", measure: 1, instrument: 0, musicianId: "m1" });
R1.bindSeat(S1.getState(), { hallId: "h2", measure: 1, instrument: 0, musicianId: "m1" }); // 跨厅冲突
const req = R1.requestSubstitute(S1.getState(), {
  hallId: "h1",
  measure: 1,
  instrument: 0,
  musicianId: "m5"
});
R1.confirmSubstitution(S1.getState(), { id: req.substitutionId });
R1.markAttendance(S1.getState(), { musicianId: "m1", measure: 4, present: false });
S1.save();
S1.update((draft) => {
  draft.pieceName = "夜深沉-快板";
});

const persisted = JSON.parse(storeMap[S1.STORAGE_KEY]);
assert.equal(persisted.version, 2);
assert.equal(persisted.pieceName, "夜深沉-快板");
assert.equal(persisted.seats.length, 4); // 1 正席 + 3 替班行；冲突请求不产生席位

// 2) 模拟刷新：用同一份 localStorage 重新加载模块
ctx = loadContext(storeMap);
const R2 = ctx.LuoguRules;
const S2 = ctx.LuoguStore;
const s = S2.getState();

assert.equal(s.pieceName, "夜深沉-快板");
assert.equal(R2.activeSeatAt(s, "h1", 1, 0).musicianId, "m1");
assert.equal(R2.activeSeatAt(s, "h1", 2, 0).musicianId, "m5");
assert.equal(R2.activeSeatAt(s, "h1", 3, 0).musicianId, "m5");
// 第4小节：交接人缺席，替班行仍以接班乐师生效（接班乐师到场）
assert.equal(R2.activeSeatAt(s, "h1", 4, 0).musicianId, "m5");
// 二号厅席位从未确认
assert.equal(R2.activeSeatAt(s, "h2", 1, 0), null);
// 冲突清单保留
assert.equal(s.conflicts.length, 1);
assert.equal(s.conflicts[0].kind, "席位绑定");
// 履历一致
const resume = R2.musicianResume(s, "m1");
assert.ok(resume.seats.length >= 1);
assert.equal(resume.corrections.length, 1);
assert.ok(resume.substitutions.some((sub) => sub.role === "handover" && sub.status === "confirmed"));

// 3) 旧版本（v1 纯格子数据）自动迁移
const v1 = {
  pieceName: "旧锣鼓",
  bpm: 88,
  loop: "",
  notes: ["老批注"],
  pattern: R2.instruments.map(() => Array(16).fill("")),
  saved: []
};
const v1Map = { [S2.STORAGE_KEY]: JSON.stringify(v1) };
const v1ctx = loadContext(v1Map);
const migrated = v1ctx.LuoguStore.getState();
assert.equal(migrated.version, 2);
assert.equal(migrated.pieceName, "旧锣鼓");
assert.equal(migrated.bpm, 88);
assert.equal(migrated.notes[0], "老批注");
assert.equal(migrated.attendance.length, 24); // 6 乐师 × 4 小节
assert.equal(migrated.seats.length, 0);
assert.equal(v1ctx.LuoguRules.activeSeats(migrated).length, 0);

console.log("存储模块测试通过：刷新后席位、冲突清单、乐师履历一致，旧数据自动迁移。");
