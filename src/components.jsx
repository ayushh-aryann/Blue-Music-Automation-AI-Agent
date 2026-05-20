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

/* ── Donut Chart ──────────────────────────────────────────────────────────
   Interactive donut for the dashboard's mood/genre splits. Each arc draws
   in via stroke-dashoffset on mount and on data change. Hover an arc OR
   the matching legend row to highlight both; the center label morphs to
   show that segment's name + share. Mood charts accept `onSelect` so a
   click filters the chat panel's active mood. The ambient gradient behind
   the SVG picks up the dominant segment's color.
   ───────────────────────────────────────────────────────────────────── */
function DonutChart({ title, data, kind = "generic", activeName, onSelect }) {
  const moodColors  = window.BLUE_MOOD_COLORS  || {};
  const genreColors = window.BLUE_GENRE_COLORS || {};
  const palette     = window.BLUE_CHART_COLORS;
  const colorFor = (name, i) => {
    if (kind === "mood"  && moodColors[name])  return moodColors[name];
    if (kind === "genre" && genreColors[name]) return genreColors[name];
    return palette[i % palette.length];
  };

  const entries = Object.entries(data)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  const dataKey = entries.map(([n, v]) => `${n}:${v}`).join("|");

  // Re-trigger the draw-in animation on every data change. We bump a counter
  // so React's key changes on the arc paths, remounting them with
  // strokeDashoffset=100, and then a microtask flip starts the tween.
  const [drawNonce, setDrawNonce] = React.useState(0);
  const [drawn, setDrawn] = React.useState(false);
  React.useEffect(() => {
    setDrawn(false);
    setDrawNonce((n) => n + 1);
    const t = setTimeout(() => setDrawn(true), 30);
    return () => clearTimeout(t);
  }, [dataKey]);

  const [hovered, setHovered] = React.useState(null); // segment name or null

  const polar = (cx, cy, r, angle) => {
    const rad = ((angle - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  };
  const arc = (x, y, r, a0, a1) => {
    const p0 = polar(x, y, r, a1);
    const p1 = polar(x, y, r, a0);
    const large = a1 - a0 <= 180 ? 0 : 1;
    return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${large} 0 ${p1.x} ${p1.y}`;
  };

  // Build segments with arc paths and per-segment colors
  let cursor = 0;
  const segments = entries.map(([name, value], index) => {
    const angle = (value / total) * 360;
    const path  = arc(50, 50, 35, cursor, cursor + angle);
    const seg   = { name, value, path, color: colorFor(name, index), pct: (value / total) * 100 };
    cursor += angle;
    return seg;
  });

  const dominant = segments[0];
  const activeSeg = hovered != null ? segments.find((s) => s.name === hovered) : null;
  const isInteractive = typeof onSelect === "function";

  if (!total) {
    return (
      <div className="liquid-glass dashboard-card donut-chart donut-chart--empty rounded-[1.25rem] p-5 text-white">
        <div className="donut-chart__ambient" aria-hidden="true" />
        <div className="relative z-10">
          <p className="font-body text-sm text-white/70">{title}</p>
          <p className="mt-4 font-heading text-3xl font-bold leading-none">Collecting</p>
          <p className="mt-2 max-w-[28ch] font-body text-sm font-light text-white/80">Play music through Blue or connect Spotify, and this chart becomes real.</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`liquid-glass dashboard-card donut-chart rounded-[1.25rem] p-5 text-white ${isInteractive ? "donut-chart--interactive" : ""}`}
      style={{ "--donut-color": (activeSeg || dominant).color }}
    >
      <div className="donut-chart__ambient" aria-hidden="true" />

      <div className="relative z-10 flex items-baseline justify-between gap-3">
        <p className="font-body text-sm text-white/70">{title}</p>
        <span className="font-body text-[11px] uppercase tracking-[0.15em] text-white/45">{total} plays</span>
      </div>

      <div className="relative z-10 mt-4 grid grid-cols-[140px_1fr] items-center gap-5 max-sm:grid-cols-1 max-sm:justify-items-center">
        <svg
          viewBox="0 0 100 100"
          className="donut-chart__svg h-[140px] w-[140px]"
          role="img"
          aria-label={`${title} chart`}
          onMouseLeave={() => setHovered(null)}
        >
          <circle cx="50" cy="50" r="35" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="13" />
          {segments.map((seg) => {
            const dim     = activeSeg && activeSeg.name !== seg.name;
            const active  = activeSeg && activeSeg.name === seg.name;
            const filter  = activeName === seg.name;
            return (
              <path
                key={`${drawNonce}|${seg.name}`}
                d={seg.path}
                pathLength="100"
                stroke={seg.color}
                strokeWidth={active ? 17 : 13}
                strokeLinecap="round"
                fill="none"
                className={`donut-chart__arc ${dim ? "donut-chart__arc--dim" : ""} ${active ? "donut-chart__arc--active" : ""} ${filter ? "donut-chart__arc--filter" : ""}`}
                style={{
                  strokeDashoffset: drawn ? 0 : 100,
                  color: seg.color, // for color-mix in CSS
                }}
                onMouseEnter={() => setHovered(seg.name)}
                onClick={() => isInteractive && onSelect(seg.name)}
              />
            );
          })}
          {/* Center: morphs between aggregate total and hovered segment */}
          <g className="donut-chart__center" style={{ pointerEvents: "none" }}>
            <text x="50" y={activeSeg ? 44 : 49} textAnchor="middle" className="donut-chart__num" fill="#fff">
              {activeSeg ? `${Math.round(activeSeg.pct)}%` : total}
            </text>
            <text x="50" y={activeSeg ? 54 : 60} textAnchor="middle" className="donut-chart__num-label" fill="rgba(255,255,255,0.6)">
              {activeSeg ? "share" : "plays"}
            </text>
            {activeSeg && (
              <text x="50" y={66} textAnchor="middle" className="donut-chart__num-name" fill={activeSeg.color}>
                {activeSeg.name.length > 12 ? activeSeg.name.slice(0, 11) + "…" : activeSeg.name}
              </text>
            )}
          </g>
        </svg>

        <div className="grid w-full gap-1">
          {segments.map((seg) => {
            const active = activeSeg?.name === seg.name;
            const filter = activeName === seg.name;
            const Row = isInteractive ? "button" : "div";
            const rowProps = isInteractive
              ? { type: "button", onClick: () => onSelect(seg.name) }
              : {};
            return (
              <Row
                {...rowProps}
                key={seg.name}
                className={`donut-chart__row ${active ? "is-hover" : ""} ${filter ? "is-filter" : ""} ${isInteractive ? "is-clickable" : ""}`}
                onMouseEnter={() => setHovered(seg.name)}
                onMouseLeave={() => setHovered(null)}
                style={{ "--row-color": seg.color }}
                title={isInteractive ? `Filter chat to ${seg.name}` : undefined}
              >
                <span className="donut-chart__dot" style={{ background: seg.color }} />
                <span className="truncate font-body text-sm text-white/85">{seg.name}</span>
                <span className="ml-auto font-body text-xs tabular-nums text-white/55">
                  {Math.round(seg.pct)}%
                </span>
              </Row>
            );
          })}
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

/* ── Mic dispersed-pixel wobble ──────────────────────────────────────────── */
/* Localized canvas inside the mic button. Renders a soft cloud of pixels
   arranged on a circle that wobble organically and react to mic amplitude
   (via getUserMedia + AnalyserNode) when the browser permits it. Falls back
   to a procedural pseudo-amplitude so the animation always looks alive. */
function MicWobble({ active }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!active) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d");
    let raf = 0;
    let stopped = false;

    // Canvas size must stay within the chat input wrap's vertical padding so
    // the wrap's overflow-hidden does not clip the wobble. 56px box around a
    // 40px mic button leaves an 8px aura — enough for the dispersed pixels
    // to drift outside the button without visible cropping.
    const SIZE = 56; // logical px — must match the CSS .mic-wobble width/height
    const dpr  = window.devicePixelRatio || 1;
    canvas.width  = Math.floor(SIZE * dpr);
    canvas.height = Math.floor(SIZE * dpr);
    canvas.style.width  = `${SIZE}px`;
    canvas.style.height = `${SIZE}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Particle ring — count + jitter tuned for ~64px box
    const N = 42;
    const particles = Array.from({ length: N }, (_, i) => {
      const angle = (i / N) * Math.PI * 2;
      return {
        angle,
        seed: Math.random() * 1000,
        speed: 0.7 + Math.random() * 0.6,
        rJitter: Math.random() * 1.4,
        sizeJitter: Math.random() * 0.7,
      };
    });

    // Optional audio amplitude
    let analyser = null;
    let dataArr = null;
    let stream = null;
    let audioCtx = null;

    const setupAudio = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) return;
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 64;
        analyser.smoothingTimeConstant = 0.75;
        source.connect(analyser);
        dataArr = new Uint8Array(analyser.frequencyBinCount);
      } catch {
        analyser = null;
      }
    };
    setupAudio();

    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const baseR = 14;
    let smoothAmp = 0;

    const draw = () => {
      const now = performance.now() / 1000;

      // Read amplitude (0..1)
      let amp = 0;
      if (analyser && dataArr) {
        analyser.getByteFrequencyData(dataArr);
        let sum = 0;
        for (let i = 0; i < dataArr.length; i++) sum += dataArr[i];
        amp = sum / dataArr.length / 255;
      } else {
        // Procedural fallback — gentle "speaking" oscillation
        amp = 0.25 + 0.18 * (Math.sin(now * 2.4) * 0.5 + 0.5)
                   + 0.12 * (Math.sin(now * 6.7 + 1.3) * 0.5 + 0.5);
      }
      // Snappy attack, soft release
      smoothAmp = amp > smoothAmp
        ? smoothAmp + (amp - smoothAmp) * 0.45
        : smoothAmp + (amp - smoothAmp) * 0.12;

      ctx.clearRect(0, 0, SIZE, SIZE);

      // Soft yellow halo behind the ring — strength tracks amplitude
      const haloR = baseR + 12 + smoothAmp * 8;
      const halo = ctx.createRadialGradient(cx, cy, baseR * 0.4, cx, cy, haloR);
      halo.addColorStop(0, `rgba(255, 228, 77, ${0.22 + smoothAmp * 0.28})`);
      halo.addColorStop(1, "rgba(255, 228, 77, 0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
      ctx.fill();

      // Dispersed pixel ring — each particle wobbles radially + tangentially.
      const drift = now * 0.35; // slow rotation
      for (const p of particles) {
        const wobbleR =
          Math.sin(now * p.speed + p.seed) * (1.6 + smoothAmp * 4.5) +
          Math.cos(now * p.speed * 1.7 + p.seed * 0.3) * (1.0 + smoothAmp * 2.5);
        const wobbleA =
          Math.sin(now * 0.9 + p.seed * 1.1) * 0.06 +
          Math.cos(now * 1.4 + p.seed) * 0.04;

        const r = baseR + wobbleR + p.rJitter + smoothAmp * 5;
        const a = p.angle + drift + wobbleA;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;

        const size = 0.9 + smoothAmp * 1.6 + p.sizeJitter;
        const alpha = 0.55 + smoothAmp * 0.45;

        ctx.fillStyle = `rgba(255, 228, 77, ${alpha})`;
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();

        // A subtle white inner glint on louder peaks for premium feel
        if (smoothAmp > 0.18) {
          ctx.fillStyle = `rgba(255, 255, 255, ${(smoothAmp - 0.18) * 0.6})`;
          ctx.beginPath();
          ctx.arc(x, y, size * 0.45, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch {}
      try { if (audioCtx) audioCtx.close(); } catch {}
    };
  }, [active]);

  if (!active) return null;
  return <canvas ref={canvasRef} className="mic-wobble" aria-hidden="true" />;
}

/* ═════════════════════════════════════════════════════════════════════════
   MUSIC COSMOS — modular live music-themed background system.
   Architecture (back → front):
     1.  <AuroraGradient />   pure CSS animated gradient haze
     2.  <MusicCosmos />      one canvas drawing orbs + particles + waveform
     3.  <MusicNotesLayer />  CSS-animated drifting glyphs (♪ ♫ ♬ ♩ 𝄞)
     4.  <VinylDisc />        slow-rotating decorative vinyl (hero only)
     5.  <EqualizerStrip />   pulsing EQ bars (hero only)
     6.  <DashboardAccent />  subtle bottom glow + faint EQ (dashboard only)

   The canvas uses one rAF loop, additive blending for orb/wave glow, and
   adapts particle/orb counts to viewport + prefers-reduced-motion. CSS layers
   ride the GPU compositor (transform + opacity only).
   ═══════════════════════════════════════════════════════════════════════ */

function AuroraGradient() {
  return (
    <>
      <div className="aurora-bg" aria-hidden="true" />
      <div className="aurora-bg aurora-bg--alt" aria-hidden="true" />
    </>
  );
}

function MusicCosmos({ variant = "site" }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d");

    const isMobile = window.matchMedia?.("(max-width: 768px)")?.matches;
    const reduce   = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const dpr      = Math.min(window.devicePixelRatio || 1, isMobile ? 1.25 : 1.6);

    const COUNTS = {
      orbs:  reduce ? 0 : variant === "dashboard" ? (isMobile ? 3 : 5)  : (isMobile ? 4 : 8),
      parts: reduce ? 0 : variant === "dashboard" ? (isMobile ? 24 : 50) : (isMobile ? 38 : 95),
    };

    // Cool neon palette — covers blue / purple / cyan / yellow / pink / mint
    const ORB_COLORS = [
      [86, 130, 255],    // electric blue
      [168, 85, 247],    // purple
      [34, 211, 238],    // cyan
      [255, 228, 77],    // signature yellow
      [236, 72, 153],    // pink
      [16, 185, 129],    // mint
      [99, 102, 241],    // indigo
      [125, 211, 252],   // sky
    ];

    let width = 0, height = 0;
    let orbs = [], parts = [];
    let raf = 0, lastTime = performance.now(), t = 0;
    let scrollY = window.scrollY || 0;

    const init = () => {
      const rect = canvas.getBoundingClientRect();
      width  = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width  = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      orbs = Array.from({ length: COUNTS.orbs }, (_, i) => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.16,
        vy: (Math.random() - 0.5) * 0.10,
        baseR: (variant === "dashboard" ? 110 : 150) + Math.random() * (variant === "dashboard" ? 90 : 200),
        color: ORB_COLORS[i % ORB_COLORS.length],
        phase: Math.random() * Math.PI * 2,
        depth: 0.55 + Math.random() * 0.45, // for parallax
      }));

      parts = Array.from({ length: COUNTS.parts }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.22,
        vy: -0.10 - Math.random() * 0.30, // particles drift upward like sparks
        size: 0.55 + Math.random() * 1.4,
        baseAlpha: 0.10 + Math.random() * 0.45,
        twinkle: Math.random() * Math.PI * 2,
        twinkleRate: 1.4 + Math.random() * 2.6,
      }));
    };

    const onResize = () => init();
    const onScroll = () => { scrollY = window.scrollY || 0; };

    init();
    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });

    const BEAT_SECONDS = 0.6; // ~100 BPM heart-rate pulse

    const frame = (now) => {
      const dt = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;
      t += dt;

      // Procedural "beat": sharp thump with a softer offbeat at the half.
      const phase = (t % BEAT_SECONDS) / BEAT_SECONDS;
      const thump   = Math.exp(-Math.pow(phase * 6, 2));
      const offbeat = Math.exp(-Math.pow((phase - 0.5) * 6, 2)) * 0.45;
      const beat = thump + offbeat;

      ctx.clearRect(0, 0, width, height);

      // ── Layer 1: deep void gradient ──────────────────────────────────────
      const cx = width * 0.5, cy = height * 0.42;
      const radial = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(width, height));
      radial.addColorStop(0, "rgba(18, 14, 42, 1)");
      radial.addColorStop(0.55, "rgba(8, 5, 22, 1)");
      radial.addColorStop(1, "rgba(0, 0, 0, 1)");
      ctx.fillStyle = radial;
      ctx.fillRect(0, 0, width, height);

      // ── Layer 2: glowing neon orbs (additive) ───────────────────────────
      ctx.globalCompositeOperation = "lighter";
      const parallaxY = scrollY * 0.05; // slow parallax on scroll
      for (const orb of orbs) {
        orb.x += orb.vx;
        orb.y += orb.vy;
        const margin = orb.baseR + 60;
        if (orb.x < -margin)         orb.x = width + margin;
        if (orb.x > width + margin)  orb.x = -margin;
        if (orb.y < -margin)         orb.y = height + margin;
        if (orb.y > height + margin) orb.y = -margin;

        const pulse = 0.78 + 0.22 * beat + 0.07 * Math.sin(t * 0.8 + orb.phase);
        const r = orb.baseR * pulse;
        const drawY = orb.y - parallaxY * orb.depth;
        const [R, G, B] = orb.color;
        const grad = ctx.createRadialGradient(orb.x, drawY, 0, orb.x, drawY, r);
        const a = (variant === "dashboard" ? 0.10 : 0.16) * pulse;
        grad.addColorStop(0,   `rgba(${R},${G},${B},${a})`);
        grad.addColorStop(0.45,`rgba(${R},${G},${B},${a * 0.4})`);
        grad.addColorStop(1,   `rgba(${R},${G},${B},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(orb.x, drawY, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── Layer 3: drifting twinkle particles ─────────────────────────────
      for (const p of parts) {
        p.x += p.vx;
        p.y += p.vy;
        p.twinkle += dt * p.twinkleRate;
        if (p.y < -8) { p.y = height + 8; p.x = Math.random() * width; }
        if (p.x < 0)      p.x += width;
        if (p.x > width)  p.x -= width;
        const flicker = 0.55 + 0.45 * Math.sin(p.twinkle);
        const a = p.baseAlpha * flicker * (0.78 + 0.22 * beat);
        ctx.fillStyle = `rgba(255, 255, 255, ${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── Layer 4: stacked beat-modulated waveforms across the bottom ─────
      const wy = height * (variant === "dashboard" ? 0.88 : 0.78);
      const layers = variant === "dashboard"
        ? [
            { amp: 10 + 6 * beat,  freq: 0.018, speed: 0.5, lw: 1.0, color: "rgba(125, 211, 252, 0.32)" },
            { amp:  6 + 4 * beat,  freq: 0.030, speed: 0.9, lw: 0.7, color: "rgba(255, 228, 77, 0.20)" },
          ]
        : [
            { amp: 22 + 16 * beat, freq: 0.012, speed: 0.45, lw: 1.6, color: "rgba(86, 198, 255, 0.55)" },
            { amp: 16 + 12 * beat, freq: 0.020, speed: 0.75, lw: 1.1, color: "rgba(168, 85, 247, 0.45)" },
            { amp: 10 +  8 * beat, freq: 0.030, speed: 1.20, lw: 0.8, color: "rgba(255, 228, 77, 0.42)" },
            { amp:  7 +  5 * beat, freq: 0.045, speed: 1.80, lw: 0.6, color: "rgba(236, 72, 153, 0.32)" },
          ];
      for (const layer of layers) {
        ctx.strokeStyle = layer.color;
        ctx.lineWidth = layer.lw;
        ctx.beginPath();
        for (let x = 0; x <= width; x += 4) {
          const y = wy
            + Math.sin(x * layer.freq + t * layer.speed) * layer.amp
            + Math.sin(x * layer.freq * 2.3 + t * layer.speed * 1.4) * layer.amp * 0.4
            + Math.sin(x * layer.freq * 0.6 + t * layer.speed * 0.7) * layer.amp * 0.5;
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // Soft glow under the wave for depth
      ctx.globalCompositeOperation = "lighter";
      const glow = ctx.createLinearGradient(0, wy - 30, 0, wy + 80);
      glow.addColorStop(0, "rgba(86, 198, 255, 0.04)");
      glow.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, wy - 30, width, 110);

      ctx.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll);
    };
  }, [variant]);

  return <canvas ref={canvasRef} className={`music-cosmos music-cosmos--${variant}`} aria-hidden="true" />;
}

function MusicNotesLayer({ count = 14, variant = "site" }) {
  const NOTES = ["♪", "♫", "♬", "♩", "𝄞", "𝅘𝅥𝅮"];
  const HUES  = ["#7dd3fc", "#a855f7", "#FFE44D", "#34d399", "#f0abfc", "#60a5fa"];

  const items = useMemo(() => {
    const n = variant === "dashboard" ? Math.max(4, Math.floor(count * 0.45)) : count;
    return Array.from({ length: n }, (_, i) => ({
      char: NOTES[Math.floor(Math.random() * NOTES.length)],
      left: Math.random() * 100,
      duration: 14 + Math.random() * 22,
      delay: -Math.random() * 30,
      size: (variant === "dashboard" ? 12 : 16) + Math.random() * (variant === "dashboard" ? 10 : 22),
      drift: (Math.random() - 0.5) * 80,
      hue: HUES[i % HUES.length],
      tilt: (Math.random() - 0.5) * 30,
      opacity: variant === "dashboard" ? 0.32 : 0.55,
    }));
  }, [count, variant]);

  return (
    <div className={`music-notes-layer music-notes-layer--${variant}`} aria-hidden="true">
      {items.map((n, i) => (
        <span
          key={`note-${i}`}
          className="music-note"
          style={{
            left: `${n.left}%`,
            fontSize: `${n.size}px`,
            color: n.hue,
            opacity: n.opacity,
            animationDuration: `${n.duration}s`,
            animationDelay: `${n.delay}s`,
            "--drift": `${n.drift}px`,
            "--tilt": `${n.tilt}deg`,
            textShadow: `0 0 12px ${n.hue}, 0 0 28px ${n.hue}80`,
          }}
        >
          {n.char}
        </span>
      ))}
    </div>
  );
}

function VinylDisc() {
  return (
    <div className="vinyl-disc" aria-hidden="true">
      <div className="vinyl-disc__grooves" />
      <div className="vinyl-disc__label" />
      <div className="vinyl-disc__center" />
    </div>
  );
}

function EqualizerStrip({ bars = 28 }) {
  const heights = useMemo(
    () => Array.from({ length: bars }, () => 0.4 + Math.random() * 0.6),
    [bars],
  );
  return (
    <div className="eq-strip" aria-hidden="true">
      {heights.map((h, i) => (
        <span
          key={`eq-${i}`}
          style={{
            animationDelay: `${(i * 0.045 + Math.random() * 0.1).toFixed(3)}s`,
            animationDuration: `${(0.7 + h * 0.6).toFixed(2)}s`,
          }}
        />
      ))}
    </div>
  );
}

function HeroAccent() {
  return (
    <>
      <VinylDisc />
      <EqualizerStrip />
      <div className="hero-spotlight" aria-hidden="true" />
    </>
  );
}

function DashboardAccent() {
  return (
    <div className="dashboard-accent" aria-hidden="true">
      <div className="dashboard-accent__glow" />
      <div className="dashboard-accent__bars">
        {Array.from({ length: 18 }).map((_, i) => (
          <span
            key={`db-bar-${i}`}
            style={{ animationDelay: `${(i * 0.06).toFixed(2)}s` }}
          />
        ))}
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════
   LIVE MUSIC PLAYER — album art + karaoke-synced lyrics + progress
   - <AlbumCover>     extracts a dominant color from the cover and uses it
                      to drive ambient glow + beat pulse rings
   - <LyricsView>     renders synced lyrics with a CSS-transformed scroll
                      track; only re-renders when active line changes
   - <ProgressBar>    rAF-driven, mutates DOM directly to avoid re-renders
   - <LiveMusicPlayer> composes the above plus blurred album-art backdrop
   ═══════════════════════════════════════════════════════════════════════ */

function AlbumCover({ track, isPlaying }) {
  const [palette, setPalette] = useState({
    glow: "rgba(168, 85, 247, 0.55)",
    rgb: "168,85,247",
    accent: "rgba(255, 228, 77, 0.55)",
  });

  useEffect(() => {
    if (!track?.albumArt) {
      setPalette({ glow: "rgba(168, 85, 247, 0.55)", rgb: "168,85,247", accent: "rgba(255, 228, 77, 0.55)" });
      return undefined;
    }
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => {
      if (cancelled) return;
      try {
        const SAMPLE = 24;
        const c = document.createElement("canvas");
        c.width = SAMPLE; c.height = SAMPLE;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
        const data = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data;
        // Two-pass: average of saturated pixels (primary), best single pixel (accent).
        let pr = 0, pg = 0, pb = 0, pn = 0;
        let bestR = 168, bestG = 85, bestB = 247, bestScore = -1;
        for (let i = 0; i < data.length; i += 4) {
          const R = data[i], G = data[i + 1], B = data[i + 2];
          const max = Math.max(R, G, B), min = Math.min(R, G, B);
          const sat = max ? (max - min) / max : 0;
          const lum = max / 255;
          if (sat > 0.30 && lum > 0.22 && lum < 0.92) {
            pr += R; pg += G; pb += B; pn += 1;
          }
          const score = sat * Math.min(1, lum * 1.3);
          if (score > bestScore) { bestScore = score; bestR = R; bestG = G; bestB = B; }
        }
        let r, g, b;
        if (pn > 8) { r = Math.round(pr / pn); g = Math.round(pg / pn); b = Math.round(pb / pn); }
        else        { r = bestR; g = bestG; b = bestB; }
        setPalette({
          glow:   `rgba(${r}, ${g}, ${b}, 0.6)`,
          rgb:    `${r},${g},${b}`,
          accent: `rgba(${bestR}, ${bestG}, ${bestB}, 0.6)`,
        });
      } catch {
        // Cross-origin or decode failure — keep default palette.
      }
    };
    img.onerror = () => {};
    img.src = track.albumArt;
    return () => { cancelled = true; };
  }, [track?.albumArt]);

  const hasArt = !!track?.albumArt;
  const cssVars = {
    "--cover-glow":      palette.glow,
    "--cover-glow-rgb":  palette.rgb,
    "--cover-accent":    palette.accent,
  };

  return (
    <div className={`album-cover-wrap ${isPlaying ? "is-playing" : ""}`} style={cssVars}>
      <div className="album-cover-pulse" />
      <div className="album-cover-pulse album-cover-pulse--alt" />
      <div className="album-cover-orbit" />
      <div className={`album-cover ${hasArt ? "" : "album-cover--placeholder"}`}>
        {hasArt ? (
          <img
            key={track.albumArt}
            src={track.albumArt}
            alt={track.album || track.title || "Album cover"}
            className="album-cover__img"
            draggable="false"
          />
        ) : (
          <div className="album-cover__placeholder-art">
            <span className="album-cover__placeholder-glyph">♫</span>
          </div>
        )}
        <div className="album-cover__shine" />
      </div>
    </div>
  );
}

function LyricsView({ lyrics, playback, isPlaying, fallbackText = "" }) {
  const [activeIndex, setActiveIndex] = useState(-1);
  const lastIndexRef = useRef(-1);
  const trackRef = useRef(null);

  // Reset when the underlying lyrics array swaps.
  useEffect(() => {
    lastIndexRef.current = -1;
    setActiveIndex(-1);
  }, [lyrics]);

  // rAF tick that finds the active line via binary search and only triggers
  // a setState (and therefore a re-render) when it crosses to a new line.
  useEffect(() => {
    if (!lyrics || !lyrics.synced || !Array.isArray(lyrics.lines) || !lyrics.lines.length) {
      return undefined;
    }
    let raf = 0;
    const lines = lyrics.lines;
    const tick = () => {
      const elapsed = isPlaying ? performance.now() - (playback.lastSyncAt || 0) : 0;
      const ms = (playback.progressMs || 0) + elapsed;
      let lo = 0, hi = lines.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid].time <= ms) { ans = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (ans !== lastIndexRef.current) {
        lastIndexRef.current = ans;
        setActiveIndex(ans);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [lyrics, playback.progressMs, playback.lastSyncAt, isPlaying]);

  if (lyrics?.loading) {
    return (
      <div className="lyrics-empty">
        <span className="lyrics-empty__glyph">♪</span>
        <p>Listening for lyrics…</p>
      </div>
    );
  }

  // No synced lyrics — fall back to static plain text if we got it.
  if (!lyrics?.synced || !lyrics?.lines?.length) {
    if (lyrics?.plain) {
      const sample = String(lyrics.plain).split(/\r?\n/).filter(Boolean).slice(0, 14);
      return (
        <div className="lyrics-static">
          <p className="lyrics-static__hint">Plain lyrics — no timing data</p>
          {sample.map((line, i) => (
            <div key={`pl-${i}`} className="lyrics-static__line">{line}</div>
          ))}
        </div>
      );
    }
    return (
      <div className="lyrics-empty">
        <span className="lyrics-empty__glyph">♫</span>
        <p>{fallbackText || "Lyrics not available — just vibing."}</p>
      </div>
    );
  }

  // Synced — render karaoke-style scroll track.
  const lines = lyrics.lines;
  const offsetIndex = activeIndex >= 0 ? activeIndex : 0;

  return (
    <div className="lyrics-viewport">
      <div className="lyrics-viewport__fade lyrics-viewport__fade--top" />
      <div className="lyrics-viewport__fade lyrics-viewport__fade--bottom" />
      <div
        ref={trackRef}
        className="lyrics-track"
        style={{ "--active-index": offsetIndex }}
      >
        {lines.map((line, i) => {
          const dist = i - activeIndex;
          let cls = "lyric-line";
          if (activeIndex < 0)        cls += " is-future";
          else if (i === activeIndex) cls += " is-active";
          else if (i < activeIndex)   cls += " is-past";
          else                        cls += " is-future";
          if (Math.abs(dist) > 5)     cls += " is-far";
          return (
            <div key={`ly-${i}-${line.time}`} className={cls}>
              {line.text || "♪"}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProgressBar({ playback, isPlaying }) {
  const fillRef  = useRef(null);
  const dotRef   = useRef(null);
  const nowRef   = useRef(null);
  const totalRef = useRef(null);

  useEffect(() => {
    const dur = playback.durationMs || 0;
    if (totalRef.current) totalRef.current.textContent = formatTime(dur);

    if (!dur) {
      if (fillRef.current) fillRef.current.style.width = "0%";
      if (dotRef.current)  dotRef.current.style.left   = "0%";
      if (nowRef.current)  nowRef.current.textContent  = "0:00";
      return undefined;
    }

    let raf = 0;
    let lastShownSec = -1;
    const tick = () => {
      const elapsed = isPlaying ? performance.now() - (playback.lastSyncAt || 0) : 0;
      const ms = Math.min(dur, (playback.progressMs || 0) + elapsed);
      const pct = (ms / dur) * 100;
      if (fillRef.current) fillRef.current.style.width = `${pct.toFixed(2)}%`;
      if (dotRef.current)  dotRef.current.style.left   = `${pct.toFixed(2)}%`;
      const sec = Math.floor(ms / 1000);
      if (nowRef.current && sec !== lastShownSec) {
        nowRef.current.textContent = formatTime(ms);
        lastShownSec = sec;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playback.progressMs, playback.lastSyncAt, playback.durationMs, isPlaying]);

  return (
    <div className="progress-row">
      <span ref={nowRef} className="progress-row__time">0:00</span>
      <div className="progress-bar">
        <div ref={fillRef} className="progress-bar__fill" />
        <div ref={dotRef}  className="progress-bar__dot"  />
      </div>
      <span ref={totalRef} className="progress-row__time progress-row__time--total">0:00</span>
    </div>
  );
}

function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/* ── YouTube IFrame Player ───────────────────────────────────────────────
   Loads the YouTube IFrame Player API on demand and mounts a player that
   replaces the album-art tile while a YT track is active. We keep a single
   player instance and cue new videos into it rather than tearing it down,
   which avoids the heavy re-init cost between tracks.
   ─────────────────────────────────────────────────────────────────────── */
function YouTubeIFramePlayer({ video, onClose }) {
  const containerRef = useRef(null);
  const playerRef    = useRef(null);
  const [ready, setReady] = useState(false);
  // Track which candidate we've tried so we can walk the list on embed error.
  // candidates includes the initial videoId at index 0.
  const candidatesRef = useRef([]);
  const candidateIdxRef = useRef(0);
  const [activeVideo, setActiveVideo] = useState(video);

  // When the parent passes a new `video`, reset the candidate cursor.
  useEffect(() => {
    candidatesRef.current = Array.isArray(video?.candidates) && video.candidates.length
      ? video.candidates
      : (video?.videoId ? [{ videoId: video.videoId, title: video.title, channel: video.channel, thumbnail: video.thumbnail }] : []);
    candidateIdxRef.current = 0;
    setActiveVideo(video);
  }, [video?.videoId]);

  // YouTube IFrame error codes:
  //   2   — invalid videoId (malformed)
  //   5   — HTML5 player can't play this content
  //   100 — video removed / private
  //   101 — embedding disabled by owner (third-party domain)
  //   150 — same as 101 (different surface)
  // 101/150 are the common ones for big-label uploads. On any of these we
  // advance to the next ranked candidate from the server.
  const tryNextCandidate = () => {
    const next = candidateIdxRef.current + 1;
    const list = candidatesRef.current;
    if (next >= list.length) return false;
    candidateIdxRef.current = next;
    const cand = list[next];
    setActiveVideo({ ...cand, candidates: list });
    try { playerRef.current?.loadVideoById?.(cand.videoId); } catch {}
    return true;
  };

  useEffect(() => {
    let cancelled = false;
    const ensureApi = () => new Promise((resolve) => {
      if (window.YT && window.YT.Player) return resolve();
      const prior = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prior?.(); resolve(); };
      if (!document.querySelector("script[data-yt-iframe]")) {
        const s = document.createElement("script");
        s.src = "https://www.youtube.com/iframe_api";
        s.async = true;
        s.dataset.ytIframe = "1";
        document.head.appendChild(s);
      }
    });

    ensureApi().then(() => {
      if (cancelled || !containerRef.current) return;
      if (playerRef.current) {
        // Cue the new video — much faster than recreating the player.
        try { playerRef.current.loadVideoById(video.videoId); } catch {}
        return;
      }
      playerRef.current = new window.YT.Player(containerRef.current, {
        height: "100%",
        width:  "100%",
        videoId: video.videoId,
        playerVars: {
          autoplay:       1,
          modestbranding: 1,
          playsinline:    1,
          rel:            0,
          enablejsapi:    1,
          controls:       1,
          origin:         window.location.origin,
        },
        events: {
          onReady: () => setReady(true),
          onError: (e) => {
            const code = e?.data;
            if (code === 101 || code === 150 || code === 100 || code === 5) {
              tryNextCandidate();
            }
          },
        },
      });
    });

    return () => { cancelled = true; };
  }, [video?.videoId]);

  // Tear down on unmount
  useEffect(() => () => {
    try { playerRef.current?.destroy?.(); } catch {}
    playerRef.current = null;
  }, []);

  if (!video?.videoId) return null;

  return (
    <div className="yt-player-wrap">
      <div className="yt-player">
        <div ref={containerRef} className="yt-player__iframe" />
        {!ready && (
          <div className="yt-player__loading">
            <span className="yt-player__spinner" />
            <span>Loading YouTube…</span>
          </div>
        )}
      </div>
      <div className="yt-player__meta">
        <p className="yt-player__hint">YouTube source</p>
        <p className="yt-player__title" title={activeVideo?.title || video.title}>{activeVideo?.title || video.title || "Untitled"}</p>
        {(activeVideo?.channel || video.channel) && <p className="yt-player__channel" title={activeVideo?.channel || video.channel}>{activeVideo?.channel || video.channel}</p>}
      </div>
      <button type="button" className="yt-player__close alive-button" onClick={onClose} title="Switch back to the album view">
        ×
      </button>
    </div>
  );
}

function LiveMusicPlayer({ track, lyrics, playback, isPlaying, onPlay, onPause, onNext, bridge, activeProvider, setActiveProvider, youtubeVideo, setYoutubeVideo }) {
  const t = track || {};
  const hasTrack = !!t.title;
  const isYouTube = !!youtubeVideo?.videoId;
  const sourceLabel = isYouTube
    ? "YouTube"
    : (t.source || (hasTrack && bridge?.spotify ? "Spotify" : ""));

  const fallbackMsg = hasTrack
    ? `No lyrics on file for "${t.title}". Catalog catches up over time.`
    : (bridge?.spotify
        ? "Press play on any track and Blue will tune in."
        : "Connect Spotify or pick YouTube from the provider chips and I'll route through.");

  return (
    <div
      data-reveal
      className={`live-player ${hasTrack ? "is-active" : "is-idle"} ${isPlaying ? "is-playing" : ""} ${isYouTube ? "is-youtube" : ""}`}
    >
      {/* Blurred backdrop — uses YouTube thumb when YT is active, otherwise
          the album art. Falls back to the gradient idle backdrop. */}
      <div
        className="live-player__backdrop"
        style={(() => {
          const url = isYouTube
            ? youtubeVideo?.thumbnail
            : (hasTrack && t.albumArt ? t.albumArt : "");
          return url ? { backgroundImage: `url(${url})` } : {};
        })()}
      />
      <div className="live-player__veil" />

      <div className="live-player__inner">
        <div className="live-player__art">
          {isYouTube ? (
            <YouTubeIFramePlayer
              video={youtubeVideo}
              onClose={() => setYoutubeVideo?.(null)}
            />
          ) : (
            <AlbumCover track={t} isPlaying={isPlaying} />
          )}
        </div>

        <div className="live-player__main">
          <div className="live-player__head">
            <p className="live-player__label">
              <span className="live-player__dot" />
              {hasTrack || isYouTube ? (isPlaying ? "Now playing" : "Paused") : "Standing by"}
              {sourceLabel && (
                <span className="live-player__source">{sourceLabel}</span>
              )}
            </p>
            <h3 className="live-player__title" title={t.title || ""}>
              {t.title || (isYouTube ? youtubeVideo.title : "Nothing playing yet")}
            </h3>
            <p className="live-player__artist" title={t.artist || ""}>
              {t.artist || (isYouTube ? youtubeVideo.channel : "—")}
            </p>
          </div>

          {!isYouTube && <ProgressBar playback={playback} isPlaying={isPlaying} />}

          <div className="live-player__controls">
            <button
              type="button"
              className="alive-button live-player__btn live-player__btn--ghost"
              data-tilt="button"
              onClick={onPause}
              title={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? "❚❚" : "▶"}
            </button>
            <button
              type="button"
              className="alive-button live-player__btn live-player__btn--ghost"
              data-tilt="button"
              onClick={onNext}
              title="Next"
            >
              ⏭
            </button>
            {!hasTrack && !isYouTube && (
              <button
                type="button"
                className="alive-button live-player__btn live-player__btn--primary"
                data-tilt="button"
                onClick={onPlay}
                title="Play recommendation"
              >
                Play recommendation
              </button>
            )}
            {isYouTube && (
              <button
                type="button"
                className="alive-button live-player__btn live-player__btn--ghost"
                data-tilt="button"
                onClick={() => setYoutubeVideo?.(null)}
                title="Close YouTube"
              >
                Close YT
              </button>
            )}
          </div>

          {!isYouTube && (
            <div className="live-player__lyrics">
              <LyricsView
                lyrics={lyrics || { loading: false, synced: false, lines: [], plain: "" }}
                playback={playback}
                isPlaying={isPlaying}
                fallbackText={fallbackMsg}
              />
            </div>
          )}
        </div>
      </div>

      {/* Floating beat-synced particles around the player */}
      <div className="live-player__particles" aria-hidden="true">
        {Array.from({ length: 8 }).map((_, i) => (
          <span
            key={`lp-p-${i}`}
            style={{
              left:               `${(i * 12 + 6) % 100}%`,
              animationDelay:     `${(i * 0.45).toFixed(2)}s`,
              animationDuration:  `${(5 + (i % 4)).toFixed(1)}s`,
            }}
          />
        ))}
      </div>
    </div>
  );
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
window.MicWobble = MicWobble;
window.AuroraGradient = AuroraGradient;
window.MusicCosmos = MusicCosmos;
window.MusicNotesLayer = MusicNotesLayer;
window.VinylDisc = VinylDisc;
window.EqualizerStrip = EqualizerStrip;
window.HeroAccent = HeroAccent;
window.DashboardAccent = DashboardAccent;
window.AlbumCover = AlbumCover;
window.LyricsView = LyricsView;
window.ProgressBar = ProgressBar;
window.LiveMusicPlayer = LiveMusicPlayer;
window.YouTubeIFramePlayer = YouTubeIFramePlayer;
window.setupReveal = setupReveal;
