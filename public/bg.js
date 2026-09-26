/* ============================================================
   MAX — animated constellation background (canvas)
   Lightweight: capped at 30 fps, squared-distance math, fewer particles on
   small screens, paused when the tab is hidden, and fully disabled in
   Performance mode / prefers-reduced-motion.
   ============================================================ */
(() => {
  const canvas = document.getElementById("bg-canvas");
  if (!canvas) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ctx = canvas.getContext("2d", { alpha: true });
  let w = 0, h = 0, dpr = 1, particles = [], raf = null, last = 0, enabled = !reduce;
  const mouse = { x: -9999, y: -9999 };
  const FRAME_MS = 1000 / 30;
  const LINK = 120, LINK2 = LINK * LINK;
  const COLORS = ["124,92,255", "34,211,238", "255,95,162"];

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    w = window.innerWidth; h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
    if (!enabled) ctx.clearRect(0, 0, w, h);
  }

  function seed() {
    const count = Math.min(w < 700 ? 28 : 60, Math.round((w * h) / 26000));
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.5, vy: (Math.random() - 0.5) * 0.5,
      r: Math.random() * 1.6 + 0.6,
      c: COLORS[(Math.random() * COLORS.length) | 0],
    }));
  }

  function step(t) {
    raf = requestAnimationFrame(step);
    if (t - last < FRAME_MS) return;
    last = t;
    ctx.clearRect(0, 0, w, h);
    const n = particles.length;
    for (let i = 0; i < n; i++) {
      const p = particles[i];
      p.x += p.vx; p.y += p.vy;
      const dxm = mouse.x - p.x, dym = mouse.y - p.y;
      const dm2 = dxm * dxm + dym * dym;
      if (dm2 < 25600) { const f = 0.0008 * (1 - Math.sqrt(dm2) / 160); p.x += dxm * f; p.y += dym * f; }
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
    }
    ctx.lineWidth = 1;
    for (let i = 0; i < n; i++) {
      const p = particles[i];
      for (let j = i + 1; j < n; j++) {
        const q = particles[j];
        const dx = p.x - q.x, dy = p.y - q.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < LINK2) {
          ctx.strokeStyle = `rgba(${p.c},${(1 - d2 / LINK2) * 0.26})`;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        }
      }
      ctx.fillStyle = `rgba(${p.c},0.9)`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill();
    }
  }

  const start = () => { if (enabled && !raf && !document.hidden) raf = requestAnimationFrame(step); };
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = null; };

  let rt = null;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(resize, 150); }, { passive: true });
  window.addEventListener("mousemove", (e) => { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });
  window.addEventListener("mouseout", () => { mouse.x = -9999; mouse.y = -9999; });
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));

  resize();
  start();

  window.MaxBg = {
    setEnabled(on) {
      enabled = Boolean(on) && !reduce;
      if (enabled) start(); else { stop(); ctx.clearRect(0, 0, w, h); }
    },
  };
})();
