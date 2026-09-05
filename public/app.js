// Nomadman — travel photo journal.
//
// There is no trip content in this repo. A trip is an album in the
// open-api-worker photo app that its owner published to the journal. The
// public feed GET {apiBase}/journal/api/trips returns those (title, place,
// coords, share token, cover, entry copy), and the photos are read through
// each trip's public share token:
//
//   {apiBase}/share/{token}/api/album              the photo list (story view only)
//   {apiBase}/share/{token}/photos/{id}/thumb      gallery grid
//   {apiBase}/share/{token}/photos/{id}/original   editorial frames
//
// config.json holds only the API origin and the site's own standing copy.
// Publishing, ordering and writing an entry all happen at /admin.

// ── pure helpers (exported for test.js) ─────────────────────────────

/**
 * "/trip/kyoto" -> { view: "story", id: "kyoto" }
 * Real paths, not hashes: the Worker serves index.html for anything that isn't
 * a file (not_found_handling = single-page-application) and this decides what
 * to draw. Links shared before real paths existed are rewritten on boot.
 */
export function routeOf(pathname) {
  const parts = String(pathname || "/").split("?")[0].split("/").filter(Boolean);
  if (!parts.length) return { view: "home", id: null };
  if (parts[0] === "trip") return { view: "story", id: parts[1] ? decodeURIComponent(parts[1]) : null };
  if (["trips", "map", "about", "admin"].includes(parts[0])) return { view: parts[0], id: null };
  return { view: "home", id: null };
}

/** The path for a trip entry. */
export function tripPath(id) {
  return `/trip/${encodeURIComponent(id)}`;
}

export function photoUrl(apiBase, share, id, variant = "thumb") {
  return `${apiBase}/share/${encodeURIComponent(share)}/photos/${encodeURIComponent(id)}/${variant}`;
}

/** 34.15, 77.58 -> "34.15° N, 77.58° E". Empty when the album has no pin. */
export function fmtCoords(lat, lon) {
  if (typeof lat !== "number" || typeof lon !== "number") return "";
  return `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? "E" : "W"}`;
}

/**
 * Feed row -> what the views render. Anything the album can't supply falls
 * back to something printable, so a trip published with nothing but a rank
 * still renders a complete-looking entry.
 */
export function mapTrip(row, i) {
  const j = row.journal || {};
  const body = Array.isArray(j.body) ? j.body.filter(Boolean) : [];
  return {
    id: row.id,
    share: row.shareToken,
    coverPhotoId: row.coverPhotoId || null,
    photoCount: row.photoCount || 0,
    num: String(i + 1).padStart(2, "0"),
    title: row.title || "Untitled trip",
    place: row.place || row.title || "",
    marker: row.place || row.title || "",
    date: j.date || (row.createdAt
      ? new Date(row.createdAt).toLocaleDateString(undefined, { month: "long", year: "numeric" })
      : ""),
    lat: typeof row.lat === "number" ? row.lat : null,
    lon: typeof row.lon === "number" ? row.lon : null,
    coords: fmtCoords(row.lat, row.lon),
    hero: !!j.hero,
    // The album description is the natural lede for a trip published without
    // one — it's already the blurb its owner wrote for the album.
    lede: j.lede || row.description || "",
    body,
    quote: j.quote || "",
    caption: j.caption || "",
    // The frames this entry shows. Empty = show the whole album.
    photoIds: Array.isArray(j.photos) ? j.photos : [],
  };
}

/**
 * Splits an album's media into the slots the story layout needs. Videos are
 * kept out of the big editorial frames (their `thumb` is only a poster) but
 * stay in the gallery, badged.
 *
 * `selected` is the entry's curated frame list (journal.photos): an album is a
 * whole shoot, an entry is an edit of it. Given one, the entry shows exactly
 * those, in that order — a selected-but-since-deleted photo just drops out.
 * Empty means uncurated, and the whole album shows.
 */
export function pickPhotos(media, selected) {
  const media_ = Array.isArray(media) ? media : [];
  const ids = Array.isArray(selected) ? selected : [];
  const byId = new Map(media_.map((m) => [m.id, m]));
  const all = ids.length ? ids.map((id) => byId.get(id)).filter(Boolean) : media_;
  const stills = all.filter((m) => (m.mediaType || "photo") !== "video");
  return {
    cover: stills[0] || all[0] || null,
    bleed: stills[1] || null,
    pair: [stills[2] || null, stills[3] || null],
    all,
  };
}

// ── state ──────────────────────────────────────────────────────────

export let CFG = null;
let TRIPS = [];
let feedError = null;
const ALBUMS = new Map(); // trip id -> album JSON | null, filled lazily per story
let slide = 0;
let slideTimer = null;
let io = null;
let route = { view: "home", id: null };

const el = (id) => document.getElementById(id);
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const slots = (t) => pickPhotos(ALBUMS.get(t?.id)?.photos, t?.photoIds);

// The album's own cover only stands in while the entry is uncurated — once
// frames are picked, the first pick leads, or the album cover would show a
// photo the owner deliberately left out of the entry.
const coverIdOf = (t) => (t.photoIds?.length ? t.photoIds[0] : t.coverPhotoId);

/** A photo container, by photo id. A null id renders the labelled placeholder. */
function frame(t, id, hint, variant = "original") {
  if (!id || !t.share) return `<div class="frame empty" data-hint="${esc(hint)}"></div>`;
  return `<div class="frame"><img src="${esc(photoUrl(CFG.apiBase, t.share, id, variant))}" alt="${esc(hint)}" loading="lazy" decoding="async"></div>`;
}

// ── views ──────────────────────────────────────────────────────────

function emptyState() {
  return `
<div class="view page">
  <div class="inner" style="max-width:660px">
    <div class="kicker">Nothing published yet</div>
    <h1 style="font-size:clamp(30px,4vw,52px)">The journal is empty.</h1>
    <p style="margin:24px 0 0;font-size:17px;line-height:1.7;color:var(--muted);text-wrap:pretty">
      ${feedError
        ? "Entries could not be loaded just now. Please try again in a moment."
        : "Nothing has been published here yet. Check back soon."}
    </p>
    <div style="display:flex;gap:12px;margin:32px 0 0;flex-wrap:wrap">
      <a class="btn btn-ghost" href="/">Back to the front <span class="ico" style="font-size:17px">arrow_forward</span></a>
    </div>
  </div>
</div>`;
}

function viewHome() {
  if (!TRIPS.length) return emptyState();
  const s = CFG.site;
  const heroTrips = TRIPS.filter((t) => t.hero);
  const hero = (heroTrips.length ? heroTrips : TRIPS).slice(0, 3);

  return `
<div class="view">
  <section class="hero">
    ${hero.map((t, i) => `
      <div class="hero-slide${i === slide ? " on" : ""}">${frame(t, coverIdOf(t), `${t.marker} — hero frame`)}</div>`).join("")}
    <div class="hero-scrim"></div>
    <div class="hero-copy">
      <div>
        <div class="hero-kicker">${esc(s.kicker)}</div>
        <!-- headline is raw on purpose: it carries a <br>. config.json is author-owned; everything from the API is esc()'d. -->
        <h1>${s.headline}</h1>
        <p>${esc(s.intro)}</p>
        <div class="hero-cta">
          <a class="btn btn-primary" href="/trips">Browse the trips <span class="ico" style="font-size:18px">arrow_forward</span></a>
          <a class="btn btn-ghost" href="/map">Open the map</a>
        </div>
      </div>
    </div>
    <div class="hero-dots">
      ${hero.map((t, i) => `
        <button class="hero-dot${i === slide ? " on" : ""}" data-pick="${i}" type="button"><span>${esc(t.marker)}</span><i></i></button>`).join("")}
    </div>
    <div class="hero-cue ico">keyboard_arrow_down</div>
  </section>

  <section class="intro">
    <div data-reveal>
      <div>
        <div class="kicker">Recent entries</div>
        <h2>${TRIPS.length} ${TRIPS.length === 1 ? "trip" : "trips"} I am still thinking about.</h2>
      </div>
      <p>${esc(s.recentNote)}</p>
    </div>
  </section>

  <section class="reel">
    ${TRIPS.map((t) => `
      <a class="reel-item" data-reveal href="${tripPath(t.id)}">
        ${frame(t, coverIdOf(t), `${t.marker} — cover frame`)}
        <div class="reel-copy">
          <div class="rule"><span>${esc(t.num)}</span><i></i><span>${esc(t.date)}</span></div>
          <h3>${esc(t.title)}</h3>
          <div class="place">${esc(t.place)}</div>
          <div class="more">Read the entry <span class="ico" style="font-size:16px">east</span></div>
        </div>
      </a>`).join("")}
  </section>

  <section class="closer" data-reveal>
    <div class="kicker">Everywhere else</div>
    <h2>The archive covers more ground than the journal does.</h2>
    <a class="btn btn-ghost" style="margin-top:28px" href="/map">See the map <span class="ico" style="font-size:17px">public</span></a>
  </section>
</div>`;
}

function viewTrips() {
  if (!TRIPS.length) return emptyState();
  return `
<div class="view page">
  <div class="inner">
    <div class="kicker">Index</div>
    <h1>Trips</h1>
    <div class="hairline"></div>
    ${TRIPS.map((t) => `
      <a class="row" data-reveal href="${tripPath(t.id)}">
        <span class="n">${esc(t.num)}</span>
        <div>
          <div class="t">${esc(t.title)}</div>
          <div class="p">${esc(t.place)}</div>
        </div>
        <div class="c">${esc(t.coords)}</div>
        <div class="d"><span>${esc(t.date)}</span><span class="ico">east</span></div>
      </a>`).join("")}
  </div>
</div>`;
}

function viewStory(id) {
  if (!TRIPS.length) return emptyState();
  const idx = Math.max(0, TRIPS.findIndex((t) => t.id === id));
  const t = TRIPS[idx];
  const next = TRIPS[(idx + 1) % TRIPS.length];
  const p = slots(t);
  const para = (txt, style = "") => (txt ? `<p data-reveal style="${style}">${esc(txt)}</p>` : "");

  return `
<div class="view">
  <section class="story-hero">
    ${frame(t, p.cover?.id || coverIdOf(t), `${t.marker} — wide establishing frame`)}
    <div class="story-copy">
      <div class="rule"><span>${esc(t.num)}</span><i></i><span>${esc(t.date)}</span>${t.coords ? `<i></i><span>${esc(t.coords)}</span>` : ""}</div>
      <h1>${esc(t.title)}</h1>
      <div class="place">${esc(t.place)}</div>
    </div>
  </section>

  <div style="padding:80px 6vw 0">
    <div class="prose">
      ${t.lede ? `<p class="lede" data-reveal>${esc(t.lede)}</p>` : ""}
      ${para(t.body[0], "margin:32px 0 0")}
      ${t.quote ? `<div class="pull" data-reveal>${esc(t.quote)}</div>` : ""}
      ${para(t.body[1], "margin:0")}
    </div>
  </div>

  <div class="bleed" data-reveal>${frame(t, p.bleed?.id, `${t.marker} — the full-bleed frame`)}</div>

  <div style="padding:64px 6vw 0">
    <div class="prose">
      ${t.body.slice(2).map((b) => para(b, "margin:0 0 24px")).join("")}
      <div class="pair" data-reveal>
        ${frame(t, p.pair[0]?.id, "Detail frame")}
        ${frame(t, p.pair[1]?.id, "Detail frame")}
      </div>
      ${t.caption ? `<div class="caption" data-reveal>${esc(t.caption)}</div>` : ""}
    </div>
  </div>

  ${p.all.length ? `
  <section class="gallery" data-reveal>
    <div class="gallery-head">
      <div>
        <div class="kicker">Every frame</div>
        <div style="margin-top:10px;font-size:15px;color:var(--muted)">${p.all.length} from ${esc(t.title)}</div>
      </div>
      <a class="btn btn-ghost" href="${esc(CFG.apiBase)}/share/${encodeURIComponent(t.share)}/zip">Download all <span class="ico" style="font-size:17px">download</span></a>
    </div>
    <div class="gallery-grid">
      ${p.all.map((m) => `
        <a href="${esc(photoUrl(CFG.apiBase, t.share, m.id, "original"))}" target="_blank" rel="noopener" title="${esc(m.filename || "")}">
          ${frame(t, m.id, m.filename || "Frame", "thumb")}
          ${(m.mediaType || "photo") === "video" ? '<span class="ico play-badge">play_circle</span>' : ""}
        </a>`).join("")}
    </div>
  </section>` : ""}

  <a class="next" data-reveal href="${tripPath(next.id)}">
    <div>
      <div>
        <div class="kicker">Next entry</div>
        <h3>${esc(next.title)}</h3>
        <div class="place">${esc(next.place)}</div>
      </div>
      <span class="ico">east</span>
    </div>
  </a>
</div>`;
}

function viewMap() {
  return `
<div class="view" style="padding:132px 0 0">
  <div style="padding:0 6vw">
    <div style="max-width:1320px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,360px);gap:clamp(24px,5vw,72px);align-items:end">
      <div>
        <div class="kicker">Coordinates</div>
        <h1 style="margin:14px 0 0;font-size:clamp(36px,5vw,72px);line-height:1;font-weight:600;letter-spacing:-.035em">Where I've shot</h1>
      </div>
      <p style="margin:0;font-size:15px;line-height:1.7;color:var(--muted);text-wrap:pretty">${TRIPS.length} ${TRIPS.length === 1 ? "entry" : "entries"} so far. Click a marker to read the one attached to it.</p>
    </div>
  </div>
  <div class="map-shell"><div><iframe src="/map.html" title="Map of destinations" loading="lazy"></iframe></div></div>
  <div style="padding:56px 6vw 120px">
    <div style="max-width:1320px;margin:0 auto">
      <div class="tiles">
        ${TRIPS.map((t) => `
          <a class="tile" href="${tripPath(t.id)}">
            <div class="c">${esc(t.coords || "No pin set")}</div>
            <div class="p">${esc(t.place)}</div>
            <div class="t">${esc(t.title)}</div>
          </a>`).join("")}
      </div>
    </div>
  </div>
</div>`;
}

function viewAbout() {
  const a = CFG.site.about;
  return `
<div class="view page">
  <div class="about">
    <div class="portrait"><div class="frame empty" data-hint="A portrait of you"></div></div>
    <div>
      <div class="kicker">About</div>
      <h1>${esc(a.headline)}</h1>
      <p style="margin:28px 0 0">${esc(a.p1)}</p>
      <p style="margin:20px 0 0">${esc(a.p2)}</p>
      <div class="stats">
        ${a.stats.map((s) => `<div><div class="v">${esc(s.value)}</div><div class="l">${esc(s.label)}</div></div>`).join("")}
      </div>
      <div style="display:flex;gap:12px;margin:36px 0 0;flex-wrap:wrap">
        <a class="btn btn-primary" href="mailto:${esc(CFG.site.email)}">Get in touch <span class="ico" style="font-size:17px">mail</span></a>
        <a class="btn btn-ghost" href="/trips">Back to the trips</a>
      </div>
    </div>
  </div>
</div>`;
}

// ── render + wiring ────────────────────────────────────────────────

export function render() {
  const html =
    route.view === "trips" ? viewTrips()
    : route.view === "story" ? viewStory(route.id)
    : route.view === "map" ? viewMap()
    : route.view === "about" ? viewAbout()
    : viewHome();

  el("view").innerHTML = html;
  afterRender(route.view);
  if (route.view === "home") startSlideshow();
  else stopSlideshow();
}

/** Post-render wiring shared with admin.js, which paints into #view itself. */
export function afterRender(viewName = route.view) {
  document.querySelectorAll("[data-nav]").forEach((a) => {
    const on = a.dataset.nav === viewName || (viewName === "story" && a.dataset.nav === "trips");
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });

  // Fade each frame in once its bytes land (avoids a grey-to-photo pop).
  document.querySelectorAll(".frame img").forEach((img) => {
    if (img.complete && img.naturalWidth) img.classList.add("on");
    else img.addEventListener("load", () => img.classList.add("on"), { once: true });
    img.addEventListener("error", () => img.closest(".frame")?.classList.add("empty"), { once: true });
  });

  io?.disconnect();
  io = new IntersectionObserver(
    (entries) => entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add("seen");
      io.unobserve(e.target);
    }),
    { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
  );
  document.querySelectorAll("[data-reveal]").forEach((n) => io.observe(n));
}

function startSlideshow() {
  stopSlideshow();
  const n = document.querySelectorAll(".hero-slide").length;
  if (n < 2) return;
  slideTimer = setInterval(() => setSlide((slide + 1) % n), 6000);
}
function stopSlideshow() {
  clearInterval(slideTimer);
  slideTimer = null;
}
function setSlide(i) {
  slide = i;
  document.querySelectorAll(".hero-slide").forEach((n, k) => n.classList.toggle("on", k === i));
  document.querySelectorAll(".hero-dot").forEach((n, k) => n.classList.toggle("on", k === i));
}

/** The photo list for one trip. Only a story view needs it, so it's lazy. */
async function loadAlbum(t) {
  if (!t?.share || ALBUMS.has(t.id)) return;
  ALBUMS.set(t.id, null); // claim it so a re-render doesn't refetch
  try {
    const r = await fetch(`${CFG.apiBase}/share/${encodeURIComponent(t.share)}/api/album`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    ALBUMS.set(t.id, await r.json());
  } catch (err) {
    console.warn(`nomadman: photos for "${t.id}" unavailable —`, err.message);
  }
}

/** Re-read the trip feed. Called on boot and after the admin changes anything. */
export async function loadTrips() {
  try {
    const r = await fetch(`${CFG.apiBase}/journal/api/trips`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    TRIPS = (data.trips || []).map(mapTrip);
    feedError = null;
  } catch (err) {
    feedError = err.message;
    TRIPS = [];
    console.warn("nomadman: trip feed unavailable —", err.message);
  }
  ALBUMS.clear(); // share tokens may have been regenerated
  return TRIPS;
}

async function show() {
  if (route.view === "admin") {
    const admin = await import("./admin.js");
    await admin.renderAdmin();
    return;
  }
  render();
  if (route.view === "story" && TRIPS.length) {
    const t = TRIPS.find((x) => x.id === route.id) || TRIPS[0];
    if (!ALBUMS.has(t.id)) {
      await loadAlbum(t);
      if (route.view === "story") render(); // swap placeholders for real frames
    }
  }
}

/** Client-side navigation. */
export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, "", path);
  else history.pushState({}, "", path);
  onRoute();
}

function onRoute() {
  route = routeOf(location.pathname);
  show();
  scrollTo({ top: 0, behavior: "auto" });
}

// Intercept plain left-clicks on in-app links so they route without a reload.
// Anything the browser would treat specially — new tab, download, another
// origin, a modifier held — is left alone, as is any path with a file
// extension (/map.html is a real document).
function interceptLinks(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest("a");
  if (!a || a.target || a.hasAttribute("download") || a.origin !== location.origin) return;
  if (a.pathname.includes(".")) return;
  e.preventDefault();
  const path = a.pathname + a.search;
  if (path !== location.pathname + location.search) navigate(path);
  else scrollTo({ top: 0, behavior: "smooth" });
}

async function boot() {
  CFG = await (await fetch("/config.json")).json();

  // Links shared while the site was hash-routed still land in the right place.
  if (location.hash.startsWith("#/")) {
    history.replaceState({}, "", location.hash.slice(1) || "/");
  }

  route = routeOf(location.pathname);
  await loadTrips();
  await show();

  addEventListener("popstate", onRoute);
  addEventListener("click", (e) => {
    const pick = e.target.closest("[data-pick]");
    if (pick) {
      setSlide(Number(pick.dataset.pick));
      return;
    }
    interceptLinks(e);
  });
  // map.html posts the trip id when a marker is clicked
  addEventListener("message", (e) => {
    if (e.data?.type === "trip") navigate(tripPath(e.data.id));
  });
}

if (typeof document !== "undefined") boot();
