/**
 * 规则模块闭环测试：node test/rules.test.js
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// 在 Node 中按浏览器方式加载 rules.js
const code = fs.readFileSync(path.join(__dirname, "..", "js", "rules.js"), "utf8");
const sandbox = { globalThis: {} };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const Rules = sandbox.LuoguRules;

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const { m1, m2, m3, m4, m5, m6 } = Object.fromEntries(
  ["m1", "m2", "m3", "m4", "m5", "m6"].map((id) => [id, id])
);

// 乐师：周大锣[大锣] 孙鼓佬[鼓] 李钹[钹] 钱小锣[小锣] 吴全堂[全能] 郑和声[鼓,小锣]
function fresh() {
  return Rules.createInitialState();
}

console.log("席位绑定与冲突");

test("正常绑定正席成功", () => {
  const s = fresh();
  const r = Rules.bindSeat(s, { hallId: "h1", measure: 1, instrument: 0, musicianId: m1 });
  assert.ok(r.ok);
  const seat = Rules.activeSeatAt(s, "h1", 1, 0);
  assert.equal(seat.musicianId, "m1");
  assert.equal(seat.kind, "normal");
});

test("同一小节同一乐器只能绑定一名乐师：第二次绑定被拒绝且不改已确认席位", () => {
  const s = fresh();
  Rules.bindSeat(s, { hallId: "h1", measure: 1, instrument: 0, musicianId: m1 });
  const r = Rules.bindSeat(s, { hallId: "h1", measure: 1, instrument: 0, musicianId: m5 });
  assert.ok(!r.ok);
  assert.match(r.reasons[0], /已确认/);
  assert.equal(Rules.activeSeatAt(s, "h1", 1, 0).musicianId, "m1");
  assert.equal(s.conflicts.length, 1);
  assert.equal(s.conflicts[0].kind, "席位绑定");
});

test("同一乐师同一时段不能占用多个排练厅：跨厅占用被拒绝", () => {
  const s = fresh();
  Rules.bindSeat(s, { hallId: "h1", measure: 1, instrument: 0, musicianId: m1 });
  const r = Rules.bindSeat(s, { hallId: "h2", measure: 1, instrument: 0, musicianId: m1 });
  assert.ok(!r.ok);
  assert.match(r.reasons[0], /多个排练厅/);
  assert.equal(Rules.activeSeatAt(s, "h2", 1, 0), null);
});

test("同厅不同乐器也会因同时段一人一席被拒绝（全能乐师）", () => {
  const s = fresh();
  Rules.bindSeat(s, { hallId: "h1", measure: 1, instrument: 0, musicianId: m5 });
  const r = Rules.bindSeat(s, { hallId: "h1", measure: 1, instrument: 2, musicianId: m5 });
  assert.ok(!r.ok);
});

test("不司该乐器不能绑定，冲突仅登记拒绝结果", () => {
  const s = fresh();
  const r = Rules.bindSeat(s, { hallId: "h1", measure: 1, instrument: 0, musicianId: m2 });
  assert.ok(!r.ok);
  assert.match(r.reasons[0], /不司/);
  assert.equal(s.seats.length, 0);
  assert.equal(s.conflicts.length, 1);
});

console.log("临时替班闭环");

test("替班申请成功后为待确认，当前小节仍由原乐师担任", () => {
  const s = fresh();
  Rules.bindSeat(s, { hallId: "h1", measure: 1, instrument: 1, musicianId: m2 });
  const r = Rules.requestSubstitute(s, { hallId: "h1", measure: 1, instrument: 1, musicianId: m5 });
  assert.ok(r.ok);
  assert.equal(r.awaiting, true);
  assert.equal(Rules.activeSeatAt(s, "h1", 1, 1).musicianId, "m2");
});

test("接班确认后自下一小节起生效，原小节不动", () => {
  const s = fresh();
  for (const measure of [1, 2, 3, 4]) {
    Rules.bindSeat(s, { hallId: "h1", measure, instrument: 1, musicianId: m2 });
  }
  const req = Rules.requestSubstitute(s, { hallId: "h1", measure: 1, instrument: 1, musicianId: m5 });
  const c = Rules.confirmSubstitution(s, { id: req.substitutionId });
  assert.ok(c.ok);
  assert.equal(Rules.activeSeatAt(s, "h1", 1, 1).musicianId, "m2"); // 交接人仍在当前小节
  for (const measure of [2, 3, 4]) {
    assert.equal(Rules.activeSeatAt(s, "h1", measure, 1).musicianId, "m5");
    assert.equal(Rules.activeSeatAt(s, "h1", measure, 1).kind, "sub");
  }
  const sub = s.substitutions.find((x) => x.id === req.substitutionId);
  assert.equal(sub.status, "confirmed");
  assert.equal(sub.handoverId, "m2"); // 交接人已登记
  assert.ok(sub.confirmedAt);
});

test("待确认替班不改变席位：未经接班确认不生效", () => {
  const s = fresh();
  Rules.bindSeat(s, { hallId: "h1", measure: 2, instrument: 3, musicianId: m4 });
  Rules.requestSubstitute(s, { hallId: "h1", measure: 2, instrument: 3, musicianId: m6 });
  assert.equal(Rules.activeSeatAt(s, "h1", 2, 3).musicianId, "m4");
  assert.equal(Rules.activeSeatAt(s, "h1", 3, 3), null);
});

test("当前小节含独奏口令：替班拒绝且整段转待重排，不能只替换乐师", () => {
  const s = fresh();
  Rules.bindSeat(s, { hallId: "h1", measure: 2, instrument: 0, musicianId: m1 });
  // 第2小节（step 4..7）大锣行 step4 有口令，标注独奏
  const solo = Rules.setSolo(s, { row: 0, step: 4, solo: true });
  assert.ok(solo.ok);
  const r = Rules.requestSubstitute(s, { hallId: "h1", measure: 2, instrument: 0, musicianId: m5 });
  assert.ok(!r.ok);
  assert.equal(r.rearrange, true);
  assert.equal(s.rearrangePending, true);
  assert.match(s.rearrangeReasons[0], /独奏/);
  // 待重排期间任何席位/替班请求都拒绝
  const blocked = Rules.bindSeat(s, { hallId: "h2", measure: 1, instrument: 2, musicianId: m3 });
  assert.ok(!blocked.ok);
  assert.match(blocked.reasons[0], /待重排/);
  // 原席位保持确认
  assert.equal(Rules.activeSeatAt(s, "h1", 2, 0).musicianId, "m1");
  assert.equal(s.substitutions.length, 0);
});

test("速度偏离基准超过5%：替班拒绝且整段转待重排", () => {
  const s = fresh();
  s.bpm = 104; // 基准96，偏差 8.3%
  Rules.bindSeat(s, { hallId: "h1", measure: 1, instrument: 2, musicianId: m3 });
  const r = Rules.requestSubstitute(s, { hallId: "h1", measure: 1, instrument: 2, musicianId: m5 });
  assert.ok(!r.ok);
  assert.equal(r.rearrange, true);
  assert.match(s.rearrangeReasons.join(""), /偏离基准/);
  assert.equal(s.rearrangePending, true);
});

test("速度恰好偏离5%以内不阻断", () => {
  const s = fresh();
  s.bpm = 100; // 4.17%
  Rules.bindSeat(s, { hallId: "h1", measure: 1, instrument: 2, musicianId: m3 });
  const r = Rules.requestSubstitute(s, { hallId: "h1", measure: 1, instrument: 2, musicianId: m5 });
  assert.ok(r.ok);
});

test("独奏标注必须落在有锣鼓字的节拍上", () => {
  const s = fresh();
  const r = Rules.setSolo(s, { row: 0, step: 1, solo: true });
  assert.ok(!r.ok);
});

console.log("重排");

test("执行重排后旧席位全部封存失效，代次推进，可重新排班", () => {
  const s = fresh();
  Rules.bindSeat(s, { hallId: "h1", measure: 1, instrument: 0, musicianId: m1 });
  const req = Rules.requestSubstitute(s, { hallId: "h1", measure: 1, instrument: 0, musicianId: m5 });
  Rules.confirmSubstitution(s, { id: req.substitutionId });
  // 阻断条件出现后整段待重排（独奏口令 + 偏离速度）
  Rules.setSolo(s, { row: 0, step: 4, solo: true });
  s.bpm = 120;
  const blocked = Rules.requestSubstitute(s, { hallId: "h1", measure: 2, instrument: 1, musicianId: m2 });
  assert.ok(!blocked.ok && blocked.rearrange);
  Rules.executeRearrange(s);
  assert.equal(s.rearrangePending, false);
  assert.equal(s.generation, 2);
  assert.equal(Rules.activeSeatAt(s, "h1", 1, 0), null);
  assert.equal(s.substitutions[0].status, "voided");
  // 旧安排保留可查
  const old = s.seats.find((row) => row.musicianId === "m1");
  assert.equal(old.status, "invalidated");
  assert.equal(old.generation, 1);
  assert.match(old.reason, /封存/);
  assert.ok(s.audit.some((a) => a.type === "rearrange" && a.snapshot.length >= 1));
  assert.ok(s.audit.some((a) => a.type === "rearrange" &&
    a.snapshot.some((row) => row.musicianId === "m1" && row.kind === "normal") &&
    a.snapshot.some((row) => row.musicianId === "m5" && row.kind === "sub")));
  // 重新排班
  const again = Rules.bindSeat(s, { hallId: "h1", measure: 1, instrument: 0, musicianId: m5 });
  assert.ok(again.ok);
  assert.equal(Rules.activeSeatAt(s, "h1", 1, 0).musicianId, "m5");
});

console.log("到场记录更正 → 失效重算");

test("原乐师标记缺席：依赖席位立即失效，可自下一小节由替班接续", () => {
  const s = fresh();
  for (const measure of [1, 2, 3, 4]) {
    Rules.bindSeat(s, { hallId: "h1", measure, instrument: 1, musicianId: m2 });
  }
  const req = Rules.requestSubstitute(s, { hallId: "h1", measure: 1, instrument: 1, musicianId: m5 });
  Rules.confirmSubstitution(s, { id: req.substitutionId });
  // 更正：接班乐师吴全堂第2小节缺席 → 替班席位立即失效，交接人正席因缺席与否另行判定
  Rules.markAttendance(s, { musicianId: m2, measure: 2, present: true }); // 交接人默认到场
  const r = Rules.markAttendance(s, { musicianId: m5, measure: 2, present: false });
  assert.ok(r.ok);
  assert.equal(r.changed, true);
  // 第2小节替班失效，正席（孙鼓佬到场）恢复
  assert.equal(Rules.activeSeatAt(s, "h1", 2, 1).musicianId, "m2");
  assert.equal(Rules.activeSeatAt(s, "h1", 2, 1).kind, "normal");
  // 第3、4小节替班仍有效
  assert.equal(Rules.activeSeatAt(s, "h1", 3, 1).musicianId, "m5");
  assert.equal(Rules.activeSeatAt(s, "h1", 4, 1).musicianId, "m5");
  // 旧状态保留在 transitions
  const invalidRow = s.seats.find((row) => row.kind === "sub" && row.measure === 2);
  assert.equal(invalidRow.status, "invalidated");
  assert.match(invalidRow.reason, /未到场/);
  assert.ok(invalidRow.transitions.length >= 1);
  // 缺席状态下不能重新绑定该乐师
  const retry = Rules.bindSeat(s, { hallId: "h1", measure: 2, instrument: 1, musicianId: m5 });
  assert.ok(!retry.ok);
});

test("到场记录更正回到场：席位立即重算恢复", () => {
  const s = fresh();
  Rules.bindSeat(s, { hallId: "h1", measure: 1, instrument: 0, musicianId: m1 });
  Rules.markAttendance(s, { musicianId: m1, measure: 1, present: false });
  assert.equal(Rules.activeSeatAt(s, "h1", 1, 0), null);
  Rules.markAttendance(s, { musicianId: m1, measure: 1, present: true });
  assert.equal(Rules.activeSeatAt(s, "h1", 1, 0).musicianId, "m1");
  // 更正历史保留
  const resume = Rules.musicianResume(s, "m1");
  assert.equal(resume.corrections.length, 2);
});

test("替班期间原乐师缺席不影响替班，原乐师恢复到场不抢占替班期", () => {
  const s = fresh();
  for (const measure of [1, 2, 3, 4]) {
    Rules.bindSeat(s, { hallId: "h1", measure, instrument: 3, musicianId: m4 });
  }
  const req = Rules.requestSubstitute(s, { hallId: "h1", measure: 1, instrument: 3, musicianId: m6 });
  Rules.confirmSubstitution(s, { id: req.substitutionId });
  // 钱小锣第3小节缺席：第3小节由郑和声替班，仍有效
  Rules.markAttendance(s, { musicianId: m4, measure: 3, present: false });
  assert.equal(Rules.activeSeatAt(s, "h1", 3, 3).musicianId, "m6");
  // 钱小锣第3小节恢复：第3小节仍是替班（替班覆盖正席）
  Rules.markAttendance(s, { musicianId: m4, measure: 3, present: true });
  assert.equal(Rules.activeSeatAt(s, "h1", 3, 3).musicianId, "m6");
  const normalRow = s.seats.find((row) => row.kind === "normal" && row.measure === 3 && row.musicianId === "m4");
  assert.equal(normalRow.status, "invalidated");
  assert.match(normalRow.reason, /替班/);
});

console.log("跨厅冲突的替班防护");

test("替班接班乐师未来小节在另一厅有席位：申请被拒绝", () => {
  const s = fresh();
  Rules.bindSeat(s, { hallId: "h1", measure: 1, instrument: 1, musicianId: m2 });
  // 吴全堂第3小节在二号厅已占鼓席
  Rules.bindSeat(s, { hallId: "h2", measure: 3, instrument: 1, musicianId: m5 });
  const r = Rules.requestSubstitute(s, { hallId: "h1", measure: 1, instrument: 1, musicianId: m5 });
  assert.ok(!r.ok);
  assert.match(r.reasons[0], /多个排练厅/);
});

test("替班自末小节申请被拒绝（无下一小节）", () => {
  const s = fresh();
  Rules.bindSeat(s, { hallId: "h1", measure: 4, instrument: 0, musicianId: m1 });
  const r = Rules.requestSubstitute(s, { hallId: "h1", measure: 4, instrument: 0, musicianId: m5 });
  assert.ok(!r.ok);
  assert.match(r.reasons[0], /末小节/);
});

console.log("履历与一致性");

test("乐师履历包含正席、替班交接、到场更正全部记录", () => {
  const s = fresh();
  Rules.bindSeat(s, { hallId: "h1", measure: 1, instrument: 1, musicianId: m2 });
  const req = Rules.requestSubstitute(s, { hallId: "h1", measure: 1, instrument: 1, musicianId: m5 });
  Rules.confirmSubstitution(s, { id: req.substitutionId });
  Rules.markAttendance(s, { musicianId: m2, measure: 2, present: false });
  const resume = Rules.musicianResume(s, "m2");
  assert.ok(resume.seats.some((row) => row.measure === 1 && row.kind === "normal"));
  assert.ok(resume.substitutions.some((sub) => sub.role === "handover"));
  assert.equal(resume.corrections.length, 1);
  assert.equal(resume.corrections[0].to, false);
});

test("冲突请求全部进冲突清单，且不产生席位/替班副作用", () => {
  const s = fresh();
  Rules.bindSeat(s, { hallId: "h1", measure: 1, instrument: 0, musicianId: m1 });
  const bad1 = Rules.bindSeat(s, { hallId: "h1", measure: 1, instrument: 0, musicianId: m5 });
  const bad2 = Rules.bindSeat(s, { hallId: "h1", measure: 2, instrument: 0, musicianId: m2 });
  assert.ok(!bad1.ok && !bad2.ok);
  assert.equal(s.conflicts.length, 2);
  assert.equal(s.seats.length, 1);
});

console.log(`\n全部 ${passed} 项测试通过。`);
