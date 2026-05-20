window.BLUE_VIDEOS = {
  hero:
    "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260418_080021_d598092b-c4c2-4e53-8e46-94cf9064cd50.mp4",
  capabilities:
    "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260418_094631_d30ab262-45ee-4b7d-99f3-5d5848c8ef13.mp4",
};

window.BLUE_FALLBACK_CATALOG = [
  { title: "Sweet Child O' Mine",        artist: "Guns N' Roses",   band: "Guns N' Roses",   genre: "Rock",       mood: "Electric",    query: "Sweet Child O Mine Guns N Roses" },
  { title: "505",                        artist: "Arctic Monkeys",  band: "Arctic Monkeys",  genre: "Indie",      mood: "Late Night",  query: "505 Arctic Monkeys" },
  { title: "Blinding Lights",            artist: "The Weeknd",      band: "",                genre: "Pop",        mood: "Electric",    query: "Blinding Lights The Weeknd" },
  { title: "Nadaan Parindey",            artist: "A. R. Rahman",    band: "",                genre: "Bollywood",  mood: "Reflective",  query: "Nadaan Parindey A R Rahman" },
  { title: "The Less I Know The Better", artist: "Tame Impala",     band: "Tame Impala",     genre: "Indie",      mood: "Chill",       query: "The Less I Know The Better Tame Impala" },
  { title: "Do I Wanna Know?",           artist: "Arctic Monkeys",  band: "Arctic Monkeys",  genre: "Indie",      mood: "Focused",     query: "Do I Wanna Know Arctic Monkeys" },
  { title: "Kun Faya Kun",               artist: "A. R. Rahman",    band: "",                genre: "Sufi",       mood: "Calm",        query: "Kun Faya Kun A R Rahman" },
  { title: "Dreams",                     artist: "Fleetwood Mac",   band: "Fleetwood Mac",   genre: "Rock",       mood: "Chill",       query: "Dreams Fleetwood Mac" },
  { title: "Sicko Mode",                 artist: "Travis Scott",    band: "",                genre: "Hip-Hop",    mood: "Electric",    query: "Sicko Mode Travis Scott" },
  { title: "Redbone",                    artist: "Childish Gambino",band: "",                genre: "R&B",        mood: "Late Night",  query: "Redbone Childish Gambino" },
  { title: "Strobe",                     artist: "deadmau5",        band: "",                genre: "Electronic", mood: "Focused",     query: "Strobe deadmau5" },
  { title: "Take Five",                  artist: "Dave Brubeck",    band: "",                genre: "Jazz",       mood: "Chill",       query: "Take Five Dave Brubeck" },
  { title: "Clair de Lune",              artist: "Claude Debussy",  band: "",                genre: "Classical",  mood: "Calm",        query: "Clair de Lune Debussy" },
  { title: "HUMBLE.",                    artist: "Kendrick Lamar",  band: "",                genre: "Hip-Hop",    mood: "Electric",    query: "HUMBLE Kendrick Lamar" },
  { title: "Cigarettes out the Window",  artist: "TV Girl",         band: "TV Girl",         genre: "Indie",      mood: "Reflective",  query: "Cigarettes out the Window TV Girl" },
];

window.BLUE_MOODS = ["Electric", "Chill", "Focused", "Late Night", "Reflective", "Calm"];

window.BLUE_CHART_COLORS = ["#ffffff", "#7db7ff", "#d0d7e2", "#ffdf99", "#ff9f92", "#8ea0bd"];

// Per-name palettes so the donut chart can give each mood/genre a meaningful
// hue instead of cycling generic colors. Mood colors are tuned to the feeling
// ("Electric" warm/punchy, "Calm" cool green, etc). Genre colors are picked
// to be distinguishable in a single legend.
window.BLUE_MOOD_COLORS = {
  "Electric":   "#FF7847",
  "Chill":      "#7DB7FF",
  "Focused":    "#B991FF",
  "Late Night": "#5563E8",
  "Reflective": "#FFC971",
  "Calm":       "#7BD9A7",
  "Unknown":    "#8E9AAF",
};

window.BLUE_GENRE_COLORS = {
  "Hip-Hop":    "#6BCB77",
  "Bollywood":  "#FFA45B",
  "Sufi":       "#DDA15E",
  "K-Pop":      "#FF6FB5",
  "J-Pop":      "#FF80BF",
  "Latin":      "#F77F00",
  "Reggae":     "#6A994E",
  "Metal":      "#B83A4B",
  "Punk":       "#E63946",
  "R&B":        "#FF9F92",
  "Electronic": "#4D96FF",
  "Jazz":       "#8A6FBF",
  "Classical":  "#A8DADC",
  "Country":    "#C9A66B",
  "Folk":       "#B9956B",
  "Indie":      "#C589E8",
  "Pop":        "#FFD93D",
  "Rock":       "#FF6B6B",
  "Other":      "#8E9AAF",
  "Unknown":    "#5b6478",
};

// When the iTunes/MusicBrainz lookup fills in a previously-Unknown genre, we
// can also revise the mood — the original was inferred from the title with no
// genre signal and defaulted to "Chill" for almost everything. This map only
// fires when the existing mood is "Chill" (the bias-default), preserving any
// mood the user or LLM set deliberately.
window.BLUE_GENRE_MOOD = {
  "Hip-Hop":    "Electric",
  "Rock":       "Electric",
  "Metal":      "Electric",
  "Punk":       "Electric",
  "Electronic": "Focused",
  "K-Pop":      "Electric",
  "J-Pop":      "Electric",
  "Latin":      "Electric",
  "Indie":      "Chill",
  "Pop":        "Chill",
  "R&B":        "Late Night",
  "Jazz":       "Chill",
  "Classical":  "Calm",
  "Sufi":       "Calm",
  "Bollywood":  "Reflective",
  "Folk":       "Reflective",
  "Country":    "Chill",
  "Reggae":     "Chill",
};
