// 页面展示模块：乐师席位台的渲染与交互。只读写 storage api、调用 seat-rules 的纯函数，本身不持有业务事实。

import {
  instruments, musicians, halls, MEASURES, SLOTS,
  instrumentName, musicianName, hallName, slotLabel, seatKey, attendanceKey,
  measureHasSolo, tempoDeviated,
  requestBindSeat, requestRegisterSubstitute, requestConfirmSubstitute,
  correctAttendance, resolveRearrange, getRejections, musicianResume
} from "./seat-rules.js";

const fmtTime = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
};

export function mountSeatDesk(api) {
  const root = document.querySelector("#seatDesk");
  let selectedHallId = halls[0].id;
  let tab = "conflicts";
  let resumeMusicianId = musicians[0].id;
  let lastMessage = "";
  let lastOk = true;

  root.innerHTML = `
    <div class="desk-head">
      <div class="hall-tabs" role="tablist">
        ${halls.map((h) => `<button type="button" class="hall-tab" data-hall="${h.id}">${h.name}</button>`).join("")}
      </div>
      <div class="desk-status" id="deskStatus"></div>
      <button type="button" class="btn-resolve" id="resolveBtn" hidden>执行整段重排（旧席归档、恢复派位）</button>
    </div>
    <p class="desk-tip" id="deskTip"></p>
    <div class="desk-body">
      <section class="desk-col seats-col">
        <h3>席位总览 <small>每格 = 某乐器在某小节（时段）绑定的唯一乐师；点击格子可回填表单</small></h3>
        <div class="seat-grid" id="seatGrid"></div>
        <h3 class="sub-pending-title">待接班确认的替班</h3>
        <div id="pendingList"></div>
      </section>

      <section class="desk-col ops-col">
        <h3>绑定席位</h3>
        <div class="op-form" id="bindForm">
          <label>乐器<select data-field="bindInstrument">${instruments.map((i) => `<option value="${i.id}">${i.name}</option>`).join("")}</select></label>
          <label>小节(时段)<select data-field="bindSlot">${SLOTS.map((s) => `<option value="${s.slot}">${s.label}</option>`).join("")}</select></label>
          <label>乐师<select data-field="bindMusician">${musicians.map((m) => `<option value="${m.id}">${m.name}</option>`).join("")}</select></label>
          <button type="button" data-op="bind" class="btn-go">确认绑定</button>
        </div>

        <h3>临时替班 <small>自下一小节起生效，须先登记交接人</small></h3>
        <div class="op-form" id="subForm">
          <label>乐器<select data-field="subInstrument">${instruments.map((i) => `<option value="${i.id}">${i.name}</option>`).join("")}</select></label>
          <label>办理小节<select data-field="subSlot">${SLOTS.map((s) => `<option value="${s.slot}">${s.label}</option>`).join("")}</select></label>
          <label>接班乐师<select data-field="subMusician">${musicians.map((m) => `<option value="${m.id}">${m.name}</option>`).join("")}</select></label>
          <label>交接人<input data-field="handoverBy" placeholder="如：舞台监督 孙师傅"></label>
          <button type="button" data-op="substitute" class="btn-go">登记替班</button>
        </div>

        <h3>到场记录 <small>点圆点可登记/更正，更正后依赖席位立即失效重算</small></h3>
        <div class="att-grid" id="attGrid"></div>
        <div class="op-form inline">
          <label>乐师<select data-field="attMusician">${musicians.map((m) => `<option value="${m.id}">${m.name}</option>`).join("")}</select></label>
          <label>小节<select data-field="attSlot">${SLOTS.map((s) => `<option value="${s.slot}">${s.label}</option>`).join("")}</select></label>
          <label>记录<select data-field="attPresent"><option value="true">到场</option><option value="false">缺席</option></select></label>
          <label>更正人<input data-field="attBy" placeholder="如：场记 吴老师"></label>
          <button type="button" data-op="attendance" class="btn-go">提交更正</button>
        </div>
      </section>

      <section class="desk-col records-col">
        <div class="rec-tabs">
          <button type="button" data-tab="conflicts">冲突 / 拒绝清单</button>
          <button type="button" data-tab="resume">乐师履历</button>
          <button type="button" data-tab="archive">旧安排归档</button>
        </div>
        <div id="recBody"></div>
      </section>
    </div>
    <div class="desk-msg" id="deskMsg" hidden></div>
  `;

  function state() { return api.getState(); }

  function run(result) {
    if (result.events?.length) api.append(result.events);
    lastMessage = result.message;
    lastOk = Boolean(result.ok);
    api.rerender();
  }

  const field = (name) => root.querySelector(`[data-field="${name}"]`);

  function readForm() {
    return {
      bindInstrument: field("bindInstrument").value,
      bindSlot: Number(field("bindSlot").value),
      bindMusician: field("bindMusician").value,
      subInstrument: field("subInstrument").value,
      subSlot: Number(field("subSlot").value),
      subMusician: field("subMusician").value,
      handoverBy: field("handoverBy").value,
      attMusician: field("attMusician").value,
      attSlot: Number(field("attSlot").value),
      attPresent: field("attPresent").value === "true",
      attBy: field("attBy").value
    };
  }

  root.addEventListener("click", (event) => {
    const hallBtn = event.target.closest("[data-hall]");
    if (hallBtn) {
      selectedHallId = hallBtn.dataset.hall;
      api.rerender();
      return;
    }

    const tabBtn = event.target.closest("[data-tab]");
    if (tabBtn) {
      tab = tabBtn.dataset.tab;
      api.rerender();
      return;
    }

    const resumeBtn = event.target.closest("[data-resume]");
    if (resumeBtn) {
      resumeMusicianId = resumeBtn.dataset.resume;
      tab = "resume";
      api.rerender();
      return;
    }

    const cellBtn = event.target.closest("[data-cell]");
    if (cellBtn) {
      const [slot, instrumentId] = cellBtn.dataset.cell.split("|");
      field("bindInstrument").value = instrumentId;
      field("bindSlot").value = slot;
      field("subInstrument").value = instrumentId;
      field("subSlot").value = slot;
      api.rerender();
      return;
    }

    const attBtn = event.target.closest("[data-attr]");
    if (attBtn) {
      const [musicianId, slotText] = attBtn.dataset.attr.split("|");
      const slot = Number(slotText);
      const d = api.derive();
      const record = d.attendance.get(attendanceKey(musicianId, slot));
      // 未登记 → 缺席；缺席 → 到场；到场 → 缺席（更正）
      const present = record ? !record.present : false;
      run(correctAttendance(state(), { musicianId, slot, present, by: "到场表更正" }, ctx()));
      return;
    }

    const confirmBtn = event.target.closest("[data-confirm-sub]");
    if (confirmBtn) {
      run(requestConfirmSubstitute(state(), { subId: confirmBtn.dataset.confirmSub }, ctx()));
      return;
    }

    const resolveBtn = event.target.closest("#resolveBtn");
    if (resolveBtn && resolveBtn === event.target.closest("#resolveBtn")) {
      run(resolveRearrange(state(), { hallId: selectedHallId }, ctx()));
      return;
    }

    const opBtn = event.target.closest("[data-op]");
    if (!opBtn) return;
    const f = readForm();
    if (opBtn.dataset.op === "bind") {
      run(requestBindSeat(state(), {
        hallId: selectedHallId, slot: f.bindSlot, instrumentId: f.bindInstrument, musicianId: f.bindMusician
      }, ctx()));
    } else if (opBtn.dataset.op === "substitute") {
      run(requestRegisterSubstitute(state(), {
        hallId: selectedHallId, slot: f.subSlot, instrumentId: f.subInstrument,
        toMusicianId: f.subMusician, handoverByRaw: f.handoverBy
      }, ctx()));
    } else if (opBtn.dataset.op === "attendance") {
      run(correctAttendance(state(), {
        musicianId: f.attMusician, slot: f.attSlot, present: f.attPresent,
        by: f.attBy.trim() || "现场更正"
      }, ctx()));
    }
  });

  const ctx = () => ({ uid: api.newId, now: new Date().toISOString() });

  // ---- 渲染 ----

  function renderStatus(d, hallPending) {
    root.querySelectorAll(".hall-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.hall === selectedHallId);
    });

    const s = state();
    const deviated = tempoDeviated(s.bpm, s.baseBpm);
    const soloNow = measureHasSolo(s.solo, s.currentSlot);
    const tipBits = [
      `当前时段：<strong>${slotLabel(s.currentSlot)}</strong>（点小节表头可切换）`,
      `速度 ${s.bpm} BPM / 基准 ${s.baseBpm} BPM`,
      deviated ? `<em class="bad">已偏离基准（±10%），替班将整段转待重排</em>` : "速度在基准区间内",
      soloNow ? `<em class="bad">${slotLabel(s.currentSlot)}含独奏口令</em>` : ""
    ].filter(Boolean);
    root.querySelector("#deskTip").innerHTML = tipBits.join("　·　");

    const statusEl = root.querySelector("#deskStatus");
    const resolveBtn = root.querySelector("#resolveBtn");
    if (hallPending) {
      const reasons = (hallPending.reasons || []).map((r) => r === "solo" ? "含独奏口令" : "速度偏离基准").join("、");
      statusEl.innerHTML = `<span class="status-badge pending">${hallName(selectedHallId)}：整段待重排</span><span class="status-reason">触发：${reasons} · ${fmtTime(hallPending.at)}</span>`;
      resolveBtn.hidden = false;
    } else {
      statusEl.innerHTML = `<span class="status-badge normal">${hallName(selectedHallId)}：正常派位</span>`;
      resolveBtn.hidden = true;
    }
  }

  function renderSeatGrid(d, hallPending) {
    const s = state();
    const head = ['<div class="seat-corner">乐器 ＼ 小节</div>']
      .concat(MEASURES.map((slot) => `
        <button type="button" class="slot-head ${slot === s.currentSlot ? "current" : ""}" data-set-slot="${slot}">
          ${slotLabel(slot)}
          ${slot === s.currentSlot ? "<span class='now-tag'>当前</span>" : ""}
          ${measureHasSolo(s.solo, slot) ? "<span class='solo-tag'>独奏</span>" : ""}
        </button>`)).join("");

    const rows = instruments.map((instrument) => {
      const label = `<div class="seat-row-label">${instrument.name}<small>${instrument.token}</small></div>`;
      const cells = MEASURES.map((slot) => {
        const seat = d.seats.get(seatKey(selectedHallId, slot, instrument.id));
        const cls = ["seat-cell"];
        if (slot === s.currentSlot) cls.push("current-col");
        if (slot < s.currentSlot) cls.push("past");
        if (hallPending) cls.push("locked");
        if (seat?.kind === "替班") cls.push("sub");
        const body = seat
          ? `<strong>${musicianName(seat.musicianId)}</strong><span class="seat-kind">${seat.kind}${seat.kind === "替班" ? "·自第" + (d.pending.get(seat.viaSubId)?.effectiveSlot || "") + "小节" : ""}</span>`
          : "<span class='empty-slot'>空缺</span>";
        return `<button type="button" class="${cls.join(" ")}" data-cell="${slot}|${instrument.id}" ${hallPending ? "disabled" : ""}>${body}</button>`;
      }).join("");
      return label + cells;
    }).join("");

    root.querySelector("#seatGrid").innerHTML = head + rows;
  }

  function renderPending(d, hallPending) {
    const subs = [...d.pending.values()].filter((sub) => sub.hallId === selectedHallId && !sub.confirmed);
    const el = root.querySelector("#pendingList");
    if (!subs.length) {
      el.innerHTML = "<p class='muted'>暂无待确认替班。</p>";
      return;
    }
    el.innerHTML = subs.map((sub) => `
      <article class="pending-card ${sub.confirmed ? "done" : ""}">
        <p><strong>${instrumentName(sub.instrumentId)}</strong>：${musicianName(sub.fromMusicianId)} → ${musicianName(sub.toMusicianId)}</p>
        <p class="muted">办理于${slotLabel(sub.slot)} · 自<strong>第${sub.effectiveSlot}小节</strong>起生效 · 交接人：${sub.handoverBy}</p>
        ${sub.confirmed
          ? `<p class="ok-text">已于 ${fmtTime(sub.confirmedAt)} 接班确认</p>`
          : `<button type="button" data-confirm-sub="${sub.subId}" ${hallPending ? "disabled" : ""}>${musicianName(sub.toMusicianId)}接班确认</button>`}
      </article>
    `).join("");
  }

  function renderAttendance(d) {
    const head = ['<div class="att-corner"></div>']
      .concat(MEASURES.map((slot) => `<div class="att-head">${slot}小节</div>`)).join("");
    const rows = musicians.map((m) => {
      const cells = MEASURES.map((slot) => {
        const r = d.attendance.get(attendanceKey(m.id, slot));
        const cls = "att-dot " + (!r ? "none" : r.present ? "present" : "absent");
        const title = !r ? "未登记（点击登记缺席）" : `${r.present ? "到场" : "缺席"}${r.history.length ? ` · 已更正${r.history.length}次` : ""}（点击更正）`;
        return `<button type="button" class="${cls}" data-attr="${m.id}|${slot}" title="${title}"></button>`;
      }).join("");
      return `<div class="att-name">${m.name}</div>${cells}`;
    }).join("");
    root.querySelector("#attGrid").innerHTML = head + rows;
  }

  function renderRecords(d) {
    const body = root.querySelector("#recBody");
    root.querySelectorAll(".rec-tabs button").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tab));

    if (tab === "conflicts") {
      const list = getRejections(state().ledger).slice().reverse();
      body.innerHTML = list.length ? list.map((r) => `
        <article class="rec-card reject">
          <p><strong>${({ bind: "派位拒绝", substitute: "替班拒绝", confirm: "接班确认拒绝" })[r.category] || r.category}</strong>
            <span class="when">${fmtTime(r.at)}</span></p>
          <p>${hallName(r.hallId)} · ${r.slot ? slotLabel(r.slot) : ""}${r.instrumentId ? " · " + instrumentName(r.instrumentId) : ""}${r.musicianId ? " · " + musicianName(r.musicianId) : ""}</p>
          <p class="muted">${r.reason}</p>
        </article>
      `).join("") : "<p class='muted'>暂无冲突或拒绝记录。冲突请求只返回拒绝，不影响已确认席位。</p>";
      return;
    }

    if (tab === "resume") {
      const resume = musicianResume(state().ledger, resumeMusicianId);
      body.innerHTML = `
        <div class="resume-pick">
          <select id="resumeSelect">${musicians.map((m) => `<option value="${m.id}" ${m.id === resumeMusicianId ? "selected" : ""}>${m.name}</option>`).join("")}</select>
        </div>
        <div class="resume-stats">
          <span>正式席位 <strong>${resume.formalCount}</strong></span>
          <span>替班接班 <strong>${resume.subCount}</strong></span>
          <span>被拒请求 <strong>${resume.rejectedCount}</strong></span>
        </div>
        ${resume.items.length ? resume.items.map((it) => `
          <article class="rec-card ${it.kind}">
            <p>${it.text}</p>
            <p class="when">${fmtTime(it.at)}</p>
          </article>
        `).join("") : "<p class='muted'>该乐师暂无履历。</p>"}
      `;
      body.querySelector("#resumeSelect").addEventListener("change", (e) => {
        resumeMusicianId = e.target.value;
        render();
      });
      return;
    }

    // archive
    const list = d.archive.slice().reverse();
    body.innerHTML = list.length ? list.map((seat) => `
      <article class="rec-card archived">
        <p><strong>${hallName(seat.hallId)} · ${slotLabel(seat.slot)} · ${instrumentName(seat.instrumentId)}</strong> <span class="seat-kind">${seat.kind}</span></p>
        <p>曾任：${musicianName(seat.musicianId)}</p>
        <p class="muted">${seat.endReason}</p>
        <p class="when">归档于 ${fmtTime(seat.endedAt)}</p>
      </article>
    `).join("") : "<p class='muted'>暂无归档席位。失效、被交接、重排的旧安排都会原样保留在此。</p>";
  }

  function renderMessage() {
    const el = root.querySelector("#deskMsg");
    if (!lastMessage) { el.hidden = true; return; }
    el.hidden = false;
    el.className = `desk-msg ${lastOk ? "ok" : "fail"}`;
    el.textContent = lastMessage;
  }

  function render() {
    const s = state();
    const d = api.derive();
    const hallPending = d.hallStatus.get(selectedHallId);
    const isPending = hallPending?.status === "pending";

    renderStatus(d, isPending ? hallPending : null);
    renderSeatGrid(d, isPending);
    renderPending(d, isPending);
    renderAttendance(d);
    renderRecords(d);
    renderMessage();

    // 表单默认指向当前小节
    if (document.activeElement?.dataset?.field !== "bindSlot") field("bindSlot").value = String(s.currentSlot);
    if (document.activeElement?.dataset?.field !== "subSlot") field("subSlot").value = String(s.currentSlot);
    if (document.activeElement?.dataset?.field !== "attSlot") field("attSlot").value = String(s.currentSlot);
  }

  // 点小节表头切换"当前时段"
  root.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-set-slot]");
    if (!btn) return;
    api.setCurrentSlot(Number(btn.dataset.setSlot));
  });

  render();
  return { render };
}
