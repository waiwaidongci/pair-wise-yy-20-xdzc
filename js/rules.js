/**
 * 席位规则模块（纯业务逻辑，不依赖 DOM / localStorage）
 *
 * 核心不变量：
 * 1. 同一排练厅、同一小节、同一种乐器，只能有一名有效乐师。
 * 2. 同一乐师同一小节（时段）不能在多个排练厅/席位上有效。
 * 3. 已确认席位不可被冲突请求改动；冲突请求只登记拒绝结果。
 * 4. 替班一律从下一小节起生效，须登记交接人并经接班乐师确认。
 * 5. 当前小节含独奏口令或速度偏离基准时，替班拒绝，整段转待重排。
 * 6. 到场记录更正后，依赖它的席位立即失效并重算；旧安排封存可查。
 */
globalThis.LuoguRules = (function () {
  "use strict";

  const instruments = [
    { name: "大锣", token: "仓", freq: 180 },
    { name: "鼓", token: "冬", freq: 120 },
    { name: "钹", token: "才", freq: 360 },
    { name: "小锣", token: "台", freq: 520 }
  ];
  const STEPS = 16;
  const BEATS_PER_MEASURE = 4;
  const MEASURES = [1, 2, 3, 4];
  const MEASURE_COUNT = 4;
  const TEMPO_TOLERANCE = 0.05; // 速度偏离基准超过 5% 即判定为偏离

  const halls = [
    { id: "h1", name: "一号排练厅" },
    { id: "h2", name: "二号排练厅" }
  ];

  const musicians = [
    { id: "m1", name: "周大锣", skills: [0] },
    { id: "m2", name: "孙鼓佬", skills: [1] },
    { id: "m3", name: "李钹", skills: [2] },
    { id: "m4", name: "钱小锣", skills: [3] },
    { id: "m5", name: "吴全堂", skills: [0, 1, 2, 3] },
    { id: "m6", name: "郑和声", skills: [1, 3] }
  ];

  function uid(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function now() {
    return new Date().toISOString();
  }

  function clonePattern(pattern) {
    return pattern.map((row) => [...row]);
  }

  function defaultPattern() {
    return instruments.map((instrument) =>
      Array.from({ length: STEPS }, (_, index) => (index % 4 === 0 ? instrument.token : ""))
    );
  }

  function seedAttendance() {
    // 初始：全体乐师四个小节均到场，到场记录是席位生效的依据
    return musicians.flatMap((musician) =>
      MEASURES.map((measure) => ({
        id: uid("att"),
        musicianId: musician.id,
        measure,
        present: true,
        history: []
      }))
    );
  }

  function createInitialState(overrides = {}) {
    return {
      version: 2,
      pieceName: overrides.pieceName ?? "出场锣鼓-慢起",
      bpm: overrides.bpm ?? 96,
      baselineBpm: overrides.baselineBpm ?? 96,
      loop: overrides.loop ?? "",
      notes: overrides.notes ? [...overrides.notes] : [],
      saved: overrides.saved ? overrides.saved.map((item) => ({ ...item })) : [],
      pattern: overrides.pattern ? clonePattern(overrides.pattern) : defaultPattern(),
      solo: overrides.solo
        ? clonePattern(overrides.solo)
        : instruments.map(() => Array(STEPS).fill(false)),
      currentHall: overrides.currentHall ?? "h1",
      currentMeasure: overrides.currentMeasure ?? 1,
      generation: 1,
      rearrangePending: false,
      rearrangeReasons: [],
      halls: halls.map((hall) => ({ ...hall })),
      musicians: musicians.map((musician) => ({ ...musician, skills: [...musician.skills] })),
      attendance: overrides.attendance
        ? overrides.attendance.map((record) => ({ ...record, history: record.history.map((h) => ({ ...h })) }))
        : seedAttendance(),
      seats: [],
      substitutions: [],
      conflicts: [],
      audit: []
    };
  }

  // ---------- 基础查询 ----------

  function hallOf(state, hallId) {
    return state.halls.find((hall) => hall.id === hallId);
  }

  function musicianOf(state, musicianId) {
    return state.musicians.find((musician) => musician.id === musicianId);
  }

  function hallName(state, hallId) {
    return hallOf(state, hallId)?.name ?? hallId;
  }

  function musicianName(state, musicianId) {
    return musicianOf(state, musicianId)?.name ?? musicianId;
  }

  function instrumentName(instrument) {
    return instruments[instrument]?.name ?? `乐器${instrument}`;
  }

  function attendanceRecord(state, musicianId, measure) {
    return state.attendance.find(
      (record) => record.musicianId === musicianId && record.measure === measure
    );
  }

  function isPresent(state, musicianId, measure) {
    const record = attendanceRecord(state, musicianId, measure);
    return !!record && record.present;
  }

  function measureHasSolo(state, measure) {
    const start = (measure - 1) * BEATS_PER_MEASURE;
    return state.solo.some((row, rowIndex) => {
      for (let step = start; step < start + BEATS_PER_MEASURE; step += 1) {
        if (state.pattern[rowIndex][step] && row[step]) return true;
      }
      return false;
    });
  }

  function tempoDeviated(state) {
    return Math.abs(state.bpm - state.baselineBpm) > state.baselineBpm * TEMPO_TOLERANCE;
  }

  function blockers(state, measure) {
    const reasons = [];
    const solo = measureHasSolo(state, measure);
    const tempo = tempoDeviated(state);
    if (solo) reasons.push(`第${measure}小节含独奏口令，须整段重排，不能只替换乐师`);
    if (tempo) {
      reasons.push(
        `速度${state.bpm}BPM 已偏离基准${state.baselineBpm}BPM，须整段重排，不能只替换乐师`
      );
    }
    return { solo, tempo, reasons };
  }

  // ---------- 审计 / 冲突登记 ----------

  function logConflict(state, kind, request, reasons) {
    state.conflicts.unshift({
      id: uid("cfl"),
      at: now(),
      kind,
      request,
      reasons: [...reasons]
    });
  }

  function logAudit(state, type, detail, snapshotBefore = null) {
    state.audit.unshift({
      id: uid("aud"),
      at: now(),
      type,
      detail,
      snapshot: snapshotBefore
    });
  }

  /** 对当前有效席位拍快照，供旧安排留存 */
  function takeSnapshot(state, active) {
    const map = active || evaluate(state).active;
    return [...map.values()].map((row) => ({
      hallId: row.hallId,
      measure: row.measure,
      instrument: row.instrument,
      musicianId: row.musicianId,
      kind: row.kind,
      substitutionId: row.substitutionId
    }));
  }

  // ---------- 席位重算（派生有效席位） ----------

  /**
   * @returns {active: Map<slotKey, seatRow>, status: Map<seatId, {active, reason}>}
   * 仅计算当前代（generation）席位；重排前代的席位保持封存失效状态。
   */
  function evaluate(state) {
    const active = new Map();
    const status = new Map();
    const rows = state.seats.filter((row) => row.generation === state.generation);

    const eligible = [];
    const rowsBySlot = new Map();

    for (const row of rows) {
      let reason = "";
      let ok = true;

      if (!isPresent(state, row.musicianId, row.measure)) {
        ok = false;
        reason =
          row.kind === "sub"
            ? `接班乐师第${row.measure}小节未到场`
            : `第${row.measure}小节到场记录更正为缺席，席位失效`;
      } else if (row.kind === "sub") {
        const sub = state.substitutions.find((item) => item.id === row.substitutionId);
        if (!sub || sub.status !== "confirmed") {
          ok = false;
          reason = "替班待接班乐师确认";
        } else if (row.measure < sub.effectiveMeasure) {
          ok = false;
          reason = `替班自第${sub.effectiveMeasure}小节起生效`;
        }
      }

      status.set(row.id, { active: false, reason });
      if (ok) {
        eligible.push(row);
        const key = slotKey(row);
        if (!rowsBySlot.has(key)) rowsBySlot.set(key, []);
        rowsBySlot.get(key).push(row);
      }
    }

    const bySlot = new Map();
    for (const row of eligible) {
      const key = slotKey(row);
      if (!bySlot.has(key)) bySlot.set(key, []);

      if (row.kind === "sub") {
        // 替班覆盖交接人的席位链；只有第三名乐师在该小节占住该席时，替班才不生效
        const sub = state.substitutions.find((item) => item.id === row.substitutionId);
        const foreign = (rowsBySlot.get(key) || []).some(
          (other) => other.kind === "normal" && other.musicianId !== sub.handoverId
        );
        if (foreign) {
          status.set(row.id, {
            active: false,
            reason: `第${row.measure}小节席位已由其他乐师确认，替班不生效`
          });
          continue;
        }
      }
      bySlot.get(key).push(row);
    }

    const slotOrder = [...bySlot.keys()].sort((a, b) => {
      const [ha, ma, ia] = a.split("|");
      const [hb, mb, ib] = b.split("|");
      const haIdx = state.halls.findIndex((hall) => hall.id === ha);
      const hbIdx = state.halls.findIndex((hall) => hall.id === hb);
      const cmp = haIdx - hbIdx || Number(ma) - Number(mb) || Number(ia) - Number(ib);
      return cmp !== 0 ? cmp : a < b ? -1 : 1;
    });

    const busy = new Map(); // musicianId:measure -> slotKey
    for (const key of slotOrder) {
      const candidates = bySlot.get(key).sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "sub" ? -1 : 1; // 替班优先覆盖正席
        if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
        return a.id < b.id ? -1 : 1;
      });

      let chosen = null;
      for (const candidate of candidates) {
        const busyKey = `${candidate.musicianId}:${candidate.measure}`;
        if (busy.has(busyKey)) {
          status.set(candidate.id, {
            active: false,
            reason: "同一乐师同一时段已占用另一排练厅席位"
          });
          continue;
        }
        chosen = candidate;
        break;
      }

      if (chosen) {
        busy.set(`${chosen.musicianId}:${chosen.measure}`, key);
        active.set(key, chosen);
        status.set(chosen.id, { active: true, reason: "" });
      }

      for (const candidate of candidates) {
        if (candidate === chosen) continue;
        const current = status.get(candidate.id);
        if (current.reason) continue;
        status.set(candidate.id, {
          active: false,
          reason: chosen && chosen.kind === "sub"
            ? "临时替班进行中，由替班乐师担任"
            : "同一乐师同一时段已有席位"
        });
      }
    }

    return { active, status };
  }

  function slotKey(row) {
    return `${row.hallId}|${row.measure}|${row.instrument}`;
  }

  /** 重算并把结果写回各行（带状态变迁记录），旧状态保留在 transitions 中可查 */
  function recompute(state) {
    const { status } = evaluate(state);
    for (const row of state.seats) {
      const derived =
        row.generation === state.generation
          ? status.get(row.id) || { active: false, reason: "席位无依据" }
          : { active: false, reason: "整段已重排，旧安排封存" };
      const next = derived.active ? "confirmed" : "invalidated";
      if (row.status !== next || row.reason !== derived.reason) {
        row.transitions.push({
          at: now(),
          from: row.status || "new",
          to: next,
          reason: derived.reason
        });
        row.status = next;
        row.reason = derived.reason;
      }
    }
  }

  function activeSeatAt(state, hallId, measure, instrument) {
    return evaluate(state).active.get(`${hallId}|${measure}|${instrument}`) || null;
  }

  function activeSeats(state) {
    return [...evaluate(state).active.values()];
  }

  // ---------- 请求：绑定席位 ----------

  function reject(state, kind, request, reasons) {
    logConflict(state, kind, request, reasons);
    return { ok: false, reasons };
  }

  function bindSeat(state, rawInput) {
    const input = {
      hallId: String(rawInput.hallId || ""),
      measure: Number(rawInput.measure),
      instrument: Number(rawInput.instrument),
      musicianId: String(rawInput.musicianId || "")
    };

    if (state.rearrangePending) {
      return reject(state, "席位绑定", input, ["整段待重排：请先执行重排，重排前不再改动席位"]);
    }
    const hall = hallOf(state, input.hallId);
    const musician = musicianOf(state, input.musicianId);
    if (!hall || !MEASURES.includes(input.measure) || !(input.instrument in instruments) || !musician) {
      return reject(state, "席位绑定", input, ["请求参数不合法"]);
    }
    if (!musician.skills.includes(input.instrument)) {
      return reject(state, "席位绑定", input, [
        `${musician.name}不司${instrumentName(input.instrument)}，不能绑定该席位`
      ]);
    }

    const { active } = evaluate(state);
    const key = `${input.hallId}|${input.measure}|${input.instrument}`;
    const existing = active.get(key);
    if (existing) {
      if (existing.musicianId === input.musicianId) return { ok: true, duplicated: true };
      return reject(state, "席位绑定", input, [
        `${hall.name}第${input.measure}小节${instrumentName(input.instrument)}席位已确认由${musicianName(
          state,
          existing.musicianId
        )}担任，拒绝改动已确认席位`
      ]);
    }

    const record = attendanceRecord(state, input.musicianId, input.measure);
    if (!record || !record.present) {
      return reject(state, "席位绑定", input, [
        `${musician.name}第${input.measure}小节无到场记录（登记为缺席），不能绑定席位`
      ]);
    }

    for (const row of active.values()) {
      if (row.measure === input.measure && row.musicianId === input.musicianId) {
        return reject(state, "席位绑定", input, [
          `${musician.name}第${input.measure}小节已在${hallName(state, row.hallId)}担任${instrumentName(
            row.instrument
          )}，同一时段不能占用多个排练厅`
        ]);
      }
    }

    const row = {
      id: uid("seat"),
      generation: state.generation,
      hallId: input.hallId,
      measure: input.measure,
      instrument: input.instrument,
      musicianId: input.musicianId,
      kind: "normal",
      substitutionId: null,
      status: "",
      reason: "",
      createdAt: now(),
      transitions: []
    };
    state.seats.push(row);
    recompute(state);
    logAudit(
      state,
      "seat",
      `${hall.name} · 第${input.measure}小节 · ${instrumentName(input.instrument)} 正席确认 → ${musician.name}`
    );
    return { ok: true };
  }

  // ---------- 请求：临时替班 ----------

  function requestSubstitute(state, rawInput) {
    const input = {
      hallId: String(rawInput.hallId || ""),
      measure: Number(rawInput.measure),
      instrument: Number(rawInput.instrument),
      musicianId: String(rawInput.musicianId || "")
    };
    const hall = hallOf(state, input.hallId);
    const substitute = musicianOf(state, input.musicianId);
    if (!hall || !MEASURES.includes(input.measure) || !(input.instrument in instruments) || !substitute) {
      return reject(state, "临时替班", input, ["请求参数不合法"]);
    }

    if (state.rearrangePending) {
      return reject(state, "临时替班", input, ["整段待重排：请先执行重排，不能只替换乐师"]);
    }

    // 阻断条件优先：独奏口令 / 速度偏离 → 整段待重排（不产生任何替班记录）
    const blocking = blockers(state, input.measure);
    if (blocking.reasons.length) {
      state.rearrangePending = true;
      state.rearrangeReasons = blocking.reasons.slice();
      reject(state, "临时替班", input, blocking.reasons);
      logAudit(
        state,
        "blocked",
        `第${input.measure}小节${instrumentName(input.instrument)}申请替班被阻断，整段转为待重排：${blocking.reasons.join(
          "；"
        )}`,
        takeSnapshot(state)
      );
      return { ok: false, reasons: blocking.reasons, rearrange: true };
    }

    if (!substitute.skills.includes(input.instrument)) {
      return reject(state, "临时替班", input, [
        `${substitute.name}不司${instrumentName(input.instrument)}，不能接班`
      ]);
    }

    const effectiveMeasure = input.measure + 1;
    if (effectiveMeasure > MEASURE_COUNT) {
      return reject(state, "临时替班", input, [
        `第${input.measure}小节已是末小节，替班须从下一小节起生效，无处接班`
      ]);
    }

    const { active } = evaluate(state);
    const current = active.get(`${input.hallId}|${input.measure}|${input.instrument}`);
    if (!current) {
      return reject(state, "临时替班", input, [
        `第${input.measure}小节${instrumentName(input.instrument)}没有已确认席位，无从交接，请走重排`
      ]);
    }
    if (current.musicianId === input.musicianId) {
      return reject(state, "临时替班", input, ["接班乐师与当前乐师相同，无需替班"]);
    }

    const chainBusy = state.substitutions.some(
      (sub) =>
        sub.hallId === input.hallId &&
        sub.instrument === input.instrument &&
        (sub.status === "awaiting" ||
          (sub.status === "confirmed" && sub.effectiveMeasure <= effectiveMeasure))
    );
    if (chainBusy) {
      return reject(state, "临时替班", input, ["该席位已有待确认或已生效的替班安排"]);
    }

    // 对下一小节起的每个小节预校验：到场 + 同时段排练厅占用 + 他人已确认席位
    for (let measure = effectiveMeasure; measure <= MEASURE_COUNT; measure += 1) {
      if (!isPresent(state, substitute.id, measure)) {
        return reject(state, "临时替班", input, [
          `${substitute.name}第${measure}小节无到场记录，不能接班`
        ]);
      }
      for (const row of active.values()) {
        const sameSlot =
          row.hallId === input.hallId &&
          row.measure === measure &&
          row.instrument === input.instrument;
        if (row.measure === measure && row.musicianId === substitute.id && !sameSlot) {
          return reject(state, "临时替班", input, [
            `${substitute.name}第${measure}小节已在${hallName(state, row.hallId)}担任${instrumentName(
              row.instrument
            )}，同一时段不能占用多个排练厅`
          ]);
        }
        if (sameSlot && row.musicianId !== current.musicianId && row.musicianId !== substitute.id) {
          return reject(state, "临时替班", input, [
            `第${measure}小节该席位已由${musicianName(state, row.musicianId)}确认，替班无法覆盖`
          ]);
        }
      }
    }

    const substitution = {
      id: uid("sub"),
      hallId: input.hallId,
      instrument: input.instrument,
      handoverId: current.musicianId,
      substituteId: substitute.id,
      requestMeasure: input.measure,
      effectiveMeasure,
      status: "awaiting",
      createdAt: now(),
      confirmedAt: null
    };
    state.substitutions.push(substitution);
    logAudit(
      state,
      "sub-request",
      `${hall.name} · ${instrumentName(input.instrument)}：${musicianName(
        state,
        current.musicianId
      )}申请交接给${substitute.name}，自第${effectiveMeasure}小节起，待接班确认`
    );
    return { ok: true, substitutionId: substitution.id, awaiting: true };
  }

  /** 接班乐师确认：复核仍可接班后，自下一小节起逐小节生成替班席位 */
  function confirmSubstitution(state, rawInput) {
    const substitutionId = rawInput.substitutionId || rawInput.id;
    const substitution = state.substitutions.find((item) => item.id === substitutionId);
    if (!substitution || substitution.status !== "awaiting") {
      return reject(state, "接班确认", rawInput, ["替班申请不存在或已处理"]);
    }
    if (state.rearrangePending) {
      return reject(state, "接班确认", rawInput, ["整段待重排，接班确认暂不受理"]);
    }

    const input = {
      hallId: substitution.hallId,
      measure: substitution.requestMeasure,
      instrument: substitution.instrument,
      musicianId: substitution.substituteId
    };
    const { active } = evaluate(state);
    const reasons = [];
    for (let measure = substitution.effectiveMeasure; measure <= MEASURE_COUNT; measure += 1) {
      if (!isPresent(state, substitution.substituteId, measure)) {
        reasons.push(
          `${musicianName(state, substitution.substituteId)}第${measure}小节无到场记录`
        );
      }
      for (const row of active.values()) {
        const sameSlot =
          row.hallId === substitution.hallId &&
          row.measure === measure &&
          row.instrument === substitution.instrument;
        if (row.measure === measure && row.musicianId === substitution.substituteId && !sameSlot) {
          reasons.push(
            `${musicianName(state, substitution.substituteId)}第${measure}小节已占用${hallName(
              state,
              row.hallId
            )}席位`
          );
        }
      }
    }
    if (reasons.length) {
      return reject(state, "接班确认", input, reasons);
    }

    substitution.status = "confirmed";
    substitution.confirmedAt = now();
    for (let measure = substitution.effectiveMeasure; measure <= MEASURE_COUNT; measure += 1) {
      state.seats.push({
        id: uid("seat"),
        generation: state.generation,
        hallId: substitution.hallId,
        measure,
        instrument: substitution.instrument,
        musicianId: substitution.substituteId,
        kind: "sub",
        substitutionId: substitution.id,
        status: "",
        reason: "",
        createdAt: now(),
        transitions: []
      });
    }
    recompute(state);
    logAudit(
      state,
      "sub-confirm",
      `${hallName(state, substitution.hallId)} · ${instrumentName(
        substitution.instrument
      )}：${musicianName(state, substitution.substituteId)}已确认接班，自第${
        substitution.effectiveMeasure
      }小节起生效；交接人：${musicianName(state, substitution.handoverId)}`
    );
    return { ok: true };
  }

  // ---------- 到场记录更正 → 依赖席位失效并重算 ----------

  function markAttendance(state, rawInput) {
    const musicianId = String(rawInput.musicianId || "");
    const measure = Number(rawInput.measure);
    const present = !!rawInput.present;
    const musician = musicianOf(state, musicianId);
    if (!musician || !MEASURES.includes(measure)) return { ok: false, reasons: ["参数不合法"] };

    let record = attendanceRecord(state, musicianId, measure);
    if (!record) {
      record = { id: uid("att"), musicianId, measure, present, history: [] };
      state.attendance.push(record);
      recompute(state);
      return { ok: true, changed: false };
    }
    if (record.present === present) return { ok: true, changed: false };

    const before = takeSnapshot(state);
    const from = record.present;
    record.present = present;
    record.history.push({ at: now(), from, to: present });

    recompute(state);

    // 比对重算前后的有效席位，给出失效/恢复明细
    const after = takeSnapshot(state);
    const beforeMap = new Map(before.map((item) => [`${item.hallId}|${item.measure}|${item.instrument}`, item]));
    const afterMap = new Map(after.map((item) => [`${item.hallId}|${item.measure}|${item.instrument}`, item]));
    const changes = [];
    for (const [key, item] of beforeMap) {
      const next = afterMap.get(key);
      if (!next) {
        changes.push(
          `${hallName(state, item.hallId)}第${item.measure}小节${instrumentName(item.instrument)}席位失效`
        );
      } else if (next.musicianId !== item.musicianId || next.kind !== item.kind) {
        changes.push(
          `${hallName(state, item.hallId)}第${item.measure}小节${instrumentName(
            item.instrument
          )}重算为${musicianName(state, next.musicianId)}${next.kind === "sub" ? "（替班）" : ""}`
        );
      }
    }
    for (const [key, item] of afterMap) {
      if (!beforeMap.has(key)) {
        changes.push(
          `${hallName(state, item.hallId)}第${item.measure}小节${instrumentName(
            item.instrument
          )}恢复由${musicianName(state, item.musicianId)}${item.kind === "sub" ? "（替班）" : ""}担任`
        );
      }
    }

    logAudit(
      state,
      "attendance",
      `${musician.name}第${measure}小节到场记录更正：${from ? "到场" : "缺席"} → ${
        present ? "到场" : "缺席"
      }；依赖席位已立即失效并重算${changes.length ? "：" + changes.join("；") : "（席位无变化）"}`,
      before
    );
    return { ok: true, changed: true, changes };
  }

  // ---------- 重排 ----------

  function executeRearrange(state) {
    const before = takeSnapshot(state); // 先留存重排前的有效安排
    for (const row of state.seats) {
      if (row.generation === state.generation && row.status !== "invalidated") {
        row.transitions.push({ at: now(), from: row.status, to: "invalidated", reason: "整段重排，旧安排封存" });
      }
      if (row.generation === state.generation) {
        row.status = "invalidated";
        row.reason = "整段重排，旧安排封存";
      }
    }
    for (const sub of state.substitutions) {
      if (sub.status === "awaiting" || sub.status === "confirmed") {
        sub.status = "voided";
        sub.voidedAt = now();
      }
    }
    const oldGeneration = state.generation;
    state.generation += 1;
    state.rearrangePending = false;
    state.rearrangeReasons = [];
    logAudit(
      state,
      "rearrange",
      `执行整段重排：第${oldGeneration}代席位与替班链全部封存，开始重新排班`,
      before
    );
    return { ok: true };
  }

  // ---------- 独奏口令 ----------

  function setSolo(state, rawInput) {
    const row = Number(rawInput.row);
    const step = Number(rawInput.step);
    const solo = !!rawInput.solo;
    if (!(row in instruments) || step < 0 || step >= STEPS) return { ok: false, reasons: ["位置不合法"] };
    if (solo && !state.pattern[row][step]) {
      return { ok: false, reasons: ["独奏口令必须标注在有锣鼓字的节拍上"] };
    }
    state.solo[row][step] = solo;
    return { ok: true };
  }

  // ---------- 乐师履历（派生） ----------

  function musicianResume(state, musicianId) {
    const musician = musicianOf(state, musicianId);
    if (!musician) return null;

    const corrections = [];
    for (const att of state.attendance) {
      if (att.musicianId !== musicianId) continue;
      for (const change of att.history) {
        corrections.push({
          at: change.at,
          measure: att.measure,
          from: change.from,
          to: change.to
        });
      }
    }
    corrections.sort((a, b) => (a.at < b.at ? 1 : -1));

    const seats = state.seats
      .filter((row) => row.musicianId === musicianId)
      .map((row) => ({
        generation: row.generation,
        hallId: row.hallId,
        measure: row.measure,
        instrument: row.instrument,
        kind: row.kind,
        status: row.status,
        reason: row.reason,
        createdAt: row.createdAt
      }))
      .sort((a, b) => a.generation - b.generation || a.measure - b.measure || a.instrument - b.instrument);

    const substitutions = state.substitutions
      .filter((sub) => sub.handoverId === musicianId || sub.substituteId === musicianId)
      .map((sub) => ({
        id: sub.id,
        role: sub.handoverId === musicianId ? "handover" : "substitute",
        hallId: sub.hallId,
        instrument: sub.instrument,
        otherId: sub.handoverId === musicianId ? sub.substituteId : sub.handoverId,
        requestMeasure: sub.requestMeasure,
        effectiveMeasure: sub.effectiveMeasure,
        status: sub.status,
        createdAt: sub.createdAt,
        confirmedAt: sub.confirmedAt
      }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    return { musician, corrections, seats, substitutions };
  }

  return {
    instruments,
    STEPS,
    BEATS_PER_MEASURE,
    MEASURES,
    MEASURE_COUNT,
    TEMPO_TOLERANCE,
    halls,
    musicians,
    createInitialState,
    measureHasSolo,
    tempoDeviated,
    blockers,
    activeSeatAt,
    activeSeats,
    bindSeat,
    requestSubstitute,
    confirmSubstitution,
    markAttendance,
    executeRearrange,
    setSolo,
    musicianResume,
    hallName,
    musicianName,
    instrumentName
  };
})();
