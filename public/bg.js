/* ============================================================
   MAX — animated constellation background (canvas)
   Lightweight, GPU-friendly, respects reduced-motion.
   ============================================================ */
(() => {
  const canvas = document.getElementById("bg-canvas");
  if (!canvas) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ctx = canvas.getContext("2d");
  let w, h, dpr, particles = [], raf = null, mouse = { x: -9999, y: -9999 };

  const COLORS = ["124,92,255", "34,211,238", "255,95,162"];

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth = window.innerWidth;
    h = canvas.clientHeight = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }

  function seed() {
    const count = Math.min(90, Math.round((w * h) / 20000));
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.35,
      vy: (Math.random() - 0.5) * 0.35,
      r: Math.random() * 1.8 + 0.6,
      c: COLORS[(Math.random() * COLORS.length) | 0],
    }));
  }

  function step() {
    ctx.clearRect(0, 0, w, h);
    const linkDist = 130;

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.x += p.vx; p.y += p.vy;

      // gentle attraction to cursor
      const dxm = mouse.x - p.x, dym = mouse.y - p.y;
      const dm = Math.hypot(dxm, dym);
      if (dm < 160) { p.x += dxm * 0.0008 * (160 - dm) / 160; p.y += dym * 0.0008 * (160 - dm) / 160; }

      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${p.c},0.9)`;
      ctx.fill();

      for (let j = i + 1; j < particles.length; j++) {
        const q = particles[j];
        const dx = p.x - q.x, dy = p.y - q.y;
        const dist = Math.hypot(dx, dy);
        if (dist < linkDist) {
          const a = (1 - dist / linkDist) * 0.28;
          ctx.strokeStyle = `rgba(${p.c},${a})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.stroke();
        }
      }
    }
    raf = requestAnimationFrame(step);
  }

  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("mousemove", (e) => { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });
  window.addEventListener("mouseout", () => { mouse.x = -9999; mouse.y = -9999; });

  resize();
  if (!reduce) step();

  // pause when tab hidden to save CPU
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (raf) cancelAnimationFrame(raf), (raf = null); }
    else if (!reduce && !raf) step();
  });
})();
