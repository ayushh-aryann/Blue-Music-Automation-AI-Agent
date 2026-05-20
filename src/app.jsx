const STORAGE_KEY = "blue-listening-events-v3";
const CONVERSATION_KEY = "blue-conversation-v1";
const PROVIDER_KEY     = "blue-active-provider-v1";

// MicWobble is declared via `function MicWobble` in components.jsx, which puts it
// on the global scope. We don't redeclare it here — JSX <MicWobble /> resolves
// to that global at render time. (Redeclaring as `const MicWobble = ...` would
// throw "Identifier 'MicWobble' has already been declared" at parse time since
// all three Babel-standalone scripts share one program-level scope.)

const iconPaths = {
  scenery: "M5 21q-.825 0-1.412-.587T3 19V5q0-.825.588-1.412T5 3h14q.825 0 1.413.588T21 5v14q0 .825-.587 1.413T19 21H5Zm1-4h12l-3.75-5-3 4L9 13l-3 4Z",
  movie:
    "M4 6.47 5.76 10H20v8H4V6.47M22 4h-4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.89-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4Z",
  light:
    "M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1Zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7Z",
};

function installTiltEffect() {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const onMove = (e) => {
    const t = e.target.closest("[data-tilt]");
    if (!t) return;
    const r = t.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top)  / r.height - 0.5;
    const s = t.dataset.tilt === "button" ? 10 : 7;
    t.style.setProperty("--tilt-rx", `${clamp(-y * s, -8, 8)}deg`);
    t.style.setProperty("--tilt-ry", `${clamp(x * s, -10, 10)}deg`);
    t.style.setProperty("--tilt-tz", t.dataset.tilt === "button" ? "20px" : "28px");
    t.style.setProperty("--glow-x", `${e.clientX - r.left}px`);
    t.style.setProperty("--glow-y", `${e.clientY - r.top}px`);
    t.style.transform = `perspective(900px) rotateX(${clamp(-y*s,-8,8)}deg) rotateY(${clamp(x*s,-10,10)}deg) translateZ(${t.dataset.tilt==="button"?"20px":"28px"})`;
    t.classList.add("is-tilting");
  };
  const onOut = (e) => {
    const t = e.target.closest("[data-tilt]");
    if (!t || t.contains(e.relatedTarget)) return;
    t.style.setProperty("--tilt-rx", "0deg");
    t.style.setProperty("--tilt-ry", "0deg");
    t.style.setProperty("--tilt-tz", "0px");
    t.style.transform = "";
    t.classList.remove("is-tilting");
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerout",  onOut);
  return () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerout",  onOut);
  };
}

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; }
  catch { return fallback; }
}
function saveJson(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

function normalizeTrack(track, source = "Blue") {
  const rawGenre = track.genre || "Unknown";
  const bucketed = normalizeGenreClient(rawGenre);
  return {
    id: track.id || `${track.title}-${track.artist}-${Date.now()}`,
    title:  track.title  || "Unknown track",
    artist: track.artist || "Unknown artist",
    band:   track.band   || track.artist || "Unknown artist",
    genre:  bucketed === "Unknown" ? rawGenre : bucketed,
    mood:   track.mood   || inferMood(`${track.title||""} ${track.artist||""} ${rawGenre}`),
    query:  track.query  || `${track.title||""} ${track.artist||""}`.trim(),
    uri:    track.uri    || "",
    previewUrl: track.previewUrl || "",
    source,
    playedAt: track.playedAt || new Date().toISOString(),
  };
}

function inferMood(text) {
  const v = text.toLowerCase();
  if (/rock|guitar|hype|drive|gym|electric|party|loud|rage|metal/.test(v)) return "Electric";
  if (/night|dark|late|505|midnight|2am|3am/.test(v))                        return "Late Night";
  if (/work|focus|study|code|grind|lock in/.test(v))                          return "Focused";
  if (/sad|deep|remember|miss|emotional|parindey|nostalg|melanchol/.test(v)) return "Reflective";
  if (/calm|peace|soft|kun|sufi|ambient|meditat/.test(v))                    return "Calm";
  return "Chill";
}

// Mirror of server's GENRE_BUCKETS so the dashboard chart re-buckets legacy events
// stored in localStorage and any source that didn't go through the server normalizer.
const GENRE_BUCKETS_CLIENT = [
  ["Hip-Hop",   /\b(hip[\s-]?hop|rap|trap|drill|grime|boom bap)\b/],
  ["Bollywood", /\b(bollywood|filmi|hindi|desi|punjabi|bhangra|mumbai)\b/],
  ["Sufi",      /\b(sufi|qawwali|ghazal)\b/],
  ["K-Pop",     /\bk[\s-]?pop\b/],
  ["J-Pop",     /\bj[\s-]?pop\b/],
  ["Latin",     /\b(reggaeton|salsa|latin|bachata|cumbia|samba|bossa nova)\b/],
  ["Reggae",    /\b(reggae|dub|ska|dancehall)\b/],
  ["Metal",     /\b(metal|metalcore|deathcore|djent)\b/],
  ["Punk",      /\b(punk|hardcore|emo|screamo)\b/],
  ["R&B",       /\b(r&b|rnb|soul|neo[\s-]?soul|funk|motown)\b/],
  ["Electronic",/\b(edm|house|techno|dubstep|trance|electronic|electronica|drum and bass|dnb|garage|breakbeat|idm|future bass|electro|synthwave|synth pop|synth-pop|synthpop)\b/],
  ["Jazz",      /\b(jazz|bebop|swing|bossa|fusion)\b/],
  ["Classical", /\b(classical|opera|baroque|orchestra|symphony|chamber)\b/],
  ["Country",   /\b(country|honky tonk|nashville)\b/],
  ["Folk",      /\b(folk|americana|bluegrass|singer[\s-]?songwriter)\b/],
  ["Indie",     /\b(indie|bedroom pop|lo[\s-]?fi|chillwave|dream pop|shoegaze|psychedelic pop)\b/],
  ["Pop",       /\b(pop|disco|new wave)\b/],
  ["Rock",      /\b(rock|grunge|britpop|post[\s-]?rock|psych|garage rock|stoner|alt|alternative)\b/],
];

function normalizeGenreClient(raw) {
  if (!raw) return "Unknown";
  const known = new Set(["Hip-Hop","Bollywood","Sufi","K-Pop","J-Pop","Latin","Reggae","Metal","Punk","R&B","Electronic","Jazz","Classical","Country","Folk","Indie","Pop","Rock","Other","Unknown"]);
  if (known.has(raw)) return raw;
  const lower = String(raw).toLowerCase();
  for (const [bucket, re] of GENRE_BUCKETS_CLIENT) {
    if (re.test(lower)) return bucket;
  }
  return "Other";
}

function countBy(events, key) {
  return events.reduce((acc, e) => { const v = e[key]||"Unknown"; acc[v]=(acc[v]||0)+1; return acc; }, {});
}
function topOf(events, key) {
  return Object.entries(countBy(events, key)).sort((a,b)=>b[1]-a[1])[0]?.[0] || "Collecting";
}
function mergeEvents(existing, incoming) {
  const map = new Map();
  [...incoming, ...existing].forEach((e) => {
    const s = e.playedAt ? new Date(e.playedAt).toISOString().slice(0,19) : "";
    map.set(`${e.title}|${e.artist}|${s}`, e);
  });
  return [...map.values()].sort((a,b)=>new Date(b.playedAt)-new Date(a.playedAt)).slice(0,300);
}
function pickRecommendation(mood, events) {
  const fav = countBy(events, "artist");
  return [...window.BLUE_FALLBACK_CATALOG]
    .map((s)=>({...s, score:(s.mood===mood?60:15)+(fav[s.artist]||0)*8+Math.random()*6}))
    .sort((a,b)=>b.score-a.score)[0];
}

// Like pickRecommendation but the *currently playing* track drives the seed.
// Genre match weighs heaviest, then mood, then a small artist-similarity bonus
// (same artist but a different song reads as "more of this", not a loop). The
// currently-playing track itself is excluded so we never recommend what's
// already on. Random jitter keeps successive refreshes from feeling deterministic.
function pickNextRecommendation(currentTrack, events, mood) {
  const fav = countBy(events, "artist");
  const curGenre  = currentTrack?.genre  || "";
  const curArtist = currentTrack?.artist || "";
  const curTitle  = currentTrack?.title  || "";
  const curMood   = currentTrack?.mood   || mood;
  const pool = window.BLUE_FALLBACK_CATALOG.filter(
    (s) => !(s.title === curTitle && s.artist === curArtist),
  );
  return [...pool]
    .map((s) => {
      let score = 0;
      if (curGenre  && s.genre  === curGenre)  score += 60;
      if (curMood   && s.mood   === curMood)   score += 40;
      if (curArtist && s.artist === curArtist) score += 18;   // related, not identical
      score += (fav[s.artist] || 0) * 5;
      score += Math.random() * 8;
      return { ...s, score };
    })
    .sort((a, b) => b.score - a.score)[0];
}
function chooseBlueVoice(voices=[]) {
  const usable = voices.filter((v)=>/^en/i.test(v.lang||""));
  // Prefer neural / natural voices first — they handle contractions and pacing far better.
  const neural = usable.find((v)=>/natural|neural|online|premium/i.test(v.name||""));
  if (neural) return neural;
  for (const name of ["Microsoft Aria","Google UK English Female","Microsoft Jenny","Microsoft Guy","Google US English","Microsoft Zira","Microsoft David"]) {
    const found = usable.find((v)=>v.name.includes(name));
    if (found) return found;
  }
  return usable[0]||voices[0]||null;
}
function makeSpeechText(text="") {
  return String(text)
    // Strip emojis and pictographic symbols before TTS — otherwise the browser
    // synthesizer reads them aloud as their Unicode names ("face with tears of
    // joy", "headphone", etc). \p{Extended_Pictographic} covers the full emoji
    // range; ️ is the variation selector, ‍ the ZWJ used in compound
    // emojis like 👨‍🚀.
    .replace(/[\p{Extended_Pictographic}️‍]/gu, "")
    // Light, human-feeling punctuation pacing — no forced "Ayush," after every name
    .replace(/\bI am\b/g, "I'm")
    .replace(/\bI will\b/g, "I'll")
    .replace(/\byou are\b/gi, "you're")
    .replace(/\bdo not\b/gi, "don't")
    .replace(/\bcan not\b/gi, "can't")
    .replace(/\s+/g, " ")
    .replace(/([.!?])\s+/g, "$1 ")
    .trim();
}

/* ── App ─────────────────────────────────────────────────────────────────── */
function App() {
  const [events,       setEvents]       = React.useState(()=>loadJson(STORAGE_KEY,[]));
  const [messages,     setMessages]     = React.useState(()=>loadJson(CONVERSATION_KEY,[{role:"blue",text:"Ayush, what's your mood today? I can talk music, recommend the next track, and play it through Spotify or YouTube."}]));
  const [mood,         setMood]         = React.useState("Electric");
  const [bridge,       setBridge]       = React.useState({ok:false,llm:"ollama",llmOnline:false,spotify:false,mediaKeys:false,youtube:true,apple:false,streaming:false});
  const [currentTrack, setCurrentTrack] = React.useState(null);
  const [input,        setInput]        = React.useState("");
  const [listening,    setListening]    = React.useState(false);
  const [busy,         setBusy]         = React.useState(false);
  const [voices,       setVoices]       = React.useState(()=>("speechSynthesis" in window ? window.speechSynthesis.getVoices() : []));
  // Continuous voice + streaming TTS state
  const [liveTranscript, setLiveTranscript] = React.useState("");
  const [activeProvider, setActiveProvider] = React.useState(()=>{
    try { return localStorage.getItem(PROVIDER_KEY) || "auto"; } catch { return "auto"; }
  });
  React.useEffect(()=>{ try { localStorage.setItem(PROVIDER_KEY, activeProvider); } catch {} },[activeProvider]);
  const [youtubeVideo,   setYoutubeVideo]   = React.useState(null);   // { videoId, title, ... }
  // Mirror youtubeVideo into a ref so the long-lived pollCurrent interval (set
  // up once in a []-dep effect) can see the latest value without capturing a
  // stale closure. Without this, the 4s Spotify "currently-playing" poll
  // overwrites the YouTube track on the dashboard.
  const youtubeVideoRef = React.useRef(null);
  React.useEffect(()=>{ youtubeVideoRef.current = youtubeVideo; },[youtubeVideo]);
  const recRef          = React.useRef(null);
  const recDesireRef    = React.useRef(false);
  const speakingRef     = React.useRef(false);
  const speechQueueRef  = React.useRef([]);
  const voicesRef       = React.useRef(voices);
  React.useEffect(() => { voicesRef.current = voices; }, [voices]);
  // Live-playback state — server polls every few seconds; the player extrapolates
  // locally between syncs using requestAnimationFrame, so visible progress and
  // lyric highlighting stay smooth without thrashing React state.
  const [playback,     setPlayback]     = React.useState({progressMs:0,durationMs:0,isPlaying:false,lastSyncAt:0});
  const [lyrics,       setLyrics]       = React.useState({loading:false,synced:false,lines:[],plain:""});
  const lyricsCacheRef = React.useRef(new Map());
  const recommendation = React.useMemo(()=>pickRecommendation(mood,events),[mood,events]);
  // Up-next picks from the currently-playing track's genre/mood signal so the
  // Live Dashboard card always reflects "what would naturally follow this".
  const nextUp = React.useMemo(()=>pickNextRecommendation(currentTrack,events,mood),[currentTrack,events,mood]);

  React.useEffect(()=>saveJson(STORAGE_KEY,events),[events]);
  // Persist messages but strip transient fields (_streaming, _id) so a refresh
  // doesn't show a "streaming" bubble that will never finish.
  React.useEffect(()=>{
    const persistable = messages.slice(-20).map(({ _streaming, _id, ...rest }) => rest);
    saveJson(CONVERSATION_KEY, persistable);
  },[messages]);
  React.useEffect(()=>installTiltEffect(),[]);

  // Force open at top — kill browser scroll restoration + any hash jump.
  // We deliberately keep scroll-behavior:auto during the initial settle so
  // the layout snaps to (0,0) instantly, then promote to smooth-scroll for
  // anchor link clicks once the page has stabilised.
  React.useEffect(()=>{
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    if (window.location.hash) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    window.scrollTo(0, 0);
    const guards = [50, 200, 500].map((ms) => setTimeout(()=>window.scrollTo(0,0), ms));
    const enableSmooth = setTimeout(() => document.documentElement.classList.add("smooth-scroll"), 800);
    return ()=>{
      guards.forEach(clearTimeout);
      clearTimeout(enableSmooth);
    };
  },[]);

  // Boot GSAP reveal after first render
  React.useEffect(()=>{
    const t = setTimeout(()=>window.setupReveal?.(), 60);
    return ()=>clearTimeout(t);
  },[]);

  React.useEffect(()=>{
    if (!("speechSynthesis" in window)) return undefined;
    const load = ()=>setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.onvoiceschanged = load;
    return ()=>{ window.speechSynthesis.onvoiceschanged = null; };
  },[]);

  React.useEffect(()=>{
    const pollBridge = async()=>{
      try { setBridge(await fetch("/api/health").then(r=>r.json())); }
      catch { setBridge({ok:false,llm:"ollama",llmOnline:false,spotify:false,mediaKeys:false}); }
    };
    const pollRecent = async()=>{
      try {
        const recent = await fetch("/api/spotify/recent").then(r=>r.ok?r.json():null);
        if (recent?.events?.length) setEvents(old=>mergeEvents(old,recent.events.map(e=>normalizeTrack(e,"Spotify"))));
      } catch {}
    };
    // Tighter cadence on /current so progressMs stays in sync with playback.
    // Local rAF interpolation fills the gaps between polls, so visible lag
    // is bounded by ~one frame, not the poll interval.
    const pollCurrent = async()=>{
      try {
        const current = await fetch("/api/spotify/current").then(r=>r.ok?r.json():null);
        if (!current) return;
        // If YouTube is the active source in Blue, ignore Spotify's
        // "currently-playing" — the Spotify app reports whatever track was
        // last loaded even when paused, which would otherwise clobber the
        // YouTube track on the dashboard every 4 seconds.
        if (youtubeVideoRef.current?.videoId) return;
        if (current.track) {
          const n = normalizeTrack({...current.track, durationMs: current.durationMs}, "Spotify");
          // Carry through fields the normalizer doesn't whitelist.
          n.albumArt      = current.track.albumArt      || "";
          n.albumArtSmall = current.track.albumArtSmall || n.albumArt;
          n.durationMs    = current.durationMs || current.track.durationMs || 0;
          setCurrentTrack(n);
          setPlayback({
            progressMs: current.progressMs || 0,
            durationMs: current.durationMs || 0,
            isPlaying:  !!current.isPlaying,
            lastSyncAt: performance.now(),
          });
          if (current.isPlaying) setEvents(old=>mergeEvents(old,[n]));
        } else {
          setPlayback((p)=>({...p, isPlaying:false}));
        }
      } catch {}
    };
    pollBridge(); pollRecent(); pollCurrent();
    // Network polls are gated on document.visibilityState — if the tab is in
    // the background, we skip the poll. This drops idle network/CPU to ~0
    // while the user is in another tab and resumes instantly on focus.
    const guarded = (fn) => () => { if (document.visibilityState === "visible") fn(); };
    const bi = setInterval(guarded(pollBridge), 30000);
    const ri = setInterval(guarded(pollRecent), 30000);
    const ci = setInterval(guarded(pollCurrent), 4000);
    const onVis = () => { if (document.visibilityState === "visible") { pollBridge(); pollCurrent(); } };
    document.addEventListener("visibilitychange", onVis);
    return ()=>{
      clearInterval(bi); clearInterval(ri); clearInterval(ci);
      document.removeEventListener("visibilitychange", onVis);
    };
  },[]);

  // Lyrics fetcher — keyed on title+artist so it only fires when the track
  // actually changes, not on every poll tick. Per-track cache prevents
  // re-fetching on replays and song-skip-back scenarios.
  const trackKey = currentTrack ? `${currentTrack.title}|${currentTrack.artist}`.toLowerCase() : "";
  React.useEffect(()=>{
    if (!currentTrack?.title || !currentTrack?.artist) {
      setLyrics({loading:false,synced:false,lines:[],plain:""});
      return undefined;
    }
    const cache = lyricsCacheRef.current;
    if (cache.has(trackKey)) {
      setLyrics(cache.get(trackKey));
      return undefined;
    }
    let cancelled = false;
    setLyrics({loading:true,synced:false,lines:[],plain:""});
    const params = new URLSearchParams({
      title: currentTrack.title,
      artist: currentTrack.artist,
    });
    if (currentTrack.album)      params.set("album",    currentTrack.album);
    if (currentTrack.durationMs) params.set("duration", String(currentTrack.durationMs));
    fetch(`/api/lyrics?${params}`)
      .then((r)=>r.json())
      .then((data)=>{
        if (cancelled) return;
        const result = {
          loading: false,
          synced:  !!data.synced,
          lines:   Array.isArray(data.lines) ? data.lines : [],
          plain:   data.plain || "",
        };
        cache.set(trackKey, result);
        setLyrics(result);
      })
      .catch(()=>{
        if (cancelled) return;
        setLyrics({loading:false,synced:false,lines:[],plain:""});
      });
    return ()=>{ cancelled = true; };
  },[trackKey]);

  const stats = React.useMemo(()=>{
    const plays = events.length;
    // Re-bucket every event's genre for the chart so legacy localStorage entries
    // and any "Unknown" leakage get folded into canonical buckets at display time.
    const bucketed = events.map((e)=>({...e,genre:normalizeGenreClient(e.genre||"Unknown")}));
    return {
      plays,
      topGenre:  topOf(bucketed,"genre"),
      topSong:   topOf(events,"title"),
      topArtist: topOf(events,"artist"),
      topBand:   topOf(events,"band"),
      moodData:  countBy(events,"mood"),
      genreData: countBy(bucketed,"genre"),
      artistData:countBy(events,"artist"),
    };
  },[events]);

  // Tracks we've already sent to /api/music/identify — prevents duplicate
  // requests (YouTube tracks land here with genre:"Unknown" and we want to
  // backfill once, not every time the same track replays).
  const enrichedRef = React.useRef(new Set());
  const enrichGenre = React.useCallback(async (track) => {
    if (!track?.title || track.genre !== "Unknown") return;
    const key = `${track.title}|${track.artist || ""}`.toLowerCase();
    if (enrichedRef.current.has(key)) return;
    enrichedRef.current.add(key);
    try {
      const params = new URLSearchParams({ title: track.title, artist: track.artist || "" });
      const r = await fetch(`/api/music/identify?${params}`).then((res)=>res.ok?res.json():null);
      const primary = r?.primary;
      if (!primary || primary === "Unknown") return;
      // The original mood was inferred without a genre signal so it almost
      // always landed in "Chill". Revise mood only when it was that default —
      // preserves any explicitly-set mood.
      const newMood = window.BLUE_GENRE_MOOD?.[primary];
      setEvents((old) => old.map((e) => {
        if ((e.title || "").toLowerCase() !== track.title.toLowerCase()) return e;
        if ((e.artist || "").toLowerCase() !== (track.artist || "").toLowerCase()) return e;
        const next = { ...e, genre: primary };
        if (newMood && e.mood === "Chill") next.mood = newMood;
        return next;
      }));
      setCurrentTrack((cur) => {
        if (!cur || cur.title !== track.title || cur.artist !== track.artist) return cur;
        const next = { ...cur, genre: primary };
        if (newMood && cur.mood === "Chill") next.mood = newMood;
        return next;
      });
    } catch {}
  }, []);

  const recordPlay = (track,source="Blue")=>{
    const n = normalizeTrack(track,source);
    setCurrentTrack(n);
    setEvents(old=>mergeEvents(old,[n]));
    enrichGenre(n);
  };

  const previewAudioRef = React.useRef(null);

  /* ── Speech queue (per-sentence TTS with interruption support) ─────────
     Streaming chat sends tokens as they arrive. Rather than waiting for the
     full reply, we group tokens into sentences and queue each completed
     sentence into SpeechSynthesis. Three properties matter:
       • Interruption: when the user starts speaking, we drop the queue and
         cancel the in-flight utterance.
       • Echo protection: while TTS is speaking, we abort the mic so the
         microphone doesn't pick up our own output. We resume after.
       • Coherence: we never let two utterances overlap.
     ────────────────────────────────────────────────────────────────────── */
  const flushSpeechQueue = React.useCallback(() => {
    if (!("speechSynthesis" in window)) return;
    if (speakingRef.current) return;
    const next = speechQueueRef.current.shift();
    if (!next) {
      // Drained — if continuous mic was paused for TTS, restart it now.
      if (recDesireRef.current && !recRef.current) {
        setTimeout(() => spawnRecognitionRef.current?.(), 90);
      }
      return;
    }
    const u = new SpeechSynthesisUtterance(makeSpeechText(next));
    const v = chooseBlueVoice(voicesRef.current);
    if (v) u.voice = v;
    u.lang   = v?.lang || "en-US";
    u.rate   = 0.98;
    u.pitch  = 0.96;
    u.volume = 0.94;
    u.onstart = () => {
      speakingRef.current = true;
      // Pause continuous mic to avoid feedback. The recognition's onend
      // won't auto-restart while speakingRef is true.
      if (recRef.current) {
        try { recRef.current.abort(); } catch {}
        recRef.current = null;
      }
    };
    u.onend = u.onerror = () => {
      speakingRef.current = false;
      flushSpeechQueue();
    };
    try { window.speechSynthesis.speak(u); }
    catch { speakingRef.current = false; }
  }, []);

  const interruptSpeech = React.useCallback(() => {
    if (!("speechSynthesis" in window)) return;
    speechQueueRef.current = [];
    try { window.speechSynthesis.cancel(); } catch {}
    speakingRef.current = false;
  }, []);

  const enqueueSpeech = React.useCallback((text) => {
    if (!text || !String(text).trim()) return;
    if (!("speechSynthesis" in window)) return;
    speechQueueRef.current.push(String(text));
    flushSpeechQueue();
  }, [flushSpeechQueue]);

  const speak = React.useCallback((text) => {
    interruptSpeech();
    enqueueSpeech(text);
  }, [enqueueSpeech, interruptSpeech]);

  const spawnRecognitionRef = React.useRef(null);

  const playPreview = (url, track) => {
    if (!url) return false;
    let el = previewAudioRef.current;
    if (!el) {
      el = document.createElement("audio");
      el.crossOrigin = "anonymous";
      el.preload = "auto";
      el.style.display = "none";
      document.body.appendChild(el);
      previewAudioRef.current = el;
    }
    el.src = url;
    el.volume = 0.85;
    el.play().catch(()=>{});
    return true;
  };

  /* ── Multi-provider playback ───────────────────────────────────────────
     Routes through /api/music/play, which itself walks Spotify → YouTube →
     preview based on what's connected and what fails. The frontend's job is
     to render the right player engine for whichever provider responded.
     ────────────────────────────────────────────────────────────────────── */
  const playTrack = async (track, provider = "auto") => {
    const query = (track && (track.query || `${track.title || ""} ${track.artist || ""}`.trim())) || recommendation.query;
    if (!query && !track?.uri) return { ok: false };
    try {
      const r = await fetch("/api/music/play", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          uri:    track?.uri    || undefined,
          title:  track?.title  || undefined,
          artist: track?.artist || undefined,
          provider,
        }),
      }).then((r) => r.json());

      // Spotify path
      if (r.ok && r.provider === "spotify" && r.track) {
        recordPlay(r.track, "Spotify");
        // Clear any YouTube takeover so the Spotify-driven live player shows up
        setYoutubeVideo(null);
        return { ok: true, mode: "spotify", device: r.device };
      }

      // YouTube path — frontend mounts the IFrame player
      if (r.ok && r.provider === "youtube" && r.youtube?.videoId) {
        setYoutubeVideo(r.youtube);
        const t = r.track || {
          title:  r.youtube.title  || track?.title  || query,
          artist: r.youtube.channel || track?.artist || "",
          query,
          albumArt: r.youtube.thumbnail || "",
          source: "YouTube",
        };
        recordPlay(t, "YouTube");
        return { ok: true, mode: "youtube", videoId: r.youtube.videoId };
      }

      // Preview fallback
      const previewUrl = r.previewUrl
        || r.attempts?.find?.((a) => a?.previewUrl)?.previewUrl;
      if (previewUrl) {
        const t = r.track
          || r.attempts?.find?.((a) => a?.track)?.track
          || track;
        if (t) recordPlay({ ...t, source: "Preview" }, "Preview");
        playPreview(previewUrl, t);
        const note = "No active Spotify device — running a 30-second preview here. Open Spotify on any device for the full track.";
        setMessages((old) => [...old, { role: "blue", text: note }]);
        enqueueSpeech(note);
        return { ok: true, mode: "preview" };
      }

      // Apple Music wants client-side authorization
      if (r.attempts?.some?.((a) => a?.apple?.needsClientAuth)) {
        const note = "Apple Music is wired up but I need you to sign in once from the player to start playback.";
        setMessages((old) => [...old, { role: "blue", text: note }]);
        enqueueSpeech(note);
        return { ok: false, mode: "apple-needs-auth" };
      }

      const note = r.error
        || r.attempts?.find?.((a) => a?.error)?.error
        || "I couldn't start playback. Open Spotify on a device or switch to YouTube and I'll route through.";
      setMessages((old) => [...old, { role: "blue", text: note }]);
      enqueueSpeech(note);
      return { ok: false };
    } catch {
      const note = "Lost the bridge to playback. Refresh, or reconnect Spotify from the top bar.";
      setMessages((old) => [...old, { role: "blue", text: note }]);
      enqueueSpeech(note);
      return { ok: false };
    }
  };

  /* ── Streaming chat over SSE ────────────────────────────────────────────
     The new path: POST /api/chat/stream → reads SSE events, appends tokens
     to a streaming bubble, and pipes complete sentences into the speech
     queue. The reply you see and the reply you hear are the same buffer,
     drip-fed at speech speed — no waiting for the whole response.
     Falls back to non-streaming /api/chat if the stream errors.
     ────────────────────────────────────────────────────────────────────── */
  const streamChat = async (text, history, context) => {
    const placeholderId = `blue-stream-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    setMessages((old)=>[...old, { role: "blue", text: "", _id: placeholderId, _streaming: true }]);

    const updatePlaceholder = (textValue, streaming = true) => {
      setMessages((old) => {
        // Walk from end to find the streaming placeholder.
        for (let i = old.length - 1; i >= 0; i--) {
          if (old[i]._id === placeholderId) {
            const next = old.slice();
            next[i] = { ...next[i], text: textValue, _streaming: streaming };
            return next;
          }
        }
        return old;
      });
    };

    let assembled = "";
    let lastSpoken = 0;
    let finalPayload = null;
    const sentenceRe = /[^.!?…\n]+[.!?…]+|\n/g;

    const speakBoundaries = () => {
      const tail = assembled.slice(lastSpoken);
      sentenceRe.lastIndex = 0;
      let consumed = 0;
      let m;
      while ((m = sentenceRe.exec(tail)) !== null) {
        const sentence = m[0].trim();
        if (sentence) enqueueSpeech(sentence);
        consumed = m.index + m[0].length;
      }
      lastSpoken += consumed;
    };

    const r = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, history, context }),
    });
    if (!r.ok || !r.body) throw new Error(`Stream failed: ${r.status}`);

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        if (!block.trim()) continue;
        let event = "message", data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trimStart();
        }
        let parsed; try { parsed = JSON.parse(data); } catch { continue; }
        if (event === "token" && parsed?.text) {
          assembled += parsed.text;
          updatePlaceholder(assembled);
          speakBoundaries();
        } else if (event === "done") {
          finalPayload = parsed;
        }
      }
    }

    // Speak any remaining tail without terminal punctuation
    if (lastSpoken < assembled.length) {
      const tail = assembled.slice(lastSpoken).trim();
      if (tail) enqueueSpeech(tail);
    }

    // Mark the bubble as no longer streaming + ensure final reply is set
    const finalText = (finalPayload?.reply && finalPayload.reply.length > assembled.length)
      ? finalPayload.reply : assembled;
    updatePlaceholder(finalText, false);
    return finalPayload || { reply: finalText };
  };

  const sendToBlue = async (rawText = input) => {
    const text = String(rawText || "").trim();
    if (!text || busy) return;
    setBusy(true); setInput("");

    // User message in immediately, interrupt any in-flight TTS
    interruptSpeech();
    const userMsg = { role: "user", text };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);

    const context = {
      mood, recommendation, currentTrack,
      topGenre: stats.topGenre, topArtist: stats.topArtist,
      provider: activeProvider,
      recent: events.slice(0, 12),
    };

    try {
      const final = await streamChat(text, nextMessages.slice(-8), context);
      if (final) {
        if (final.mood) setMood(final.mood);
        // If the agent already played the track via its play_track tool,
        // do NOT make a second /api/music/play call from the frontend —
        // that's a different code path with its own provider fallback that
        // would override the agent's choice (e.g. play on Spotify instead
        // of the YouTube the user asked for).
        const agentPlayEvent = Array.isArray(final.toolEvents)
          ? final.toolEvents.find((e) => e.tool === "play_track" && e.ok)
          : null;
        if (agentPlayEvent) {
          const result = agentPlayEvent.result || {};
          if (result.provider === "youtube" && result.youtube?.videoId) {
            setYoutubeVideo(result.youtube);
            const ytTrack = result.track || {
              title:    result.youtube.title    || final.playQuery || "",
              artist:   result.youtube.channel  || "",
              query:    final.playQuery         || "",
              albumArt: result.youtube.thumbnail || "",
              source:   "YouTube",
            };
            recordPlay(ytTrack, "YouTube");
          } else if (result.provider === "spotify" && result.track) {
            setYoutubeVideo(null);
            recordPlay(result.track, "Spotify");
          }
        }
        if (!agentPlayEvent
            && (final.action === "play" || /\b(play|start|queue|put on|spin|throw on|hit)\b/i.test(text))) {
          const sayingThis = /\b(this|that|it)\b/i.test(text);
          const target =
            (final.track && (final.track.title || final.track.query) ? final.track : null) ||
            (sayingThis && currentTrack ? currentTrack : null) ||
            { ...recommendation, title: final.playQuery || recommendation.title, query: final.playQuery || recommendation.query };
          await playTrack(target, final.provider || activeProvider);
        }
      }
    } catch (streamError) {
      // Stream broke — fall back to non-streaming /api/chat once
      try {
        const r = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, history: nextMessages.slice(-8), context }),
        }).then((r) => r.json());
        const nextMood = r.mood || inferMood(text);
        setMood(nextMood);
        const reply = r.reply || `For ${nextMood.toLowerCase()}, I'd put on ${recommendation.title}. Want it?`;
        setMessages((old) => [...old, { role: "blue", text: reply }]);
        speak(reply);
        const agentAlreadyPlayed = Array.isArray(r.toolEvents)
          && r.toolEvents.some((e) => e.tool === "play_track" && e.ok);
        if (!agentAlreadyPlayed
            && (r.action === "play" || /\b(play|start|queue|put on|spin|throw on|hit)\b/i.test(text))) {
          const sayingThis = /\b(this|that|it)\b/i.test(text);
          const target =
            (r.track && (r.track.title || r.track.query) ? r.track : null) ||
            (sayingThis && currentTrack ? currentTrack : null) ||
            { ...recommendation, title: r.playQuery || recommendation.title, query: r.playQuery || recommendation.query };
          await playTrack(target, r.provider || activeProvider);
        }
      } catch {
        const reply = `Running in local mode. For ${mood.toLowerCase()}, I'd play ${recommendation.title} by ${recommendation.artist}. Want it?`;
        setMessages((old) => [...old, { role: "blue", text: reply }]);
        speak(reply);
      }
    } finally {
      setBusy(false);
    }
  };

  /* ── Continuous voice ─────────────────────────────────────────────────
     Pressing the mic toggles on/off. While on, the recognizer auto-restarts
     across natural speech segments (Chrome ends a session after ~60s of
     silence). Interim transcripts feed a live caption so the user can see
     what Blue is hearing. A short silence detector commits the buffer to
     sendToBlue once the user stops talking.
     ────────────────────────────────────────────────────────────────────── */
  const stopVoice = React.useCallback(() => {
    recDesireRef.current = false;
    setListening(false);
    setLiveTranscript("");
    if (recRef.current) {
      try { recRef.current.abort(); } catch {}
      recRef.current = null;
    }
  }, []);

  const spawnRecognition = React.useCallback(() => {
    if (!recDesireRef.current) return;
    if (recRef.current) return;
    if (speakingRef.current) return; // wait for TTS to finish; flushSpeechQueue will retrigger
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    recRef.current = rec;
    setListening(true);

    let silenceTimer = null;
    let buffer = "";

    rec.onresult = (e) => {
      if (speakingRef.current) return;
      let interim = "", final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      const visible = (interim || final).trim();
      setLiveTranscript(visible);
      if (final && final.trim()) {
        // The user is talking — interrupt any in-flight TTS so they aren't
        // talked over.
        if (speechQueueRef.current.length || speakingRef.current) interruptSpeech();
        buffer += " " + final;
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
          const text = buffer.trim();
          buffer = "";
          setLiveTranscript("");
          if (text) sendToBlue(text);
        }, 850);
      }
    };
    rec.onend = () => {
      recRef.current = null;
      // Auto-restart only if user still wants the mic on AND TTS isn't
      // playing (TTS resume handles the post-speech restart).
      if (recDesireRef.current && !speakingRef.current) {
        setTimeout(() => spawnRecognitionRef.current?.(), 80);
      } else if (!recDesireRef.current) {
        setListening(false);
      }
    };
    rec.onerror = (e) => {
      // Permissions errors are terminal; transient errors just let onend
      // handle restart.
      if (e?.error === "not-allowed" || e?.error === "service-not-allowed") {
        recDesireRef.current = false;
        setListening(false);
      }
    };
    try { rec.start(); }
    catch { recRef.current = null; }
  }, [interruptSpeech]);

  React.useEffect(() => { spawnRecognitionRef.current = spawnRecognition; }, [spawnRecognition]);

  const startVoice = React.useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      const reply = "This browser does not expose speech recognition, but you can type to me.";
      setMessages((old) => [...old, { role: "blue", text: reply }]);
      enqueueSpeech(reply);
      return;
    }
    if (recDesireRef.current || listening) {
      stopVoice();
      return;
    }
    recDesireRef.current = true;
    spawnRecognition();
  }, [enqueueSpeech, listening, spawnRecognition, stopVoice]);

  const mediaKey = async(action)=>fetch("/api/system/media",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action})}).catch(()=>{});

  const focusBlue  = ()=>document.getElementById("blue-agent")?.scrollIntoView({behavior:"smooth",block:"center"});
  const voiceFromHero   = ()=>{ focusBlue(); setTimeout(startVoice,350); };
  const askFromHero     = ()=>{ focusBlue(); sendToBlue(`Do you wanna hear ${recommendation.title} next?`); };

  return (
    <>
      {/* Black overlay — GSAP fades this out on load */}
      <div id="page-load-overlay" style={{position:"fixed",inset:0,zIndex:9999,background:"#000",pointerEvents:"none"}} />

      {/* ── Music Cosmos: live, fixed, music-themed background system ──────
          Layered in source order so each subsequent layer paints over the
          last while staying behind <main> (z-index:1+). All layers are
          aria-hidden and pointer-events:none so they never interfere with
          clicks, focus, scroll, or screen readers. */}
      <AuroraGradient />
      <MusicCosmos variant="site" />
      <MusicNotesLayer count={14} variant="site" />


      <main className="relative z-[1] text-white">
        <Navbar bridge={bridge} />
        <Hero
          stats={stats} recommendation={recommendation} bridge={bridge}
          onVoice={voiceFromHero} onRecommend={askFromHero} onPlay={()=>playTrack(recommendation)}
        />
        <Capabilities
          stats={stats} events={events} messages={messages}
          input={input} setInput={setInput} mood={mood} setMood={setMood}
          recommendation={recommendation} nextUp={nextUp} currentTrack={currentTrack} bridge={bridge}
          busy={busy} listening={listening} liveTranscript={liveTranscript}
          activeProvider={activeProvider} setActiveProvider={setActiveProvider}
          youtubeVideo={youtubeVideo} setYoutubeVideo={setYoutubeVideo}
          playback={playback} lyrics={lyrics}
          onSubmit={()=>sendToBlue()} onVoice={startVoice}
          onPlay={()=>playTrack(recommendation, activeProvider)} onMedia={mediaKey}
          onPlayNext={(t)=>playTrack(t || nextUp, activeProvider)}
        />
      </main>
    </>
  );
}

/* ── Navbar ──────────────────────────────────────────────────────────────── */
function Navbar({ bridge }) {
  const links = [["Home","#hero"],["Voice","#blue-agent"],["Automation","#automation"],["Dashboard","#dashboard"]];
  return (
    <nav data-hero="0" className="fixed left-0 right-0 top-4 z-50 flex items-center justify-between px-5 md:px-8 lg:px-16">
      <a href="#hero" className="logo-link" aria-label="Blue home"><BlueLogo /></a>
      <div className="liquid-glass nav-pill hidden items-center rounded-full px-1.5 py-1.5 lg:flex">
        {links.map(([item,href])=>(
          <a key={item} href={href} className="alive-button rounded-full px-3 py-2 font-body text-sm font-medium text-white/90" data-tilt="button">{item}</a>
        ))}
        <a href="/api/spotify/login" className="alive-button primary-live flex items-center gap-1.5 whitespace-nowrap rounded-full bg-white px-4 py-2 font-body text-sm font-semibold text-black" data-tilt="button">
          {bridge.spotify?"Spotify Live":"Connect Spotify"} <ArrowUpRight className="h-4 w-4" />
        </a>
      </div>
      <a href="/api/spotify/login" className="alive-button liquid-glass flex h-12 items-center px-4 font-body text-xs font-semibold text-white lg:invisible" data-tilt="button">Connect</a>
    </nav>
  );
}

/* ── Hero ────────────────────────────────────────────────────────────────── */
function Hero({ stats, recommendation, bridge, onVoice, onRecommend, onPlay }) {
  return (
    <section id="hero" className="relative flex min-h-screen overflow-hidden">
      <HeroAccent />
      <div className="relative z-10 flex min-h-screen w-full flex-col">
        <div className="flex flex-1 flex-col items-center justify-center px-4 pt-24 text-center">

          {/* Badge — data-hero="1" */}
          <div data-hero="1" className="liquid-glass tilt-card inline-flex items-center gap-2 rounded-full py-1 pl-1 pr-3" data-tilt="button">
            <span className="rounded-full px-3 py-1 font-body text-xs font-semibold text-black" style={{background:"#FFE44D"}}>New</span>
            <span className="font-body text-sm text-white/90">Blue runs locally with Ollama, collects listening data, and controls your music bridge</span>
          </div>

          {/* Heading — BlurText handles its own word-by-word animation */}
          <BlurText
            text="Blue Automates Your Music Universe"
            highlights={["Automates","Music"]}
            delay={0.72}
            className="mt-6 max-w-4xl justify-center font-heading text-6xl font-extrabold leading-[0.85] tracking-[-2px] text-white md:text-7xl lg:text-[5.5rem]"
          />

          {/* CTA buttons — data-hero="2" */}
          <div data-hero="2" className="mt-6 flex flex-wrap items-center justify-center gap-6">
            <button onClick={onVoice} className="alive-button liquid-glass-strong flex items-center gap-2 rounded-full px-5 py-2.5 font-body text-sm font-medium text-white" data-tilt="button">
              Talk to Blue <ArrowUpRight />
            </button>
            <button onClick={onPlay} className="alive-button flex items-center gap-2 rounded-full px-4 py-2 font-body text-sm font-medium text-white" data-tilt="button">
              Play {recommendation.title} <PlayIcon />
            </button>
            <button onClick={onRecommend} className="alive-button rounded-full px-4 py-2 font-body text-sm font-light text-white/90" data-tilt="button">
              Ask what fits my mood
            </button>
          </div>

          {/* Stats — data-hero="3" */}
          <div data-hero="3" className="mt-8 flex flex-wrap items-stretch justify-center gap-4">
            <StatCard icon={<ClockIcon />} value={stats.plays?`${stats.plays}`:"0"} label="Real plays collected by Blue" />
            <StatCard icon={<GlobeIcon />} value={bridge.llm==="ollama"?"Ollama":"Local"} label={bridge.spotify?"Spotify automation online":"Local agent active"} />
          </div>

        </div>
      </div>
    </section>
  );
}

function StatCard({ icon, value, label }) {
  return (
    <div className="liquid-glass tilt-card stat-card w-[220px] rounded-[1.25rem] p-5 text-left" data-tilt="card">
      <div className="flex h-7 w-7 items-center justify-center">{icon}</div>
      <div className="mt-9 font-heading text-4xl font-bold leading-none tracking-[-1px] text-white">{value}</div>
      <div className="mt-2 font-body text-xs font-light text-white">{label}</div>
    </div>
  );
}

/* ── Capabilities ────────────────────────────────────────────────────────── */
function Capabilities(props) {
  const { currentTrack, nextUp, onPlayNext } = props;
  const cards = [
    { title:"AI Voice Chat",     icon:iconPaths.scenery, tags:["Mood Aware","Music Talk","LLM Ready","Voice First"],  body:"Blue listens to what you say, reasons about your taste, asks before it plays, and speaks back using the browser or an LLM bridge." },
    { title:"Playback Control",  icon:iconPaths.movie,   tags:["Spotify OAuth","Media Keys","Queue Next","Search Play"], body:"Once Spotify is connected, Blue can search tracks, start playback, and keep a local fallback for system media keys." },
  ];

  return (
    <section id="capabilities" className="relative min-h-screen overflow-hidden">
      <DashboardAccent />
      <div className="relative z-10 flex min-h-screen flex-col px-8 pb-10 pt-24 md:px-16 lg:px-20">
        <header className="mb-auto">
          <p data-reveal className="mb-6 font-body text-sm font-semibold" style={{color:"#FFE44D"}}>// Capabilities</p>
          <h2 data-reveal className="font-heading text-6xl font-extrabold leading-[0.9] tracking-[-2px] text-white md:text-7xl lg:text-[6rem]">
            Music <span style={{color:"#FFE44D"}}>automation</span><br />evolved
          </h2>
        </header>

        <div id="automation" className="mt-16 grid grid-cols-1 gap-6 md:grid-cols-3">
          {cards.map((card,i)=><CapabilityCard card={card} key={card.title} index={i} />)}
          <LiveDashboardCard
            index={2}
            currentTrack={currentTrack}
            nextUp={nextUp}
            onPlay={onPlayNext}
          />
        </div>

        <DashboardPanel {...props} />
      </div>
    </section>
  );
}

/* ── Live Dashboard capability card ────────────────────────────────────────
   Replaces the static "Live Dashboard" card with a live, context-aware
   "Up next" recommendation seeded off the currently-playing track. Bubble
   field rises behind the text — pure CSS, no canvas, so it stays cheap.
   The next-up block re-mounts on track change via a React key so the
   nextFadeIn keyframe replays cleanly.
   ─────────────────────────────────────────────────────────────────────── */
function LiveDashboardCard({ index, currentTrack, nextUp, onPlay }) {
  const cur = currentTrack;
  const nx  = nextUp;
  // Eleven bubbles, deterministic per-index so the layout is stable across renders
  const bubbles = React.useMemo(() => Array.from({ length: 11 }, (_, i) => ({
    size:  6 + ((i * 7) % 20),         // 6–26 px
    left:  ((i * 17) + 5) % 96,        // 5%–96%
    delay: ((i * 0.73) % 7).toFixed(2),
    dur:   (10 + ((i * 1.7) % 7)).toFixed(2),
  })), []);
  return (
    <article
      data-reveal
      className="liquid-glass capability-card live-dashboard-card relative flex min-h-[360px] flex-col overflow-hidden rounded-[1.25rem] p-6"
      style={{transitionDelay:`${index*60}ms`}}
    >
      <div className="live-dashboard-card__bubbles" aria-hidden="true">
        {bubbles.map((b, i) => (
          <span
            key={i}
            className="live-dashboard-card__bubble"
            style={{
              width:  `${b.size}px`,
              height: `${b.size}px`,
              left:   `${b.left}%`,
              animationDelay:    `${b.delay}s`,
              animationDuration: `${b.dur}s`,
            }}
          />
        ))}
      </div>

      {/* Now playing strip */}
      <div className="relative z-10 flex items-start justify-between gap-3">
        <span className="flex items-center gap-2">
          <span className="live-dashboard-card__pulse" />
          <span className="font-body text-[11px] uppercase tracking-[0.22em] text-white/60">
            {cur ? "Now playing" : "Standing by"}
          </span>
        </span>
        {cur?.mood && (
          <span className="liquid-glass rounded-full px-2.5 py-1 font-body text-[10px] uppercase tracking-wider text-white/85">
            {cur.mood}
          </span>
        )}
      </div>
      <div className="relative z-10 mt-2 min-w-0">
        <p className="truncate font-heading text-base font-semibold leading-tight text-white">
          {cur ? cur.title : "Nothing on yet"}
        </p>
        <p className="truncate font-body text-xs text-white/55">
          {cur ? `${cur.artist}${cur.genre ? ` · ${cur.genre}` : ""}` : "Press play and Blue will start learning."}
        </p>
      </div>

      <div className="live-dashboard-card__divider relative z-10 my-5" />

      {/* Up next */}
      <div className="relative z-10 mb-2 flex items-center gap-2">
        <span className="live-dashboard-card__arrow" aria-hidden="true">↗</span>
        <span className="font-body text-[11px] uppercase tracking-[0.22em] text-white/60">Up next</span>
      </div>
      <div key={`${nx?.title || ""}|${nx?.artist || ""}`} className="live-dashboard-card__next relative z-10 flex-1 min-w-0">
        <h3 className="truncate font-heading text-3xl font-bold leading-[1.05] tracking-[-1px] text-white md:text-[2rem]">
          {nx?.title || "Pick a mood"}
        </h3>
        <p className="mt-1 truncate font-body text-sm text-white/80">
          {nx ? `${nx.artist}${nx.genre ? ` · ${nx.genre}` : ""}` : ""}
        </p>
        {nx?.mood && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            <span className="liquid-glass rounded-full px-2.5 py-1 font-body text-[10px] uppercase tracking-wider text-white/85">{nx.mood}</span>
            {nx.genre && (
              <span className="liquid-glass rounded-full px-2.5 py-1 font-body text-[10px] uppercase tracking-wider text-white/85">{nx.genre}</span>
            )}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={()=>onPlay?.(nx)}
        disabled={!nx}
        className="live-dashboard-card__play relative z-10 mt-4 inline-flex items-center gap-2 self-start rounded-full px-4 py-2 font-body text-sm font-medium text-white"
      >
        <span aria-hidden="true">▶</span>
        Play next
      </button>
    </article>
  );
}

function CapabilityCard({ card, index }) {
  return (
    <article data-reveal className="liquid-glass capability-card flex min-h-[360px] flex-col rounded-[1.25rem] p-6" style={{transitionDelay:`${index*60}ms`}}>
      <div className="flex items-start justify-between gap-4">
        <div className="liquid-glass flex h-11 w-11 shrink-0 items-center justify-center rounded-[0.75rem]">
          <MaterialIcon path={card.icon} />
        </div>
        <div className="flex max-w-[70%] flex-wrap justify-end gap-1.5">
          {card.tags.map((tag)=>(
            <span key={tag} className="liquid-glass rounded-full px-3 py-1 font-body text-[11px] text-white/90">{tag}</span>
          ))}
        </div>
      </div>
      <div className="flex-1" />
      <div className="mt-6">
        <h3 className="font-heading text-3xl font-bold leading-none tracking-[-1px] text-white md:text-4xl">{card.title}</h3>
        <p className="mt-3 max-w-[32ch] font-body text-sm font-light leading-snug text-white/90">{card.body}</p>
      </div>
    </article>
  );
}

/* ── Dashboard panel ─────────────────────────────────────────────────────── */
function DashboardPanel({ stats, events, messages, input, setInput, mood, setMood, recommendation, currentTrack, bridge, busy, listening, liveTranscript, activeProvider, setActiveProvider, youtubeVideo, setYoutubeVideo, playback, lyrics, onSubmit, onVoice, onPlay, onMedia }) {
  return (
    <div id="dashboard" className="dashboard-stage mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[1fr_460px]">
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">

        <div className="lg:col-span-2">
          <LiveMusicPlayer
            track={currentTrack}
            lyrics={lyrics}
            playback={playback}
            isPlaying={playback?.isPlaying}
            bridge={bridge}
            activeProvider={activeProvider}
            setActiveProvider={setActiveProvider}
            youtubeVideo={youtubeVideo}
            setYoutubeVideo={setYoutubeVideo}
            onPlay={onPlay}
            onPause={()=>onMedia("playpause")}
            onNext={()=>onMedia("next")}
          />
        </div>

        <div data-reveal><DonutChart title="Mood listening split"  data={stats.moodData}  kind="mood"  activeName={mood} onSelect={setMood} /></div>
        <div data-reveal><DonutChart title="Genre listening split" data={stats.genreData} kind="genre" /></div>

        <div data-reveal className="liquid-glass dashboard-card rounded-[1.25rem] p-5">
          <p className="font-body text-sm text-white/70">Top signals</p>
          <div className="mt-4 grid gap-3 font-body text-white">
            <Signal label="Top song"   value={stats.topSong}   />
            <Signal label="Top artist" value={stats.topArtist} />
            <Signal label="Top band"   value={stats.topBand}   />
            <Signal label="Top genre"  value={stats.topGenre}  />
          </div>
        </div>

        <div data-reveal className="liquid-glass dashboard-card rounded-[1.25rem] p-5">
          <p className="font-body text-sm text-white/70">Recent collection</p>
          <div className="mt-4 grid gap-3">
            {(events.length?events.slice(0,4):[recommendation]).map((e)=>(
              <div key={`${e.title}-${e.playedAt||e.artist}`} className="flex items-center justify-between gap-4 font-body text-sm text-white">
                <span className="truncate">{e.title}</span>
                <span className="shrink-0 text-white/60">{e.mood||"Queued"}</span>
              </div>
            ))}
          </div>
        </div>

      </section>

      <AgentConsole
        messages={messages} input={input} setInput={setInput}
        mood={mood} setMood={setMood} recommendation={recommendation}
        currentTrack={currentTrack} bridge={bridge} busy={busy}
        listening={listening} liveTranscript={liveTranscript}
        activeProvider={activeProvider} setActiveProvider={setActiveProvider}
        onSubmit={onSubmit} onVoice={onVoice}
        onPlay={onPlay} onMedia={onMedia}
      />
    </div>
  );
}

function Signal({ label, value }) {
  return (
    <div className="signal-row flex items-center justify-between gap-4 rounded-full border border-white/10 px-4 py-2">
      <span className="text-white/60">{label}</span>
      <strong className="truncate text-right font-medium text-white">{value}</strong>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Agent Console — redesigned professional UI
══════════════════════════════════════════════════════════════════════════ */
function AgentConsole({ messages, input, setInput, mood, setMood, recommendation, currentTrack, bridge, busy, listening, liveTranscript, activeProvider, setActiveProvider, onSubmit, onVoice, onPlay, onMedia }) {
  const bottomRef = React.useRef(null);
  const messagesRef = React.useRef(null);
  const didMountRef = React.useRef(false);

  // Scroll only WITHIN the messages container — never the page.
  // Skip the very first run so initial render doesn't yank the page down to the agent.
  React.useEffect(()=>{
    if (!didMountRef.current) { didMountRef.current = true; return; }
    const c = messagesRef.current;
    if (c) c.scrollTop = c.scrollHeight;
  },[messages,busy,liveTranscript]);

  // Are any messages still streaming? If yes, suppress the typing indicator
  // (the streaming bubble itself shows progress).
  const anyStreaming = messages.some((m) => m && m._streaming);

  return (
    <section id="blue-agent" data-reveal className="agent-shell relative overflow-hidden rounded-[1.25rem]">
      <div className="relative z-10 flex flex-1 flex-col p-5" style={{minHeight:700}}>

        {/* ── Header ── */}
        <AgentHeader bridge={bridge} listening={listening} />

        {/* ── Now playing ── */}
        <NowPlayingWidget currentTrack={currentTrack} recommendation={recommendation} onPlay={onPlay} onMedia={onMedia} />

        {/* ── Provider switcher ── */}
        <ProviderSwitcher
          activeProvider={activeProvider}
          setActiveProvider={setActiveProvider}
          bridge={bridge}
        />

        {/* ── Mood selector ── */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {window.BLUE_MOODS.map((item)=>(
            <button
              key={item}
              onClick={()=>setMood(item)}
              className={`alive-button rounded-full px-3 py-1.5 font-body text-xs font-medium transition-all duration-200 ${
                mood===item ? "text-black" : "liquid-glass text-white/65 hover:text-white"
              }`}
              style={mood===item?{background:"#FFE44D"}:{}}
            >
              {item}
            </button>
          ))}
        </div>

        <div className="agent-divider mt-4" />

        {/* ── Messages — flex-1 so they expand to fill the panel and remove
            the blank black area below the chat. min-height keeps the list
            readable when the dashboard stack is shorter; no max so the
            list absorbs extra height on tall layouts. ── */}
        <div ref={messagesRef} className="agent-messages flex flex-1 flex-col gap-3 overflow-y-auto pr-1" style={{minHeight:200}}>
          {messages.slice(-12).map((msg,i)=>(
            <MessageBubble key={msg._id || `${msg.role}-${i}`} message={msg} />
          ))}
          {busy && !anyStreaming && <TypingIndicator />}
          <div ref={bottomRef} />
        </div>

        {/* ── Input bar ── */}
        <ChatInputBar
          input={input} setInput={setInput} busy={busy}
          listening={listening} liveTranscript={liveTranscript}
          onSubmit={onSubmit} onVoice={onVoice}
        />

      </div>
    </section>
  );
}

/* ── Provider switcher ──────────────────────────────────────────────────── */
function ProviderSwitcher({ activeProvider, setActiveProvider, bridge }) {
  const providers = [
    { id: "auto",    label: "Auto",    available: true,                                hint: "Best available" },
    { id: "spotify", label: "Spotify", available: !!bridge.spotify,                    hint: bridge.spotify ? "Connected" : "Connect Spotify up top" },
    { id: "youtube", label: "YouTube", available: bridge.youtube !== false,            hint: bridge.youtubeKeyed ? "API key set" : "Public search" },
    { id: "apple",   label: "Apple",   available: !!bridge.apple,                      hint: bridge.apple ? "Ready" : "Needs setup (see README)" },
  ];
  return (
    <div className="mt-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Music provider">
      {providers.map((p) => {
        const active = (activeProvider || "auto") === p.id;
        const cls = active
          ? "provider-chip provider-chip--active"
          : (p.available ? "provider-chip provider-chip--idle" : "provider-chip provider-chip--off");
        return (
          <button
            key={p.id}
            role="tab"
            aria-selected={active}
            disabled={!p.available && !active}
            title={p.hint}
            onClick={() => setActiveProvider?.(p.id)}
            className={`alive-button ${cls}`}
          >
            <span className="provider-chip__dot" />
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Sub-components ──────────────────────────────────────────────────────── */

function AgentHeader({ bridge, listening }) {
  return (
    <header className="flex items-center gap-3 pb-4" style={{borderBottom:"1px solid rgba(255,255,255,0.07)"}}>
      <BlueLogo compact />
      <div className="min-w-0">
        <h3 className="font-heading text-2xl font-bold leading-none text-white">Blue</h3>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <StatusPill active={bridge.llmOnline} label={bridge.llm==="ollama"?"Ollama":"Local AI"} />
          <StatusPill active={bridge.spotify}   label="Spotify" />
          <StatusPill active={bridge.mediaKeys} label="Media Keys" />
        </div>
      </div>
      <div className="relative ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{background:"rgba(255,255,255,0.05)"}}>
        {listening && (
          <>
            <span className="voice-ring" />
            <span className="voice-ring" />
          </>
        )}
        <div className={`audio-pulse flex h-6 items-center gap-[3px] ${listening?"text-[#FFE44D]":"text-white/40"}`}>
          <span /><span /><span /><span />
        </div>
      </div>
    </header>
  );
}

function StatusPill({ active, label }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-body text-[10px] font-medium ${active?"text-white/80":"text-white/30"}`}
      style={{background:active?"rgba(255,255,255,0.07)":"transparent"}}>
      <span className="h-1.5 w-1.5 rounded-full" style={{background:active?"#FFE44D":"rgba(255,255,255,0.2)"}} />
      {label}
    </span>
  );
}

function NowPlayingWidget({ currentTrack, recommendation, onPlay, onMedia }) {
  const track = currentTrack || recommendation;
  return (
    <div className="mt-4 flex items-center gap-3 rounded-[0.875rem] p-3" style={{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)"}}>
      {/* Animated waveform */}
      <div className="waveform-bars flex shrink-0 items-end gap-[3px]" style={{height:22}}>
        <span /><span /><span /><span /><span />
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-body text-[9px] font-bold uppercase tracking-[0.14em]" style={{color:"rgba(255,228,77,0.7)"}}>Now / Next</p>
        <h4 className="mt-0.5 truncate font-heading text-[1.05rem] font-bold leading-tight text-white">{track.title}</h4>
        <p className="truncate font-body text-[11px] text-white/45">{track.artist}</p>
      </div>
      <div className="flex shrink-0 gap-1.5">
        <button onClick={onPlay} className="alive-button liquid-glass flex h-8 w-8 items-center justify-center rounded-full text-white" data-tilt="button" title="Play recommendation">
          <PlayIcon className="h-3.5 w-3.5" />
        </button>
        <button onClick={()=>onMedia("playpause")} className="alive-button liquid-glass flex h-8 w-8 items-center justify-center rounded-full font-body text-sm text-white" data-tilt="button" title="Play/Pause">⏯</button>
        <button onClick={()=>onMedia("next")}      className="alive-button liquid-glass flex h-8 w-8 items-center justify-center rounded-full font-body text-sm text-white" data-tilt="button" title="Next">⏭</button>
      </div>
    </div>
  );
}

function MessageBubble({ message }) {
  const isUser = message.role === "user";
  const streaming = !!message._streaming;
  const empty = !message.text || !String(message.text).trim();
  return (
    <div className={`msg-enter flex gap-2.5 ${isUser?"justify-end":""}`}>
      {!isUser && (
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-heading text-[10px] font-bold text-white" style={{background:"rgba(255,228,77,0.15)",border:"1px solid rgba(255,228,77,0.2)"}}>B</div>
      )}
      <div className={`max-w-[82%] rounded-[1rem] px-4 py-2.5 font-body text-sm leading-relaxed ${
        isUser
          ? "rounded-tr-[4px] bg-white text-black"
          : "liquid-glass rounded-tl-[4px] text-white/90"
      }`}>
        {empty && streaming ? (
          <span className="streaming-dots"><span /><span /><span /></span>
        ) : (
          <>
            {message.text}
            {streaming && <span className="streaming-cursor" aria-hidden="true" />}
          </>
        )}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex gap-2.5">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-heading text-[10px] font-bold text-white" style={{background:"rgba(255,228,77,0.15)",border:"1px solid rgba(255,228,77,0.2)"}}>B</div>
      <div className="liquid-glass rounded-[1rem] rounded-tl-[4px] px-4 py-3">
        <div className="flex items-center gap-1.5">
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="ml-2 font-body text-[11px] text-white/35">thinking…</span>
        </div>
      </div>
    </div>
  );
}

function ChatInputBar({ input, setInput, busy, listening, liveTranscript, onSubmit, onVoice }) {
  return (
    <form className="mt-4" onSubmit={(e)=>{ e.preventDefault(); onSubmit(); }}>
      <div className="chat-input-wrap flex items-center gap-2 overflow-hidden rounded-[0.875rem] px-3 py-2 transition-all duration-200" style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.09)"}}>
        <input
          value={input}
          onChange={(e)=>setInput(e.target.value)}
          placeholder={listening ? "Listening… or type to interrupt" : "Tell Blue your mood or ask for a song…"}
          className="chat-input min-w-0 flex-1 bg-transparent py-1.5 font-body text-sm text-white placeholder:text-white/30"
        />
        {/* Mic — toggle. Hot state shows the wobble particle visualization. */}
        <button
          type="button"
          onClick={onVoice}
          title={listening ? "Stop continuous voice" : "Start continuous voice"}
          aria-label={listening ? "Stop continuous voice" : "Start continuous voice"}
          aria-pressed={listening}
          className={`mic-btn relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-all duration-200 ${listening?"mic-btn--listening":"alive-button liquid-glass text-white"}`}
        >
          {listening && <MicWobble active={listening} />}
          <span className={`relative z-10 flex items-center justify-center ${listening?"text-black":""}`}>
            <MicIcon />
          </span>
        </button>
        {/* Send */}
        <button
          disabled={busy}
          className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 font-body text-sm font-semibold transition-all duration-200 disabled:opacity-40 ${busy?"liquid-glass text-white/50":"text-black"}`}
          style={!busy?{background:"#FFE44D"}:{}}
        >
          {busy ? (
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 animate-ping rounded-full bg-white/60" />
              Wait
            </span>
          ) : "Send →"}
        </button>
      </div>

      {/* Live caption — shows interim transcript while voice is hot */}
      {listening && (
        <div className="live-caption mt-2 flex items-center gap-2 rounded-[0.75rem] px-3 py-2" role="status" aria-live="polite">
          <span className="live-caption__dots">
            <span /><span /><span />
          </span>
          <span className="live-caption__label">Listening</span>
          <span className="live-caption__text">
            {liveTranscript ? `“${liveTranscript}”` : "Speak naturally — mic stays on until you press it again."}
          </span>
        </div>
      )}
    </form>
  );
}

function MicIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0M12 19v3M9 22h6" />
    </svg>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
