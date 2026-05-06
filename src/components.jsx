const { useEffect, useMemo, useRef, useState } = React;
const { motion } = window.Motion || { motion: { div: "div", span: "span", p: "p", section: "section" } };

function ArrowUpRight({ className = "h-5 w-5" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7 17L17 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M7 7h10v10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlayIcon({ className = "h-4 w-4" }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  );
}

function BlueLogo({ compact = false }) {
  return (
    <span className={`blue-wordmark ${compact ? "blue-wordmark-compact" : ""}`} aria-label="Blue">
      <span className="blue-wordmark-orbit" aria-hidden="true" />
      <span className="blue-wordmark-text">Blue</span>
      <span className="blue-wordmark-spark" aria-hidden="true" />
    </span>
  );
}

function MaterialIcon({ path }) {
  return (
    <svg className="h-6 w-6 text-white" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg className="h-7 w-7 text-white" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 7v5l3.5 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg className="h-7 w-7 text-white" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4 12h16M12 4c2 2.2 3 4.9 3 8s-1 5.8-3 8M12 4c-2 2.2-3 4.9-3 8s1 5.8 3 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function FadingVideo({ src, className = "", style = {} }) {
  const videoRef = useRef(null);
  const rafRef = useRef(null);
  const FADE_MS = 500;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    const fadeTo = (target, duration) => {
      cancelAnimationFrame(rafRef.current);
      const start = Number.parseFloat(video.style.opacity || "0") || 0;
      const startedAt = performance.now();

      const tick = (now) => {
        const progress = Math.min((now - startedAt) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        video.style.opacity = String(start + (target - start) * eased);
        if (progress < 1) rafRef.current = requestAnimationFrame(tick);
      };

      rafRef.current = requestAnimationFrame(tick);
    };

    const onLoadedData = () => {
      video.style.opacity = "0";
      video.play().catch(() => {});
      fadeTo(1, FADE_MS);
    };

    const onTimeUpdate = () => {
      if (!video.duration) return;
      const remaining = video.duration - video.currentTime;
      if (remaining <= 0.08 && remaining > 0) {
        video.currentTime = 0.05;
        video.play().catch(() => {});
        video.style.opacity = "1";
      }
    };

    const onEnded = () => {
      video.currentTime = 0.05;
      video.style.opacity = "1";
      video.play().catch(() => {});
    };

    video.addEventListener("loadeddata", onLoadedData);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("ended", onEnded);
    if (video.readyState >= 2) onLoadedData();

    return () => {
      cancelAnimationFrame(rafRef.current);
      video.removeEventListener("loadeddata", onLoadedData);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("ended", onEnded);
    };
  }, [src]);

  return (
    <video
      ref={videoRef}
      src={src}
      className={`fading-video ${className}`}
      style={{ opacity: 0, ...style }}
      autoPlay
      muted
      playsInline
      preload="auto"
    />
  );
}

function BlurText({ text, className = "", highlights = [], delay = 0 }) {
  const ref = useRef(null);
  const words = text.split(" ");
  const highlightSet = new Set(highlights.map((w) => w.toLowerCase()));

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const wordEls = node.querySelectorAll(".blur-word");
    const gsap = window.gsap;

    const finalize = (el) => {
      // Mark revealed first → CSS :not([data-revealed]) rule stops applying,
      // freeing the element from initial-state styles and re-enabling transitions.
      el.dataset.revealed = "1";
      el.style.opacity = "";
      el.style.filter = "";
      el.style.transform = "";
      el.style.visibility = "";
      el.style.willChange = "";
    };

    if (!gsap) {
      wordEls.forEach(finalize);
      return undefined;
    }

    gsap.set(wordEls, { autoAlpha: 0, filter: "blur(20px)", y: 50, force3D: true });
    const tween = gsap.to(wordEls, {
      autoAlpha: 1,
      filter: "blur(0px)",
      y: 0,
      duration: 0.95,
      stagger: 0.11,
      delay,
      ease: "power3.out",
      force3D: true,
      onComplete: () => wordEls.forEach(finalize),
    });

    // Safety: ensure visible even if tween is interrupted somehow
    const safety = setTimeout(() => {
      wordEls.forEach((el) => {
        if (!el.dataset.revealed) finalize(el);
      });
    }, 4000);

    return () => {
      tween.kill();
      clearTimeout(safety);
    };
  }, [text, delay]);

  return (
    <p ref={ref} className={className} style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", rowGap: "0.1em" }}>
      {words.map((word, i) => {
        const clean = word.replace(/[^a-zA-Z]/g, "").toLowerCase();
        const isHighlighted = highlightSet.has(clean);
        return (
          <span
            key={`${word}-${i}`}
            className="blur-word"
            style={{
              display: "inline-block",
              marginRight: "0.28em",
              color: isHighlighted ? "#FFE44D" : "inherit",
            }}
          >
            {word}
          </span>
        );
      })}
    </p>
  );
}

function ParticleWaveCanvas({ style = {} }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    let width = 0, height = 0, particles = [], raf = 0, t = 0;

    const mkParticle = () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      r: Math.random() * 1.6 + 0.5,
      o: Math.random() * 0.35 + 0.1,
    });

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      particles = Array.from({ length: 55 }, mkParticle);
    };

    const frame = () => {
      t += 0.007;
      ctx.clearRect(0, 0, width, height);

      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > width) p.vx *= -1;
        if (p.y < 0 || p.y > height) p.vy *= -1;
      }

      // Particle connections
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a = particles[i], b = particles[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < 130) {
            ctx.strokeStyle = `rgba(255,255,255,${(1 - d / 130) * 0.15})`;
            ctx.lineWidth = 0.7;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // Particle dots
      for (const p of particles) {
        ctx.fillStyle = `rgba(255,255,255,${p.o})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Waveform layers
      const wy = height * 0.66;
      const waves = [
        { a: 22, f: 0.013, ph: t,          alpha: 0.55, lw: 2   },
        { a: 13, f: 0.020, ph: t * 1.35,   alpha: 0.25, lw: 1.2 },
        { a:  8, f: 0.029, ph: t * 0.75,   alpha: 0.15, lw: 1   },
      ];

      for (const w of waves) {
        ctx.beginPath();
        for (let x = 0; x <= width; x += 3) {
          const y = wy
            + Math.sin(x * w.f + w.ph) * w.a
            + Math.sin(x * w.f * 2.2 + w.ph * 1.4) * (w.a * 0.38)
            + Math.sin(x * w.f * 0.65 + w.ph * 0.85) * (w.a * 0.52);
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `rgba(255,255,255,${w.alpha})`;
        ctx.lineWidth = w.lw;
        ctx.stroke();
      }

      // Subtle glow beneath the main wave
      const grad = ctx.createLinearGradient(0, wy - 25, 0, wy + 70);
      grad.addColorStop(0, "rgba(255,255,255,0.035)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, wy - 25, width, 95);

      raf = requestAnimationFrame(frame);
    };

    resize();
    window.addEventListener("resize", resize);
    raf = requestAnimationFrame(frame);
    return () => {
      window.removeEventListener("resize", resize);
      cancelAnimationFrame(raf);
    };
  }, []);

  return <canvas ref={canvasRef} className="neural-canvas" style={style} aria-hidden="true" />;
}

function DonutChart({ title, data }) {
  const colors = window.BLUE_CHART_COLORS;
  const entries = Object.entries(data)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  let start = 0;

  const polar = (cx, cy, radius, angle) => {
    const radians = ((angle - 90) * Math.PI) / 180;
    return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
  };

  const arc = (x, y, radius, startAngle, endAngle) => {
    const startPoint = polar(x, y, radius, endAngle);
    const endPoint = polar(x, y, radius, startAngle);
    const large = endAngle - startAngle <= 180 ? 0 : 1;
    return `M ${startPoint.x} ${startPoint.y} A ${radius} ${radius} 0 ${large} 0 ${endPoint.x} ${endPoint.y}`;
  };

  if (!total) {
    return (
      <div className="liquid-glass tilt-card dashboard-card rounded-[1.25rem] p-5 text-white" data-tilt="card">
        <p className="font-body text-sm text-white/70">{title}</p>
        <p className="mt-4 font-heading text-3xl font-bold leading-none">Collecting</p>
        <p className="mt-2 max-w-[28ch] font-body text-sm font-light text-white/80">Play music through Blue or connect Spotify, and this chart becomes real.</p>
      </div>
    );
  }

  return (
    <div className="liquid-glass tilt-card dashboard-card rounded-[1.25rem] p-5 text-white" data-tilt="card">
      <p className="font-body text-sm text-white/70">{title}</p>
      <div className="mt-4 grid grid-cols-[120px_1fr] items-center gap-4 max-sm:grid-cols-1">
        <svg viewBox="0 0 100 100" className="h-[120px] w-[120px]" role="img" aria-label={`${title} chart`}>
          <circle cx="50" cy="50" r="35" fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth="13" />
          {entries.map(([name, value], index) => {
            const angle = (value / total) * 360;
            const path = arc(50, 50, 35, start, start + angle);
            start += angle;
            return <path key={name} className="donut-path" d={path} fill="none" stroke={colors[index % colors.length]} strokeWidth="13" strokeLinecap="round" />;
          })}
          <text x="50" y="48" textAnchor="middle" fill="#fff" fontSize="9" fontFamily="Space Grotesk, system-ui" fontWeight="600">
            {total}
          </text>
          <text x="50" y="60" textAnchor="middle" fill="rgba(255,255,255,0.72)" fontSize="7" fontFamily="Space Grotesk, system-ui">
            plays
          </text>
        </svg>
        <div className="grid gap-2">
          {entries.map(([name, value], index) => (
            <div className="flex items-center gap-2 font-body text-sm text-white/85" key={name}>
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: colors[index % colors.length] }} />
              <span className="truncate">{name}</span>
              <span className="ml-auto text-white/60">{Math.round((value / total) * 100)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── GSAP reveal setup ──────────────────────────────────────────────────────
const TILT_REST_TRANSFORM = "perspective(900px) rotateX(0deg) rotateY(0deg) translateZ(0px)";
const isTiltElement = (el) =>
  el.classList.contains("tilt-card") || el.classList.contains("alive-button");

// Cleanly hand the element off from GSAP-controlled state to its resting layout.
// 1) data-revealed is set FIRST so the [data-reveal]:not([data-revealed]) CSS rule
//    (transition:none, opacity:0, blur, will-change) stops matching.
// 2) Inline styles GSAP set during the tween are then cleared. For tilt elements
//    we explicitly write the tilt rest-state transform so future hover-tilt
//    mutations interpolate inline→inline (same function list) — no matrix-fallback
//    interpolation that would otherwise cause sub-pixel layout drift for 180ms.
function finalizeReveal(el) {
  el.dataset.revealed = "1";
  el.style.opacity = "";
  el.style.visibility = "";
  el.style.filter = "";
  el.style.willChange = "";
  if (isTiltElement(el)) {
    el.style.transform = TILT_REST_TRANSFORM;
  } else {
    el.style.transform = "";
  }
}

function setupReveal() {
  const gsap = window.gsap;
  const ST   = window.ScrollTrigger;

  if (!gsap) {
    document.querySelectorAll("[data-reveal],[data-hero]").forEach(finalizeReveal);
    return;
  }

  if (ST) gsap.registerPlugin(ST);

  // ── Page-load overlay fade out ──────────────────────────────────────────
  const overlay = document.getElementById("page-load-overlay");
  if (overlay && !overlay.dataset.faded) {
    overlay.dataset.faded = "1";
    gsap.to(overlay, {
      opacity: 0,
      duration: 0.65,
      delay: 0.05,
      ease: "power2.out",
      onComplete: () => { overlay.style.display = "none"; },
    });
  }

  // ── Hero elements — play once on mount ─────────────────────────────────
  document.querySelectorAll("[data-hero]").forEach((el) => {
    if (el.dataset.revealed || el.dataset.revealQueued) return;
    el.dataset.revealQueued = "1";
    const i = Number(el.dataset.hero || 0);
    gsap.set(el, { autoAlpha: 0, filter: "blur(20px)", y: 28, force3D: true });
    gsap.to(el, {
      autoAlpha: 1,
      filter: "blur(0px)",
      y: 0,
      duration: 1.0,
      delay: 0.3 + i * 0.16,
      ease: "power3.out",
      force3D: true,
      onComplete: () => finalizeReveal(el),
    });
  });

  // ── Scroll-triggered reveal — one-shot, GPU-friendly, reliable ─────────
  if (!ST) {
    document.querySelectorAll("[data-reveal]").forEach(finalizeReveal);
    return;
  }

  document.querySelectorAll("[data-reveal]").forEach((el) => {
    if (el.dataset.revealed || el.dataset.revealQueued) return;
    el.dataset.revealQueued = "1";
    gsap.set(el, { autoAlpha: 0, filter: "blur(18px)", y: 36, force3D: true });
    gsap.to(el, {
      autoAlpha: 1,
      filter: "blur(0px)",
      y: 0,
      duration: 1.0,
      ease: "power2.out",
      force3D: true,
      onComplete: () => finalizeReveal(el),
      scrollTrigger: {
        trigger: el,
        start: "top 88%",
        toggleActions: "play none none none",
        once: true,
      },
    });
  });

  // Refresh ScrollTrigger after fonts/images settle so positions are accurate
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => ST.refresh()).catch(() => {});
  }
  setTimeout(() => ST.refresh(), 250);
  setTimeout(() => ST.refresh(), 1200);

  // ── Safety net — anything still hidden after 5s gets force-shown ───────
  setTimeout(() => {
    document.querySelectorAll("[data-reveal],[data-hero]").forEach((el) => {
      if (el.dataset.revealed) return;
      const cs = getComputedStyle(el);
      if (parseFloat(cs.opacity) < 0.15 || cs.visibility === "hidden") finalizeReveal(el);
    });
  }, 5000);
}

window.ArrowUpRight = ArrowUpRight;
window.PlayIcon = PlayIcon;
window.BlueLogo = BlueLogo;
window.MaterialIcon = MaterialIcon;
window.ClockIcon = ClockIcon;
window.GlobeIcon = GlobeIcon;
window.FadingVideo = FadingVideo;
window.BlurText = BlurText;
window.ParticleWaveCanvas = ParticleWaveCanvas;
window.DonutChart = DonutChart;
window.setupReveal = setupReveal;
