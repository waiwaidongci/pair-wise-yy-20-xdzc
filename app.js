/**
 * 编排层：播放锣鼓经、速度联动。
 * 席位规则、记录存储、页面展示分别在 LuoguRules / LuoguStore / LuoguView。
 */
(function () {
  "use strict";

  const Rules = globalThis.LuoguRules;
  const Store = globalThis.LuoguStore;

  let timer = null;
  let playhead = 0;
  let audioContext = null;

  function currentRange(state) {
    if (state.loop === "") return [0, Rules.STEPS - 1];
    const start = Number(state.loop) * Rules.BEATS_PER_MEASURE;
    return [start, start + Rules.BEATS_PER_MEASURE - 1];
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

  function clearHighlight() {
    document.querySelectorAll(".cell.playing").forEach((cell) => cell.classList.remove("playing"));
  }

  function tick() {
    const state = Store.getState();
    const [start, end] = currentRange(state);
    if (playhead < start || playhead > end) playhead = start;
    highlight(playhead);
    Rules.instruments.forEach((instrument, rowIndex) => {
      if (state.pattern[rowIndex][playhead]) playSound(instrument);
    });
    playhead = playhead >= end ? start : playhead + 1;
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    clearHighlight();
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelector("#playBtn").addEventListener("click", () => {
      clearInterval(timer);
      playhead = currentRange(Store.getState())[0];
      tick();
      timer = setInterval(tick, 60000 / Store.getState().bpm);
    });

    document.querySelector("#stopBtn").addEventListener("click", stop);

    // 速度或循环段变化时，保持播放并按新速度运行
    Store.subscribe((state) => {
      if (!timer) return;
      clearInterval(timer);
      timer = setInterval(tick, 60000 / state.bpm);
    });
  });
})();
