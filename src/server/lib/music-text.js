// Pure helpers for genre/mood inference from free-form text. No I/O.
// Used across providers (Spotify normalize, YouTube), the agent's intent
// fallback, and the iTunes/MusicBrainz classifier.

function inferMood(text) {
  const v = String(text || "").toLowerCase();
  if (/rock|guitar|hype|gym|party|electric|drive|punch|loud|metal|rage/.test(v)) return "Electric";
  if (/night|dark|late|midnight|2am|3am|after.?hours/.test(v)) return "Late Night";
  if (/focus|study|work|code|deep work|lock in|grind/.test(v)) return "Focused";
  if (/sad|deep|miss|think|emotional|reflect|nostalg|melanchol|alone/.test(v)) return "Reflective";
  if (/calm|peace|quiet|slow|sufi|ambient|meditat/.test(v)) return "Calm";
  if (/chill|relax|soft|easy|lo[\s-]?fi|coffee/.test(v)) return "Chill";
  return "";
}

// Order matters: more specific buckets first so "indie rock" lands in Indie
// (not Rock), "k-pop" in K-Pop (not Pop), etc.
const GENRE_BUCKETS = [
  ["Hip-Hop",   /\b(hip[\s-]?hop|rap|trap|drill|grime|boom bap)\b/],
  ["Bollywood", /\b(bollywood|filmi|hindi|desi|punjabi|bhangra|mumbai)\b/],
  ["Sufi",      /\b(sufi|qawwali|ghazal|nasheed)\b/],
  ["K-Pop",     /\bk[\s-]?pop\b/],
  ["J-Pop",     /\bj[\s-]?pop\b/],
  ["Latin",     /\b(reggaeton|salsa|latin|bachata|cumbia|samba|mariachi|bossa nova)\b/],
  ["Reggae",    /\b(reggae|dub|ska|dancehall)\b/],
  ["Metal",     /\b(metal|metalcore|deathcore|djent)\b/],
  ["Punk",      /\b(punk|hardcore|emo|screamo)\b/],
  ["R&B",       /\b(r&b|rnb|soul|neo[\s-]?soul|funk|motown)\b/],
  ["Electronic",/\b(edm|house|techno|dubstep|trance|electronic|electronica|drum and bass|dnb|garage|breakbeat|idm|future bass|big room|electro|synthwave)\b/],
  ["Jazz",      /\b(jazz|bebop|swing|bossa|fusion)\b/],
  ["Classical", /\b(classical|opera|baroque|orchestra|symphony|chamber)\b/],
  ["Country",   /\b(country|honky tonk|nashville)\b/],
  ["Folk",      /\b(folk|americana|bluegrass|singer[\s-]?songwriter)\b/],
  ["Indie",     /\b(indie|bedroom pop|lo[\s-]?fi|chillwave|dream pop|shoegaze|slacker)\b/],
  ["Pop",       /\b(pop|disco|new wave|boy band|girl group|teen)\b/],
  ["Rock",      /\b(rock|grunge|britpop|post[\s-]?rock|psych|garage rock|stoner|alt|alternative)\b/],
];

function normalizeGenre(raw) {
  if (!raw) return "Unknown";
  const lower = String(raw).toLowerCase();
  for (const [bucket, re] of GENRE_BUCKETS) {
    if (re.test(lower)) return bucket;
  }
  return "Other";
}

function pickArtistGenre(genres = []) {
  if (!genres.length) return "Unknown";
  const counts = {};
  for (const raw of genres) {
    const bucket = normalizeGenre(raw);
    counts[bucket] = (counts[bucket] || 0) + 1;
  }
  const realKeys = Object.keys(counts).filter((k) => k !== "Unknown" && k !== "Other");
  const winner = (realKeys.length ? realKeys : Object.keys(counts))
    .sort((a, b) => counts[b] - counts[a])[0];
  return winner || "Unknown";
}

function inferGenreFromText(text = "") {
  const v = text.toLowerCase();
  if (/rahman|arijit|atif|bollywood|hindi/.test(v)) return "Bollywood";
  if (/qawwali|sufi|nusrat/.test(v))                return "Sufi";
  if (/arctic monkeys|tame impala|mac demarco|the strokes/.test(v)) return "Indie";
  if (/weeknd|dua lipa|taylor swift|harry styles|billie eilish/.test(v)) return "Pop";
  if (/kendrick|drake|travis scott|j cole|eminem|kanye/.test(v)) return "Hip-Hop";
  if (/fleetwood|guns n.? roses|led zeppelin|queen|nirvana|foo fighters/.test(v)) return "Rock";
  if (/daft punk|deadmau5|skrillex|calvin harris|tiesto/.test(v)) return "Electronic";
  return "Unknown";
}

module.exports = {
  inferMood,
  GENRE_BUCKETS,
  normalizeGenre,
  pickArtistGenre,
  inferGenreFromText,
};
