// Read the network at full speed, but don't let a burst (even delta + done in one read)
// replace the entire bubble in one browser paint.
export function replyPreview(paint: (text: string) => void, signal: AbortSignal) {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let text = "", shown = 0, frame = 0, lastPaint = 0;
  let finished: (() => void) | undefined;

  function showAll(replace = false) {
    cancelAnimationFrame(frame); frame = 0;
    if (!signal.aborted && (replace || shown !== text.length)) { shown = text.length; paint(text); }
    finished?.();
  }
  function advance(now: number) {
    frame = 0;
    if (signal.aborted || shown === text.length || motion.matches || document.hidden) { showAll(); return; }
    const elapsed = lastPaint ? Math.max(1, now - lastPaint) : 16;
    // At typing speed for short bursts; catch up even on a long report in about half a second.
    const count = Math.ceil(elapsed * Math.max(0.18, text.length / 480));
    shown = Math.min(text.length, shown + count);
    if (shown < text.length && /[\uD800-\uDBFF]/.test(text[shown - 1])) shown++;
    paint(text.slice(0, shown)); lastPaint = now;
    frame = requestAnimationFrame(advance);
    if (shown === text.length) finished?.();
  }
  function update() {
    if (!frame) { lastPaint = 0; advance(performance.now()); }
  }
  function skipMotion() { if (motion.matches || document.hidden) showAll(); }
  function dispose() {
    cancelAnimationFrame(frame); frame = 0;
    document.removeEventListener("visibilitychange", skipMotion);
    motion.removeEventListener("change", skipMotion);
    signal.removeEventListener("abort", dispose);
    finished?.();
  }
  document.addEventListener("visibilitychange", skipMotion);
  motion.addEventListener("change", skipMotion);
  signal.addEventListener("abort", dispose, {once:true});
  return {
    append(delta: string) { text += delta; update(); },
    async finish(final: string) {
      const correction = !final.startsWith(text.slice(0, shown));
      text = final;
      if (correction) { showAll(true); return; }
      if (signal.aborted || shown === text.length) return;
      await new Promise<void>(resolve => { finished = resolve; update(); });
    },
    showAll, dispose
  };
}
