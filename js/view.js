/**
 * 页面展示模块：只读存储 + 调用规则模块，不写业务判定。
 * 负责网格渲染、席位排班表、冲突清单、到场与履历展示及全部交互事件。
 */
globalThis.LuoguView = (function () {
  "use strict";

  const Rules = globalThis.LuoguRules;
  const Store = globalThis.LuoguStore;

  const $ = (selector) => document.querySelector(selector);
  const els = {};
  let soloMode = false;
  let toastTimer = null;

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function formatTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
      date.getMinutes()
    )}:${pad(date.getSeconds())}`;
  }

  function beatLabel(index) {
    const measure = Math.floor(index / Rules.BEATS_PER_MEASURE) + 1;
    const beat = (index % Rules.BEATS_PER_MEASURE) + 1;
    return `${measure}-${beat}`;
  }

  function capableMusicianOptions(state, instrument, excludeId) {
    return state.musicians
      .filter((musician) => musician.skills.includes(instrument) && musician.id !== excludeId)
      .map((musician) => `<option value="${musician.id}">${esc(musician.name)}</option>`)
      .join("");
  }

  // ---------- 锣鼓经网格 ----------

  function renderGrid(state) {
    const header = ['<div class="label-cell">乐器＼节拍</div>'];
    for (let step = 0; step < Rules.STEPS; step += 1) {
      const measure = Math.floor(step / Rules.BEATS_PER_MEASURE) + 1;
      const soloMark = Rules.measureHasSolo(state, measure) && step % Rules.BEATS_PER_MEASURE === 0
        ? '<span class="measure-solo">含独</span>'
        : "";
      header.push(`<div class="beat-cell">${beatLabel(step)}${soloMark}</div>`);
    }

    const rows = Rules.instruments.flatMap((instrument, rowIndex) => {
      const row = [`<div class="label-cell">${instrument.name}</div>`];
      for (let step = 0; step < Rules.STEPS; step += 1) {
        const value = state.pattern[rowIndex][step];
        const isSolo = !!state.solo[rowIndex][step];
        const classes = ["cell", value ? "filled" : "", isSolo ? "solo" : ""].filter(Boolean).join(" ");
        const badge = isSolo ? '<span class="solo-badge">独</span>' : "";
        row.push(
          `<button class="${classes}" type="button" data-row="${rowIndex}" data-step="${step}">` +
            `<span class="token">${value}</span>${badge}</button>`
        );
      }
      return row;
    });

    els.grid.innerHTML = [...header, ...rows].join("");
  }

  // ---------- 席位排班表 ----------

  function renderSeatBoard(state) {
    const hallId = state.currentHall;
    const measureHeaders = Rules.MEASURES.map(
      (measure) =>
        `<div class="seat-measure">第${measure}小节${
          Rules.measureHasSolo(state, measure) ? '<span class="chip warn">独奏</span>' : ""
        }${
          !state.attendance.some((a) => a.measure === measure && a.present) ? "" : ""
        }</div>`
    ).join("");

    const body = Rules.instruments
      .map((instrument, instrumentIndex) => {
        const cells = Rules.MEASURES.map((measure) => {
          const seat = Rules.activeSeatAt(state, hallId, measure, instrumentIndex);
          if (seat) {
            const subOptions = capableMusicianOptions(state, instrumentIndex, seat.musicianId);
            const chip =
              seat.kind === "sub"
                ? '<span class="chip sub">替班</span>'
                : '<span class="chip normal">正席</span>';
            const handover =
              seat.kind === "sub"
                ? (() => {
                    const sub = state.substitutions.find((item) => item.id === seat.substitutionId);
                    return sub
                      ? `<small>交接人：${esc(Rules.musicianName(state, sub.handoverId))}</small>`
                      : "";
                  })()
                : "";
            const blocked = state.rearrangePending;
            return `
              <div class="seat-cell occupied ${seat.kind === "sub" ? "is-sub" : ""}">
                <div class="seat-who">${chip}<strong>${esc(
                  Rules.musicianName(state, seat.musicianId)
                )}</strong></div>
                ${handover}
                <label class="sub-form ${blocked ? "disabled" : ""}">
                  <select data-sub-select data-measure="${measure}" data-inst="${instrumentIndex}" ${
                    blocked ? "disabled" : ""
                  }>${subOptions}</select>
                  <button type="button" class="ghost small" data-act="request-sub" data-measure="${measure}" data-inst="${instrumentIndex}" ${
                    blocked ? "disabled" : ""
                  }>申请替班</button>
                </label>
              </div>`;
          }

          const options = capableMusicianOptions(state, instrumentIndex);
          return `
            <div class="seat-cell empty">
              <span class="seat-tag">空席</span>
              <label class="bind-form ${state.rearrangePending ? "disabled" : ""}">
                <select data-bind-select data-measure="${measure}" data-inst="${instrumentIndex}" ${
                  state.rearrangePending ? "disabled" : ""
                }>${options}</select>
                <button type="button" class="ghost small" data-act="bind" data-measure="${measure}" data-inst="${instrumentIndex}" ${
                  state.rearrangePending ? "disabled" : ""
                }>确认席位</button>
              </label>
            </div>`;
        }).join("");
        return `<div class="seat-label">${instrument.name}</div>${cells}`;
      })
      .join("");

    els.seatBoard.innerHTML =
      `<div class="seat-corner">乐器＼小节</div>${measureHeaders}${body}`;
    els.boardHallName.textContent = Rules.hallName(state, hallId);
    els.rearrangeBtn.disabled = !state.rearrangePending;
  }

  // ---------- 待接班确认 ----------

  function renderPending(state) {
    const awaiting = state.substitutions.filter((sub) => sub.status === "awaiting");
    if (!awaiting.length) {
      els.pendingList.innerHTML = "<p>暂无待确认替班。</p>";
      return;
    }
    els.pendingList.innerHTML = awaiting
      .map(
        (sub) => `
        <article class="pending-item">
          <div>
            <strong>${esc(Rules.hallName(state, sub.hallId))} · ${esc(
              Rules.instrumentName(sub.instrument)
            )}</strong>
            <p>${esc(Rules.musicianName(state, sub.handoverId))} 交接 → ${esc(
              Rules.musicianName(state, sub.substituteId)
            )}，自第${sub.effectiveMeasure}小节起生效（申请于第${
              sub.requestMeasure
            }小节）</p>
          </div>
          <button type="button" data-act="confirm-sub" data-id="${sub.id}">接班确认</button>
        </article>`
      )
      .join("");
  }

  // ---------- 冲突清单 ----------

  function renderConflicts(state) {
    if (!state.conflicts.length) {
      els.conflictList.innerHTML = "<p>暂无被拒绝的冲突请求。</p>";
      return;
    }
    els.conflictList.innerHTML = state.conflicts
      .map((conflict) => {
        const req = conflict.request || {};
        const where = req.hallId
          ? `${esc(Rules.hallName(state, req.hallId))} · 第${req.measure}小节 · ${esc(
              Rules.instrumentName(Number(req.instrument))
            )}`
          : "—";
        const who = req.musicianId ? esc(Rules.musicianName(state, req.musicianId)) : "—";
        return `
        <article class="conflict-item">
          <header><span class="chip reject">拒绝</span><strong>${esc(
            conflict.kind
          )}</strong><time>${formatTime(conflict.at)}</time></header>
          <p>${where}｜乐师：${who}</p>
          <ul>${conflict.reasons.map((reason) => `<li>${esc(reason)}</li>`).join("")}</ul>
        </article>`;
      })
      .join("");
  }

  // ---------- 到场登记与乐师履历 ----------

  function renderRoster(state) {
    els.roster.innerHTML = state.musicians
      .map((musician) => {
        const resume = Rules.musicianResume(state, musician.id);
        const attendance = Rules.MEASURES.map((measure) => {
          const record = state.attendance.find(
            (item) => item.musicianId === musician.id && item.measure === measure
          );
          const present = !!record?.present;
          return `
            <button type="button" class="att ${present ? "present" : "absent"}"
              data-act="att" data-musician="${musician.id}" data-measure="${measure}"
              title="点击更正到场记录">
              第${measure}小节 · ${present ? "到场" : "缺席"}
            </button>`;
        }).join("");

        const skillText = musician.skills
          .map((index) => Rules.instrumentName(index))
          .join("、");

        const seatLines = resume.seats
          .map((row) => {
            const current = row.generation === state.generation && row.status === "confirmed";
            const statusChip = current
              ? '<span class="chip normal">在岗</span>'
              : row.generation === state.generation
              ? '<span class="chip reject">失效</span>'
              : '<span class="chip archived">封存</span>';
            return `<li>${statusChip} 第${row.generation}代 · ${esc(
              Rules.hallName(state, row.hallId)
            )}第${row.measure}小节${esc(Rules.instrumentName(row.instrument))}${
              row.kind === "sub" ? "（替班）" : "（正席）"
            }${current ? "" : ` <em>${esc(row.reason || "已封存")}</em>`}</li>`;
          })
          .join("");

        const subLines = resume.substitutions
          .map((sub) => {
            const statusText = {
              awaiting: "待接班确认",
              confirmed: "已确认生效",
              voided: "重排作废"
            }[sub.status];
            return `<li>第${sub.effectiveMeasure}小节起 · ${esc(
              Rules.instrumentName(sub.instrument)
            )} · ${sub.role === "handover" ? "交接给" : "接班自"}${esc(
              Rules.musicianName(state, sub.otherId)
            )} <em>${statusText}</em></li>`;
          })
          .join("");

        const correctionLines = resume.corrections
          .map(
            (change) =>
              `<li>第${change.measure}小节到场 ${change.from ? "到场" : "缺席"} → ${
                change.to ? "到场" : "缺席"
              } <time>${formatTime(change.at)}</time></li>`
          )
          .join("");

        return `
        <article class="musician-card">
          <header>
            <strong>${esc(musician.name)}</strong>
            <small>司：${esc(skillText)}</small>
          </header>
          <div class="att-row">${attendance}</div>
          <ul class="resume">
            ${seatLines || "<li><em>暂无席位履历</em></li>"}
            ${subLines}
            ${correctionLines}
          </ul>
        </article>`;
      })
      .join("");
  }

  // ---------- 侧栏 / 结构 ----------

  function renderStructure(state) {
    els.structure.innerHTML = Rules.MEASURES.map((measure) => {
      const start = (measure - 1) * Rules.BEATS_PER_MEASURE;
      const count = state.pattern
        .flatMap((row) => row.slice(start, start + Rules.BEATS_PER_MEASURE))
        .filter(Boolean).length;
      const solo = Rules.measureHasSolo(state, measure);
      return `
        <div class="structure-row">
          <span>第${measure}小节${solo ? '<span class="chip warn">独奏</span>' : ""}</span>
          <strong>${count}个口令</strong>
        </div>`;
    }).join("");
  }

  function renderNotes(state) {
    els.notesList.innerHTML = state.notes.length
      ? state.notes.map((note) => `<article class="note"><p>${esc(note)}</p></article>`).join("")
      : "<p>暂无批注。</p>";
  }

  function renderSaved(state) {
    els.savedList.innerHTML = state.saved.length
      ? state.saved
          .map(
            (item) => `
        <button class="saved-item" type="button" data-load="${item.id}">
          <strong>${esc(item.name)}</strong><br>
          <span>${item.bpm}BPM · ${item.notes.length}条批注${
              item.solo ? " · 含独奏标注" : ""
            }</span>
        </button>`
          )
          .join("")
      : "<p>还没有保存方案。</p>";
  }

  // ---------- 顶部状态 ----------

  function syncControls(state) {
    if (document.activeElement !== els.pieceName) els.pieceName.value = state.pieceName;
    if (document.activeElement !== els.bpmInput) els.bpmInput.value = state.bpm;
    els.baselineText.textContent = `${state.baselineBpm} BPM`;
    if (document.activeElement !== els.hallSelect) els.hallSelect.value = state.currentHall;
    if (document.activeElement !== els.measureSelect) {
      els.measureSelect.value = String(state.currentMeasure);
    }
    if (document.activeElement !== els.loopSelect) els.loopSelect.value = state.loop;
    els.soloMode.checked = soloMode;

    const warnings = [];
    if (state.rearrangePending) {
      warnings.push(...state.rearrangeReasons);
    } else {
      const blocking = Rules.blockers(state, state.currentMeasure);
      warnings.push(...blocking.reasons);
    }
    if (state.rearrangePending) {
      els.banner.className = "banner danger";
      els.banner.innerHTML =
        '<strong>整段待重排</strong>：' +
        warnings.map((reason) => esc(reason)).join("；") +
        "。席位与替班请求一律拒绝，请先「执行整段重排」。";
    } else if (warnings.length) {
      els.banner.className = "banner warn";
      els.banner.innerHTML =
        "当前小节若申请替班将被阻断：" +
        warnings.map((reason) => esc(reason)).join("；") +
        "。";
    } else {
      els.banner.className = "banner hidden";
      els.banner.innerHTML = "";
    }
  }

  function announce(result, successText) {
    const reasons = result?.reasons || [];
    if (result?.ok) {
      if (successText || result.changed !== false) showToast(successText || "已登记", true);
      return;
    }
    showToast(reasons.join("；") || "请求被拒绝", false);
  }

  function showToast(message, ok) {
    els.toast.textContent = message;
    els.toast.className = `toast ${ok ? "ok" : "fail"}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.className = "toast hidden";
    }, 4200);
  }

  function renderAll() {
    const state = Store.getState();
    syncControls(state);
    renderGrid(state);
    renderStructure(state);
    renderNotes(state);
    renderSaved(state);
    renderSeatBoard(state);
    renderPending(state);
    renderConflicts(state);
    renderRoster(state);
  }

  // ---------- 事件 ----------

  function bindEvents() {
    els.grid.addEventListener("click", (event) => {
      const cell = event.target.closest(".cell");
      if (!cell) return;
      const row = Number(cell.dataset.row);
      const step = Number(cell.dataset.step);
      const state = Store.getState();

      if (soloMode) {
        const result = Rules.setSolo(state, { row, step, solo: !state.solo[row][step] });
        if (!result.ok) {
          announce(result);
          return;
        }
      } else {
        Store.update((draft) => {
          draft.pattern[row][step] = draft.pattern[row][step] ? "" : Rules.instruments[row].token;
          if (!draft.pattern[row][step]) draft.solo[row][step] = false;
        });
        return;
      }
      Store.save();
    });

    els.pieceName.addEventListener("input", () => {
      Store.update((draft) => {
        draft.pieceName = els.pieceName.value;
      });
    });

    els.bpmInput.addEventListener("input", () => {
      Store.update((draft) => {
        draft.bpm = Number(els.bpmInput.value || draft.baselineBpm);
      });
    });

    els.resetTempoBtn.addEventListener("click", () => {
      Store.update((draft) => {
        draft.bpm = draft.baselineBpm;
      });
      showToast("速度已恢复基准", true);
    });

    els.hallSelect.addEventListener("change", () => {
      Store.update((draft) => {
        draft.currentHall = els.hallSelect.value;
      });
    });

    els.measureSelect.addEventListener("change", () => {
      Store.update((draft) => {
        draft.currentMeasure = Number(els.measureSelect.value);
      });
    });

    els.loopSelect.addEventListener("change", () => {
      Store.update((draft) => {
        draft.loop = els.loopSelect.value;
      });
    });

    els.soloMode.addEventListener("change", () => {
      soloMode = els.soloMode.checked;
      showToast(soloMode ? "已进入独奏标注模式" : "已退出独奏标注模式", true);
    });

    els.noteInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !els.noteInput.value.trim()) return;
      const text = els.noteInput.value.trim();
      els.noteInput.value = "";
      Store.update((draft) => draft.notes.unshift(text));
    });

    els.saveBtn.addEventListener("click", () => {
      Store.update((draft) => {
        draft.saved.unshift({
          id: crypto.randomUUID(),
          name: draft.pieceName || "未命名片段",
          bpm: draft.bpm,
          baselineBpm: draft.baselineBpm,
          loop: draft.loop,
          notes: [...draft.notes],
          pattern: draft.pattern.map((row) => [...row]),
          solo: draft.solo.map((row) => [...row]),
          createdAt: new Date().toISOString()
        });
      });
      showToast("方案已保存", true);
    });

    els.savedList.addEventListener("click", (event) => {
      const id = event.target.closest("[data-load]")?.dataset.load;
      const item = Store.getState().saved.find((entry) => entry.id === id);
      if (!item) return;
      Store.update((draft) => {
        draft.pieceName = item.name;
        draft.bpm = item.bpm;
        draft.baselineBpm = item.baselineBpm || item.bpm;
        draft.loop = item.loop;
        draft.notes = [...item.notes];
        draft.pattern = item.pattern.map((row) => [...row]);
        draft.solo = item.solo ? item.solo.map((row) => [...row]) : draft.solo.map(() => Array(Rules.STEPS).fill(false));
      });
      showToast("已载入方案（席位记录保留）", true);
    });

    els.rearrangeBtn.addEventListener("click", () => {
      const result = Rules.executeRearrange(Store.getState());
      Store.save();
      announce(result, "已执行整段重排，旧安排封存，可重新排班");
    });

    els.clearConflictsBtn.addEventListener("click", () => {
      Store.update((draft) => {
        draft.conflicts = [];
      });
    });

    // 席位绑定 / 替班申请（事件委托）
    els.seatBoard.addEventListener("click", (event) => {
      const button = event.target.closest("[data-act]");
      if (!button) return;
      const state = Store.getState();
      const measure = Number(button.dataset.measure);
      const instrument = Number(button.dataset.inst);

      if (button.dataset.act === "bind") {
        const select = els.seatBoard.querySelector(
          `select[data-bind-select][data-measure="${measure}"][data-inst="${instrument}"]`
        );
        const result = Rules.bindSeat(state, {
          hallId: state.currentHall,
          measure,
          instrument,
          musicianId: select?.value
        });
        Store.save();
        announce(result, "席位已确认");
      }

      if (button.dataset.act === "request-sub") {
        const select = els.seatBoard.querySelector(
          `select[data-sub-select][data-measure="${measure}"][data-inst="${instrument}"]`
        );
        const result = Rules.requestSubstitute(state, {
          hallId: state.currentHall,
          measure,
          instrument,
          musicianId: select?.value
        });
        Store.save();
        if (result.ok) {
          announce(result, "替班申请已登记，等待接班乐师确认");
        } else if (result.rearrange) {
          announce(result);
        } else {
          announce(result);
        }
      }
    });

    els.pendingList.addEventListener("click", (event) => {
      const button = event.target.closest('[data-act="confirm-sub"]');
      if (!button) return;
      const result = Rules.confirmSubstitution(Store.getState(), { id: button.dataset.id });
      Store.save();
      announce(result, "接班已确认，替班自下一小节起生效");
    });

    els.roster.addEventListener("click", (event) => {
      const button = event.target.closest('[data-act="att"]');
      if (!button) return;
      const musicianId = button.dataset.musician;
      const measure = Number(button.dataset.measure);
      const state = Store.getState();
      const current = state.attendance.find(
        (record) => record.musicianId === musicianId && record.measure === measure
      );
      const result = Rules.markAttendance(state, {
        musicianId,
        measure,
        present: !(current && current.present)
      });
      Store.save();
      if (result.ok) {
        announce(
          result,
          result.changed
            ? `到场记录已更正，依赖席位已重算${
                result.changes?.length ? "：" + result.changes.join("；") : ""
              }`
            : ""
        );
      } else {
        announce(result);
      }
    });
  }

  function init() {
    els.grid = $("#grid");
    els.savedList = $("#savedList");
    els.structure = $("#structure");
    els.notesList = $("#notesList");
    els.pieceName = $("#pieceName");
    els.bpmInput = $("#bpmInput");
    els.baselineText = $("#baselineText");
    els.resetTempoBtn = $("#resetTempoBtn");
    els.hallSelect = $("#hallSelect");
    els.measureSelect = $("#measureSelect");
    els.loopSelect = $("#loopSelect");
    els.noteInput = $("#noteInput");
    els.soloMode = $("#soloMode");
    els.banner = $("#banner");
    els.toast = $("#toast");
    els.seatBoard = $("#seatBoard");
    els.boardHallName = $("#boardHallName");
    els.rearrangeBtn = $("#rearrangeBtn");
    els.pendingList = $("#pendingList");
    els.conflictList = $("#conflictList");
    els.clearConflictsBtn = $("#clearConflictsBtn");
    els.roster = $("#roster");
    els.saveBtn = $("#saveBtn");

    bindEvents();
    Store.subscribe(renderAll);
    renderAll();
  }

  document.addEventListener("DOMContentLoaded", init);

  return { renderAll };
})();
