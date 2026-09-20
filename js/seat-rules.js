// 席位规则模块：乐器/乐师/排练厅配置，以及全部席位业务规则（纯函数，不做持久化与 DOM 操作）
// 时段(slot)与小节一一对应：第 1~4 小节即四个排练时段。

export const instruments = [
  { id: "daluo", name: "大锣", token: "仓", freq: 180 },
  { id: "gu", name: "鼓", token: "冬", freq: 120 },
  { id: "bo", name: "钹", token: "才", freq: 360 },
  { id: "xiaoluo", name: "小锣", token: "台", freq: 520 }
];

export const STEPS = 16;
export const BEATS_PER_MEASURE = 4;
export const MEASURES = [1, 2, 3, 4];
export const SLOTS = MEASURES.map((slot) => ({ slot, label: `第${slot}小节` }));

// 速度偏离基准的容忍区间：±10% 以内视为正常
export const TEMPO_TOLERANCE = 0.1;

export const halls = [
  { id: "A", name: "一号排练厅" },
  { id: "B", name: "二号排练厅" }
];

export const musicians = [
  { id: "zhou", name: "周鸿声" },
  { id: "li", name: "李鼓田" },
  { id: "wang", name: "王钹才" },
  { id: "jin", name: "金台生" },
  { id: "zhao", name: "赵全德" },
  { id: "qian", name: "钱慎之" }
];

const instrumentMap = new Map(instruments.map((item) => [item.id, item]));
const musicianMap = new Map(musicians.map((item) => [item.id, item]));
const hallMap = new Map(halls.map((item) => [item.id, item]));

export const instrumentName = (id) => instrumentMap.get(id)?.name || id;
export const musicianName = (id) => musicianMap.get(id)?.name || id;
export const hallName = (id) => hallMap.get(id)?.name || id;
export const slotLabel = (slot) => `第${slot}小节`;

export const seatKey = (hallId, slot, instrumentId) => `${hallId}|${slot}|${instrumentId}`;
export const attendanceKey = (musicianId, slot) => `${musicianId}|${slot}`;

// ---- 基础判定 ----

export function tempoDeviated(bpm, baseBpm) {
  if (!baseBpm) return false;
  return Math.abs(bpm - baseBpm) / baseBpm > TEMPO_TOLERANCE;
}

export function measureHasSolo(solo, slot) {
  const start = (slot - 1) * BEATS_PER_MEASURE;
  return solo.some((row) => row.slice(start, start + BEATS_PER_MEASURE).some(Boolean));
}

// ---- 事件流水回放：派生出当前席位、旧档、待确认替班、厅状态、到场记录 ----

export function derive(ledger) {
  const seats = new Map(); // key -> 当前有效席位
  const archive = []; // 失效/被交接/重排归档的旧席位，保留可查
  const pending = new Map(); // subId -> 待接班确认的替班登记
  const hallStatus = new Map(); // hallId -> { status, reasons, at }
  const attendance = new Map(); // musician|slot -> { present, recordId, history }
  const rejections = [];

  const archiveSeat = (seat, reason, at, eventId) => {
    archive.push({ ...seat, status: "archived", endReason: reason, endedAt: at, endEvent: eventId });
  };

  for (const ev of ledger) {
    switch (ev.type) {
      case "attendance-recorded":
      case "attendance-corrected": {
        const key = attendanceKey(ev.musicianId, ev.slot);
        const prev = attendance.get(key);
        const history = prev ? [...prev.history] : [];
        if (ev.type === "attendance-corrected") {
          history.push({ from: ev.from, to: ev.to, at: ev.at, by: ev.by });
        }
        attendance.set(key, { present: ev.type === "attendance-recorded" ? ev.present : ev.to, recordId: ev.attendanceId, updatedAt: ev.at, history });
        break;
      }
      case "seat-confirmed": {
        const key = seatKey(ev.hallId, ev.slot, ev.instrumentId);
        const existing = seats.get(key);
        if (existing) archiveSeat(existing, "席位重派", ev.at, ev.id);
        seats.set(key, {
          id: ev.seatId,
          hallId: ev.hallId,
          slot: ev.slot,
          instrumentId: ev.instrumentId,
          musicianId: ev.musicianId,
          kind: "正式",
          since: ev.at
        });
        break;
      }
      case "substitute-registered": {
        pending.set(ev.subId, { ...ev, confirmed: false });
        break;
      }
      case "substitute-confirmed": {
        const sub = pending.get(ev.subId);
        if (!sub) break;
        pending.set(ev.subId, { ...sub, confirmed: true, confirmedAt: ev.at });
        for (const slot of MEASURES.filter((item) => item >= sub.effectiveSlot)) {
          const key = seatKey(sub.hallId, slot, sub.instrumentId);
          const current = seats.get(key);
          if (current && current.musicianId !== sub.toMusicianId) {
            archiveSeat(current, `替班交接：${sub.handoverBy} 交接，${musicianName(sub.toMusicianId)} 接班`, ev.at, ev.id);
          }
          if (!current || current.musicianId !== sub.toMusicianId) {
            seats.set(key, {
              id: `${ev.subId}:${slot}`,
              hallId: sub.hallId,
              slot,
              instrumentId: sub.instrumentId,
              musicianId: sub.toMusicianId,
              kind: "替班",
              since: ev.at,
              viaSubId: ev.subId,
              handoverBy: sub.handoverBy
            });
          }
        }
        break;
      }
      case "substitute-cancelled": {
        pending.delete(ev.subId);
        break;
      }
      case "seat-invalidated": {
        const key = seatKey(ev.hallId, ev.slot, ev.instrumentId);
        const current = seats.get(key);
        if (current && current.musicianId === ev.musicianId) {
          archiveSeat(current, ev.reason, ev.at, ev.id);
          seats.delete(key);
        }
        break;
      }
      case "seat-recomputed": {
        if (ev.mode === "reinstate") {
          const key = seatKey(ev.hallId, ev.slot, ev.instrumentId);
          if (!seats.has(key)) {
            seats.set(key, {
              id: ev.seatId,
              hallId: ev.hallId,
              slot: ev.slot,
              instrumentId: ev.instrumentId,
              musicianId: ev.musicianId,
              kind: ev.kind || "正式",
              since: ev.at,
              recomputed: true
            });
          }
        }
        break;
      }
      case "rearrange-required": {
        hallStatus.set(ev.hallId, { status: "pending", reasons: ev.reasons, at: ev.at });
        break;
      }
      case "rearrange-resolved": {
        for (const [key, seat] of seats) {
          if (seat.hallId === ev.hallId) {
            archiveSeat(seat, "整段待重排，旧席位归档", ev.at, ev.id);
            seats.delete(key);
          }
        }
        hallStatus.set(ev.hallId, { status: "normal", at: ev.at });
        break;
      }
      case "request-rejected": {
        rejections.push(ev);
        break;
      }
      default:
        break;
    }
  }

  return { seats, archive, pending, hallStatus, attendance, rejections };
}

export function activeSeat(derived, hallId, slot, instrumentId) {
  return derived.seats.get(seatKey(hallId, slot, instrumentId)) || null;
}

// 乐师在某一时段的全部占用（跨排练厅）
export function occupancyAt(derived, musicianId, slot) {
  const result = [];
  for (const seat of derived.seats.values()) {
    if (seat.musicianId === musicianId && seat.slot === slot) result.push(seat);
  }
  return result;
}

export function getRejections(ledger) {
  return ledger.filter((ev) => ev.type === "request-rejected");
}

// ---- 事件构造小工具 ----

function rejectEvent(ctx, category, hallId, slot, reason, extra = {}) {
  return { type: "request-rejected", id: ctx.uid(), at: ctx.now, category, hallId, slot, reason, ...extra };
}

function blockedReasons(state, slot) {
  const reasons = [];
  if (measureHasSolo(state.solo, slot)) reasons.push("solo");
  if (tempoDeviated(state.bpm, state.baseBpm)) reasons.push("tempo");
  return reasons;
}

const reasonText = {
  solo: "当前小节含独奏口令",
  tempo: "速度已偏离基准"
};

// ---- 业务动作：均返回 { ok, message, events }；拒绝时 events 里只有拒绝记录，不动已确认席位 ----

// 绑定席位：某厅当前小节的某种乐器 ← 某乐师
export function requestBindSeat(state, input, ctx) {
  const { hallId, slot, instrumentId, musicianId } = input;
  const d = derive(state.ledger);
  const status = d.hallStatus.get(hallId);
  if (status?.status === "pending") {
    return {
      ok: false,
      message: "本厅整段待重排，须先执行重排，不能调整席位。",
      events: [rejectEvent(ctx, "bind", hallId, slot, "整段待重排中，暂停派位", { instrumentId, musicianId })]
    };
  }

  const occupied = activeSeat(d, hallId, slot, instrumentId);
  if (occupied) {
    return {
      ok: false,
      message: `${slotLabel(slot)}${instrumentName(instrumentId)}已绑定${musicianName(occupied.musicianId)}，已确认席位不可改动。`,
      events: [rejectEvent(ctx, "bind", hallId, slot, `乐器在本小节已有乐师（${musicianName(occupied.musicianId)}）`, { instrumentId, musicianId })]
    };
  }

  const mine = occupancyAt(d, musicianId, slot);
  if (mine.length) {
    const other = mine[0];
    const crossHall = other.hallId !== hallId;
    return {
      ok: false,
      message: `${musicianName(musicianId)}在${slotLabel(slot)}已占用${hallName(other.hallId)}的${instrumentName(other.instrumentId)}席位${crossHall ? "（跨排练厅）" : ""}，不能重复派位。`,
      events: [rejectEvent(ctx, "bind", hallId, slot, `同一时段已在${hallName(other.hallId)}担任${instrumentName(other.instrumentId)}`, { instrumentId, musicianId })]
    };
  }

  const record = d.attendance.get(attendanceKey(musicianId, slot));
  if (record && !record.present) {
    return {
      ok: false,
      message: `${musicianName(musicianId)}在${slotLabel(slot)}登记为缺席，不能绑定席位。`,
      events: [rejectEvent(ctx, "bind", hallId, slot, "乐师该时段登记为缺席", { instrumentId, musicianId })]
    };
  }

  const events = [];
  if (!record) {
    events.push({ type: "attendance-recorded", attendanceId: ctx.uid(), musicianId, slot, present: true, at: ctx.now });
  }
  events.push({
    type: "seat-confirmed",
    seatId: ctx.uid(),
    hallId,
    slot,
    instrumentId,
    musicianId,
    at: ctx.now
  });
  return { ok: true, message: `已确认：${slotLabel(slot)}${instrumentName(instrumentId)}由${musicianName(musicianId)}担任。`, events };
}

// 登记临时替班：下一小节起生效，须登记交接人；接班乐师确认后才真正占席
export function requestRegisterSubstitute(state, input, ctx) {
  const { hallId, slot, instrumentId, toMusicianId, handoverByRaw } = input;
  const d = derive(state.ledger);
  const handoverBy = (handoverByRaw || "").trim();

  const status = d.hallStatus.get(hallId);
  if (status?.status === "pending") {
    return {
      ok: false,
      message: "本厅整段待重排，须先执行重排，不能只替换乐师。",
      events: [rejectEvent(ctx, "substitute", hallId, slot, "整段待重排中，不能替班", { instrumentId, musicianId: toMusicianId })]
    };
  }

  // 独奏口令 / 速度偏离 → 整段转待重排，不能只替换乐师（以当前小节判定）
  const blockers = blockedReasons(state, state.currentSlot);
  if (blockers.length) {
    const text = blockers.map((key) => reasonText[key]).join("、");
    const events = [];
    if (!status || status.status !== "pending") {
      events.push({ type: "rearrange-required", id: ctx.uid(), hallId, reasons: blockers, at: ctx.now });
    }
    events.push(rejectEvent(ctx, "substitute", hallId, slot, `${text}，整段转为待重排，不能只替换乐师`, { instrumentId, musicianId: toMusicianId }));
    return { ok: false, message: `${text}：整段已转为待重排，请重排后再派位。`, events };
  }

  if (slot >= MEASURES[MEASURES.length - 1]) {
    return {
      ok: false,
      message: "当前已是最后一小节，替班无从下一小节起生效。",
      events: [rejectEvent(ctx, "substitute", hallId, slot, "已到末小节，无后续小节可供替班生效", { instrumentId, musicianId: toMusicianId })]
    };
  }

  const current = activeSeat(d, hallId, slot, instrumentId);
  if (!current) {
    return {
      ok: false,
      message: `${slotLabel(slot)}${instrumentName(instrumentId)}尚无确认席位，不能办理替班。`,
      events: [rejectEvent(ctx, "substitute", hallId, slot, "本小节该乐器没有在册席位", { instrumentId, musicianId: toMusicianId })]
    };
  }

  if (toMusicianId === current.musicianId) {
    return {
      ok: false,
      message: "接班乐师不能与原乐师为同一人。",
      events: [rejectEvent(ctx, "substitute", hallId, slot, "接班乐师与原乐师相同", { instrumentId, musicianId: toMusicianId })]
    };
  }

  // 接班乐师从下一小节到段尾，逐小节校验跨厅占用与缺席记录
  const effectiveSlot = slot + 1;
  for (const futureSlot of MEASURES.filter((item) => item >= effectiveSlot)) {
    const clash = occupancyAt(d, toMusicianId, futureSlot)
      .find((seat) => !(seat.hallId === hallId && seat.instrumentId === instrumentId));
    if (clash) {
      return {
        ok: false,
        message: `${musicianName(toMusicianId)}第${futureSlot}小节已在${hallName(clash.hallId)}担任${instrumentName(clash.instrumentId)}，无法接班。`,
        events: [rejectEvent(ctx, "substitute", hallId, futureSlot, `接班乐师第${futureSlot}小节在${hallName(clash.hallId)}已有席位`, { instrumentId, musicianId: toMusicianId })]
      };
    }
    const record = d.attendance.get(attendanceKey(toMusicianId, futureSlot));
    if (record && !record.present) {
      return {
        ok: false,
        message: `${musicianName(toMusicianId)}第${futureSlot}小节登记为缺席，无法接班。`,
        events: [rejectEvent(ctx, "substitute", hallId, futureSlot, `接班乐师第${futureSlot}小节登记为缺席`, { instrumentId, musicianId: toMusicianId })]
      };
    }
  }

  return {
    ok: true,
    message: `替班已登记（交接人：${handoverBy || musicianName(current.musicianId)}），待${musicianName(toMusicianId)}接班确认后，自第${effectiveSlot}小节起生效。`,
    events: [{
      type: "substitute-registered",
      subId: ctx.uid(),
      hallId,
      slot,
      effectiveSlot,
      instrumentId,
      fromMusicianId: current.musicianId,
      toMusicianId,
      handoverBy: handoverBy || musicianName(current.musicianId),
      at: ctx.now
    }]
  };
}

// 接班确认：闭环最后一步，确认瞬间重新校验冲突
export function requestConfirmSubstitute(state, input, ctx) {
  const d = derive(state.ledger);
  const sub = d.pending.get(input.subId);
  if (!sub || sub.confirmed) {
    return { ok: false, message: "替班记录不存在或已确认。", events: [] };
  }

  const status = d.hallStatus.get(sub.hallId);
  if (status?.status === "pending") {
    return {
      ok: false,
      message: "本厅整段待重排，接班确认暂停。",
      events: [rejectEvent(ctx, "confirm", sub.hallId, sub.effectiveSlot, "整段待重排中，接班确认被拒", { instrumentId: sub.instrumentId, musicianId: sub.toMusicianId })]
    };
  }

  // 确认瞬间条件已变化（出现独奏口令/速度偏离）：整段转待重排，不完成接班
  const blockers = blockedReasons(state, state.currentSlot);
  if (blockers.length) {
    const text = blockers.map((key) => reasonText[key]).join("、");
    const events = [];
    if (!status || status.status !== "pending") {
      events.push({ type: "rearrange-required", id: ctx.uid(), hallId: sub.hallId, reasons: blockers, at: ctx.now });
    }
    events.push(rejectEvent(ctx, "confirm", sub.hallId, sub.effectiveSlot, `${text}，整段转为待重排，接班确认被拒`, { instrumentId: sub.instrumentId, musicianId: sub.toMusicianId }));
    return { ok: false, message: `${text}：整段已转为待重排，接班未完成。`, events };
  }

  for (const futureSlot of MEASURES.filter((item) => item >= sub.effectiveSlot)) {
    const clash = occupancyAt(d, sub.toMusicianId, futureSlot)
      .find((seat) => !(seat.hallId === sub.hallId && seat.instrumentId === sub.instrumentId));
    if (clash) {
      return {
        ok: false,
        message: `接班确认被拒：${musicianName(sub.toMusicianId)}第${futureSlot}小节已在${hallName(clash.hallId)}担任${instrumentName(clash.instrumentId)}。原登记保留待处理。`,
        events: [rejectEvent(ctx, "confirm", sub.hallId, futureSlot, `确认时发现第${futureSlot}小节在${hallName(clash.hallId)}已有席位`, { instrumentId: sub.instrumentId, musicianId: sub.toMusicianId })]
      };
    }
  }

  const events = [];
  for (const futureSlot of MEASURES.filter((item) => item >= sub.effectiveSlot)) {
    if (!d.attendance.has(attendanceKey(sub.toMusicianId, futureSlot))) {
      events.push({ type: "attendance-recorded", attendanceId: ctx.uid(), musicianId: sub.toMusicianId, slot: futureSlot, present: true, at: ctx.now });
    }
  }
  events.push({ type: "substitute-confirmed", subId: sub.subId, at: ctx.now });
  return {
    ok: true,
    message: `${musicianName(sub.toMusicianId)}已确认接班，自第${sub.effectiveSlot}小节起担任${instrumentName(sub.instrumentId)}。`,
    events
  };
}

// 到场记录登记 / 更正：更正后依赖该记录的席位立即失效并重算，旧安排保留可查
export function correctAttendance(state, input, ctx) {
  const { musicianId, slot, present, by = "现场更正" } = input;
  const d = derive(state.ledger);
  const record = d.attendance.get(attendanceKey(musicianId, slot));

  if (!record) {
    return {
      ok: true,
      message: `${musicianName(musicianId)}第${slot}小节到场记录已登记（${present ? "到场" : "缺席"}）。`,
      events: [{ type: "attendance-recorded", attendanceId: ctx.uid(), musicianId, slot, present, at: ctx.now }]
    };
  }
  if (record.present === present) {
    return { ok: true, message: "到场记录未变化。", events: [] };
  }

  const events = [{
    type: "attendance-corrected",
    attendanceId: record.recordId,
    musicianId,
    slot,
    from: record.present,
    to: present,
    by,
    at: ctx.now
  }];

  // 在"更正"之上重算（尚未追加失效/恢复事件）
  const interim = derive([...state.ledger, ...events]);

  if (!present) {
    // 更正为缺席：当前在席的依赖席位立即失效
    const dependents = [...interim.seats.values()].filter((seat) => seat.musicianId === musicianId && seat.slot === slot);
    for (const seat of dependents) {
      events.push({
        type: "seat-invalidated",
        id: ctx.uid(),
        hallId: seat.hallId,
        slot: seat.slot,
        instrumentId: seat.instrumentId,
        musicianId: seat.musicianId,
        reason: "到场记录更正为缺席，席位立即失效",
        at: ctx.now
      });
      events.push({
        type: "seat-recomputed",
        mode: "vacated",
        seatId: null,
        hallId: seat.hallId,
        slot: seat.slot,
        instrumentId: seat.instrumentId,
        musicianId: seat.musicianId,
        kind: seat.kind,
        reason: "重算后撤席，等待重新派位",
        at: ctx.now
      });
    }
    return {
      ok: true,
      message: `${musicianName(musicianId)}第${slot}小节到场记录已更正为缺席，${dependents.length ? `依赖席位 ${dependents.length} 个已失效并重算，旧安排留存可查。` : "无依赖席位。"}`,
      events
    };
  }

  // 更正为到场：找出此前因到场更正而失效归档的旧席（同乐师同时段），逐个重算恢复
  const candidates = new Map();
  for (const seat of interim.archive) {
    if (
      seat.musicianId === musicianId
      && seat.slot === slot
      && seat.endReason.includes("到场记录更正")
    ) {
      candidates.set(seatKey(seat.hallId, seat.slot, seat.instrumentId), seat);
    }
  }

  let reinstated = 0;
  let blocked = 0;
  const reinstatedKeys = new Set();
  const occupiedKeysFor = (targetMusician, targetSlot) => {
    const keys = new Set();
    for (const seat of interim.seats.values()) {
      if (seat.musicianId === targetMusician && seat.slot === targetSlot) {
        keys.add(seatKey(seat.hallId, seat.slot, seat.instrumentId));
      }
    }
    for (const key of reinstatedKeys) keys.add(key);
    return keys;
  };

  for (const [key, old] of candidates) {
    const occupied = occupiedKeysFor(musicianId, slot);
    const clash = occupied.has(key) ? null : (occupied.size > 0 ? [...occupied][0] : null);
    const taken = interim.seats.get(key);
    if (taken || clash) {
      blocked += 1;
      events.push({
        type: "seat-recomputed",
        mode: "blocked",
        seatId: null,
        hallId: old.hallId,
        slot: old.slot,
        instrumentId: old.instrumentId,
        musicianId: old.musicianId,
        kind: old.kind,
        reason: taken ? "席位已由他人补位，重算后保持空缺" : "乐师该时段另有席位，重算后不恢复",
        at: ctx.now
      });
      continue;
    }
    reinstated += 1;
    reinstatedKeys.add(key);
    events.push({
      type: "seat-recomputed",
      mode: "reinstate",
      seatId: ctx.uid(),
      hallId: old.hallId,
      slot: old.slot,
      instrumentId: old.instrumentId,
      musicianId: old.musicianId,
      kind: old.kind,
      reason: "到场记录更正为到场，席位重算恢复",
      at: ctx.now
    });
  }

  return {
    ok: true,
    message: `${musicianName(musicianId)}第${slot}小节到场记录已更正为到场：恢复席位 ${reinstated} 个${blocked ? `，${blocked} 个因冲突保持空缺` : ""}，旧安排留存可查。`,
    events
  };
}

// 执行整段重排：归档本厅全部在席席位与待确认替班，状态恢复正常
export function resolveRearrange(state, input, ctx) {
  const d = derive(state.ledger);
  const status = d.hallStatus.get(input.hallId);
  if (status?.status !== "pending") {
    return { ok: false, message: "本厅当前不是待重排状态。", events: [] };
  }
  const events = [{ type: "rearrange-resolved", id: ctx.uid(), hallId: input.hallId, at: ctx.now }];
  for (const sub of d.pending.values()) {
    if (sub.hallId === input.hallId && !sub.confirmed) {
      events.push({ type: "substitute-cancelled", id: ctx.uid(), subId: sub.subId, at: ctx.now });
    }
  }
  return { ok: true, message: `${hallName(input.hallId)}已完成重排，旧席位全部归档留存，可重新派位。`, events };
}

// ---- 乐师履历 ----

export function musicianResume(ledger, musicianId) {
  const d = derive(ledger);
  const items = [];

  const push = (at, text, kind = "info") => items.push({ at, text, kind });

  for (const ev of ledger) {
    const involves = ev.musicianId === musicianId
      || ev.fromMusicianId === musicianId
      || ev.toMusicianId === musicianId;
    if (!involves) continue;

    switch (ev.type) {
      case "attendance-recorded":
        push(ev.at, `第${ev.slot}小节到场记录登记：${ev.present ? "到场" : "缺席"}`);
        break;
      case "attendance-corrected":
        push(ev.at, `第${ev.slot}小节到场记录更正：${ev.from ? "到场" : "缺席"}→${ev.to ? "到场" : "缺席"}（${ev.by}）`, "warn");
        break;
      case "seat-confirmed":
        push(ev.at, `正式席位确认：${hallName(ev.hallId)}第${ev.slot}小节 · ${instrumentName(ev.instrumentId)}`);
        break;
      case "substitute-registered":
        if (ev.toMusicianId === musicianId) {
          push(ev.at, `替班登记：拟自第${ev.effectiveSlot}小节起接${instrumentName(ev.instrumentId)}（原任${musicianName(ev.fromMusicianId)}，交接人${ev.handoverBy}），待本人确认`, "warn");
        } else if (ev.fromMusicianId === musicianId) {
          push(ev.at, `交接登记：${instrumentName(ev.instrumentId)}自第${ev.effectiveSlot}小节起交${musicianName(ev.toMusicianId)}接班（交接人${ev.handoverBy}）`);
        }
        break;
      case "substitute-confirmed":
        if (ev.toMusicianId === musicianId || ev.fromMusicianId === musicianId) {
          push(ev.at, `接班确认完成：${hallName(ev.hallId)}${instrumentName(ev.instrumentId)}自第${ev.effectiveSlot}小节起由${musicianName(ev.toMusicianId)}担任`);
        }
        break;
      case "seat-invalidated":
        push(ev.at, `席位失效：${hallName(ev.hallId)}第${ev.slot}小节 · ${instrumentName(ev.instrumentId)}（${ev.reason}）`, "bad");
        break;
      case "seat-recomputed":
        if (ev.mode === "reinstate") push(ev.at, `重算恢复席位：${hallName(ev.hallId)}第${ev.slot}小节 · ${instrumentName(ev.instrumentId)}`);
        else if (ev.mode === "vacated") push(ev.at, `重算撤席：${hallName(ev.hallId)}第${ev.slot}小节 · ${instrumentName(ev.instrumentId)}（${ev.reason}）`, "warn");
        else if (ev.mode === "blocked") push(ev.at, `重算未恢复：${hallName(ev.hallId)}第${ev.slot}小节 · ${instrumentName(ev.instrumentId)}（${ev.reason}）`, "warn");
        break;
      case "request-rejected":
        push(ev.at, `请求被拒（${({ bind: "派位", substitute: "替班", confirm: "接班确认" })[ev.category] || ev.category}）：${ev.reason}`, "bad");
        break;
      case "substitute-cancelled":
        push(ev.at, "替班登记随整段重排作废", "warn");
        break;
      default:
        break;
    }
  }

  for (const seat of d.archive) {
    if (seat.musicianId !== musicianId) continue;
    if (seat.endReason.startsWith("替班交接") || seat.endReason.startsWith("整段待重排")) {
      push(seat.endedAt, `旧席归档：${hallName(seat.hallId)}第${seat.slot}小节 · ${instrumentName(seat.instrumentId)}（${seat.kind}）— ${seat.endReason}`, "warn");
    }
  }

  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  const formalCount = ledger.filter((ev) => ev.type === "seat-confirmed" && ev.musicianId === musicianId).length
    + ledger.filter((ev) => ev.type === "seat-recomputed" && ev.mode === "reinstate" && ev.musicianId === musicianId).length;
  const subCount = ledger.filter((ev) => ev.type === "substitute-confirmed" && ev.toMusicianId === musicianId).length;
  const rejectedCount = ledger.filter((ev) => ev.type === "request-rejected" && ev.musicianId === musicianId).length;

  return { items, formalCount, subCount, rejectedCount };
}
