import { store } from "./js/seat-store.js";
import { instruments, STEPS, BEATS_PER_MEASURE, measureHasSolo, tempoDeviated } from "./js/seat-rules.js";
import { mountSeatDesk } from "./js/seat-ui.js";

const state = store.load();

let timer = null;
let playhead = 0;
let audioContext = null;

const grid = document.querySelector("#grid");
const savedList = document.querySelector("#savedList");
const structure = document.querySelector("#structure");
const notesList = document.querySelector("#notesList");
const pieceName = document.querySelector("#pieceName");
const bpmInput = document.querySelector("#bpmInput");
const baseBpmValue = document.querySelector("#baseBpmValue");
const loopSelect = document.querySelector("#loopSelect");
const noteInput = document.querySelector("#noteInput");
const soloToggle = document.querySelector("#soloToggle");

const steps = STEPS;

function syncFields() {
  pieceName.value = state.pieceName;
  bpmInput.value = state.bpm;
  baseBpmValue.textContent = state.baseBpm;
  loopSelect.value = state.loop;
  renderTempoBadge();
}

function beatLabel(index) {
  const measure = Math.floor(index / BEATS_PER_MEASURE) + 1;
  const beat = (index % BEATS_PER_MEASURE) + 1;
  return `${measure}-${beat}`;
}

function renderTempoBadge() {
  const el = document.querySelector("#tempoBadge");
  const deviated = tempoDeviated(state.bpm, state.baseBpm);
  el.textContent = deviated ? "速度已偏离基准（±10%）" : "速度在基准区间";
  el.className = `tempo-badge ${deviated ? "bad" : "ok"}`;
}

function renderGrid() {
  const header = ['<div class="label-cell">乐器</div>'];
  for (let i = 0; i < steps; i += 1) {
    const measure = Math.floor(i / BEATS_PER_MEASURE) + 1;
    const isMeasureStart = i % BEATS_PER_MEASURE === 0;
    const soloInMeasure = measureHasSolo(state.solo, measure);
    header.push(
      `<button type="button" class="beat-cell ${isMeasureStart ? "measure-head" : ""} ${measure === state.currentSlot ? "current-measure" : ""}" data-set-slot="${measure}" title="设为当前时段">
        ${beatLabel(i)}${isMeasureStart && soloInMeasure ? '<span class="solo-mark">独</span>' : ""}
      </button>`
    );
  }

  const rows = instruments.flatMap((instrument, rowIndex) => {
    const row = [`<div class="label-cell">${instrument.name}</div>`];
    for (let step = 0; step < steps; step += 1) {
      const value = state.pattern[rowIndex][step];
      const isSolo = state.solo[rowIndex][step];
      row.push(
        `<button class="cell ${value ? "filled" : ""} ${isSolo ? "solo" : ""}" type="button" data-row="${rowIndex}" data-step="${step}">${isSolo ? value + "❋" : value}</button>`
      );
    }
    return row;
  });

  grid.innerHTML = [...header, ...rows].join("");
}

function renderSidebars() {
  const filledByMeasure = [0, 1, 2, 3].map((measure) => {
    const start = measure * BEATS_PER_MEASURE;
    const count = state.pattern.flatMap((row) => row.slice(start, start + BEATS_PER_MEASURE)).filter(Boolean).length;
    const solo = measureHasSolo(state.solo, measure + 1);
    return { measure: measure + 1, count, solo };
  });
  structure.innerHTML = filledByMeasure.map((item) => `
    <div class="structure-row ${item.measure === state.currentSlot ? "now" : ""}">
      <span>第${item.measure}小节${item.measure === state.currentSlot ? "（当前）" : ""}${item.solo ? '<em class="solo-flag">独奏口令</em>' : ""}</span>
      <strong>${item.count}个口令</strong>
    </div>
  `).join("");

  notesList.innerHTML = state.notes.length ? state.notes.map((note) => `
    <article class="note"><p>${note}</p></article>
  `).join("") : "<p>暂无批注。</p>";

  savedList.innerHTML = state.saved.length ? state.saved.map((item) => `
    <button class="saved-item" type="button" data-load="${item.id}">
      <strong>${item.name}</strong><br><span>${item.bpm}BPM · 基准${item.baseBpm || item.bpm} · ${item.notes.length}条批注</span>
    </button>
  `).join("") : "<p>还没有保存方案。</p>";
}

function render() {
  syncFields();
  renderGrid();
  renderSidebars();
  desk.render();
}

function playSound(instrument) {
  audioContext ||= new AudioContext();
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.frequency.value = instrument.freq;
  osc.type = instrument.name === "鼓" ? "sine" : "square";
  gain.gain.setValueAtTime(0.08, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.08);
  osc.connect(gain).connect(audioContext.destination);
  osc.start();
  osc.stop(audioContext.currentTime + 0.09);
}

function highlight(step) {
  document.querySelectorAll(".cell.playing").forEach((cell) => cell.classList.remove("playing"));
  document.querySelectorAll(`[data-step="${step}"]`).forEach((cell) => cell.classList.add("playing"));
}

function currentRange() {
  if (state.loop === "") return [0, steps - 1];
  const start = Number(state.loop) * BEATS_PER_MEASURE;
  return [start, start + BEATS_PER_MEASURE - 1];
}

function tick() {
  const [start, end] = currentRange();
  if (playhead < start || playhead > end) playhead = start;
  highlight(playhead);
  const slot = Math.floor(playhead / BEATS_PER_MEASURE) + 1;
  if (slot !== state.currentSlot) {
    state.currentSlot = slot;
    store.saveScore();
    desk.render();
  }
  instruments.forEach((instrument, rowIndex) => {
    if (state.pattern[rowIndex][playhead]) playSound(instrument);
  });
  playhead = playhead >= end ? start : playhead + 1;
}

grid.addEventListener("click", (event) => {
  const slotBtn = event.target.closest("[data-set-slot]");
  if (slotBtn) {
    state.currentSlot = Number(slotBtn.dataset.setSlot);
    store.saveScore();
    render();
    return;
  }
  const cell = event.target.closest(".cell");
  if (!cell) return;
  const row = Number(cell.dataset.row);
  const step = Number(cell.dataset.step);
  if (soloToggle.checked) {
    if (!state.pattern[row][step]) state.pattern[row][step] = instruments[row].token;
    state.solo[row][step] = !state.solo[row][step];
  } else {
    state.pattern[row][step] = state.pattern[row][step] ? "" : instruments[row].token;
    if (!state.pattern[row][step]) state.solo[row][step] = false;
  }
  store.saveScore();
  render();
});

pieceName.addEventListener("input", () => {
  state.pieceName = pieceName.value;
  store.saveScore();
});

bpmInput.addEventListener("input", () => {
  state.bpm = Number(bpmInput.value || 96);
  store.saveScore();
  renderTempoBadge();
  desk.render();
  if (timer) {
    clearInterval(timer);
    timer = setInterval(tick, 60000 / state.bpm);
  }
});

document.querySelector("#setBaseBtn").addEventListener("click", () => {
  state.baseBpm = state.bpm;
  store.saveScore();
  syncFields();
  desk.render();
});

loopSelect.addEventListener("change", () => {
  state.loop = loopSelect.value;
  playhead = currentRange()[0];
  store.saveScore();
});

noteInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !noteInput.value.trim()) return;
  state.notes.unshift(noteInput.value.trim());
  noteInput.value = "";
  store.saveScore();
  renderSidebars();
});

document.querySelector("#playBtn").addEventListener("click", () => {
  if (timer) clearInterval(timer);
  playhead = currentRange()[0];
  tick();
  timer = setInterval(tick, 60000 / state.bpm);
});

document.querySelector("#stopBtn").addEventListener("click", () => {
  clearInterval(timer);
  timer = null;
  document.querySelectorAll(".cell.playing").forEach((cell) => cell.classList.remove("playing"));
});

document.querySelector("#saveBtn").addEventListener("click", () => {
  store.saveScheme();
  renderSidebars();
});

savedList.addEventListener("click", (event) => {
  const id = event.target.closest("[data-load]")?.dataset.load;
  const item = state.saved.find((entry) => entry.id === id);
  if (!item) return;
  store.loadScheme(item);
  render();
});

// 挂载乐师席位台：规则 / 存储 / 展示 三个模块在此组装
const desk = mountSeatDesk({
  getState: () => state,
  derive: () => store.derived(),
  append: (events) => store.append(events),
  newId: () => store.newId(),
  setCurrentSlot: (slot) => {
    state.currentSlot = slot;
    store.saveScore();
    render();
  },
  rerender: () => render()
});

render();
