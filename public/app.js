// Nomadman — travel photo journal.
//
// Content (prose, coords, order) lives in trips.json. Photos live in the
// open-api-worker photo albums, reached through each trip's PUBLIC share
// token: GET {apiBase}/share/{token}/api/album returns the album + photo
// list, and {apiBase}/share/{token}/photos/{id}/{thumb|original} serves the
// bytes (S3-backed when the album was created with the s3 storage backend).
//
// A trip with an empty `share` still renders — the frames fall back to a
// labelled placeholder — so the site is deployable before the albums exist.

// ── pure helpers (exported for test.js) ─────────────────────────────

/** "#/trip/kyoto" -> { view: "story", id: "kyoto" } */
export function routeOf(hash) {
  const parts = String(hash || "").replace(/^#\/?/, "").split("/").filter(Boolean);
  if (!parts.length) return { view: "home", id: null };
  if (parts[0] === "trip") return { view: "story", id: parts[1] ? decodeURIComponent(parts[1]) : null };
  if (["trips", "map", "about"].includes(parts[0])) return { view: parts[0], id: null };
  return { view: "home", id: null };
}

export function photoUrl(apiBase, share, id, variant = "thumb") {
  return `${apiBase}/share/${encodeURIComponent(share)}/photos/${encodeURIComponent(id)}/${variant}`;
}

/**
 * Splits an album's media into the slots the story layout needs. Videos are
 * kept out of the big editorial frames (their `thumb` is only a poster) but
 * stay in the gallery, badged.
 */
export function pickPhotos(media) {
  const all = Array.isArray(media) ? media : [];
  const stills = all.filter((m) => (m.mediaType || "photo") !== "video");
  return {
    cover: stills[0] || all[0] || null,
    bleed: stills[1] || null,
    pair: [stills[2] || null, stills[3] || null],
    all,
  };
}

// ── state ──────────────────────────────────────────────────────────

let CFG = null;
let TRIPS = [];
const ALBUMS = new Map(); // trip id -> { title, description, photos[] } | null
let slide = 0;
let slideTimer = null;
let route = { view: "home", id: null };

const el = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const slots = (t) => pickPhotos(ALBUMS.get(t?.id)?.photos);

/** Renders a photo container. `m` is a media row (or null for a placeholder). */
function frame(t, m, hint, variant = "original") {
  if (!m) return `<div class="frame empty" data-hint="${esc(hint)}"></div>`;
  return `<div class="frame"><img src="${esc(photoUrl(CFG.apiBase, t.share, m.id, variant))}" alt="${esc(m.filename || hint)}" loading="lazy" decoding="async"></div>`;
}

// ── views ──────────────────────────────────────────────────────────

function viewHome() {
  const s = CFG.site;
  const heroTrips = TRIPS.filter((t) => t.hero).slice(0, 3);
  const hero = (heroTrips.length ? heroTrips : TRIPS.slice(0, 3)).map((t) => ({ t, m: slots(t).cover }));

  return `
<div class="view">
  <section class="hero">
    ${hero
      .map(
        ({ t, m }, i) => `
      <div class="hero-slide${i === slide ? " on" : ""}" data-slide="${i}">
        ${frame(t, m, `${t.marker} — hero frame`)}
      </div>`,
      )
      .join("")}
    <div class="hero-scrim"></div>
    <div class="hero-copy">
      <div>
        <div class="hero-kicker">${esc(s.kicker)}</div>
        <!-- headline is raw on purpose: it carries a <br>. trips.json is author-owned config, everything else is esc()'d. -->
        <h1>${s.headline}</h1>
        <p>${esc(s.intro)}</p>
        <div class="hero-cta">
          <a class="btn btn-primary" href="#/trips">Browse the trips <span class="ico" style="font-size:18px">arrow_forward</span></a>
          <a class="btn btn-ghost" href="#/map">Open the map</a>
        </div>
      </div>
    </div>
    <div class="hero-dots">
      ${hero
        .map(
          ({ t }, i) => `
        <button class="hero-dot${i === slide ? " on" : ""}" data-pick="${i}" type="button">
          <span>${esc(t.marker)}</span><i></i>
        </button>`,
        )
        .join("")}
    </div>
    <div class="hero-cue ico">keyboard_arrow_down</div>
  </section>

  <section class="intro">
    <div data-reveal>
      <div>
        <div class="kicker">Recent entries</div>
        <h2>${TRIPS.length} trips I am still thinking about.</h2>
      </div>
      <p>${esc(s.recentNote)}</p>
    </div>
  </section>

  <section class="reel">
    ${TRIPS.map((t) => {
      const m = slots(t).cover;
      return `
      <a class="reel-item" data-reveal href="#/trip/${encodeURIComponent(t.id)}">
        ${frame(t, m, `${t.marker} — cover frame`)}
        <div class="reel-copy">
          <div class="rule"><span>${esc(t.num)}</span><i></i><span>${esc(t.date)}</span></div>
          <h3>${esc(t.title)}</h3>
          <div class="place">${esc(t.place)}</div>
          <div class="more">Read the entry <span class="ico" style="font-size:16px">east</span></div>
        </div>
      </a>`;
    }).join("")}
  </section>

  <section class="closer" data-reveal>
    <div class="kicker">Everywhere else</div>
    <h2>The archive covers more ground than the journal does.</h2>
    <a class="btn btn-ghost" style="margin-top:28px" href="#/map">See the map <span class="ico" style="font-size:17px">public</span></a>
  </section>
</div>`;
}

function viewTrips() {
  return `
<div class="view page">
  <div class="inner">
    <div class="kicker">Index</div>
    <h1>Trips</h1>
    <div class="hairline"></div>
    ${TRIPS.map(
      (t) => `
      <a class="row" data-reveal href="#/trip/${encodeURIComponent(t.id)}">
        <span class="n">${esc(t.num)}</span>
        <div>
          <div class="t">${esc(t.title)}</div>
          <div class="p">${esc(t.place)}</div>
        </div>
        <div class="c">${esc(t.coords)}</div>
        <div class="d"><span>${esc(t.date)}</span><span class="ico">east</span></div>
      </a>`,
    ).join("")}
  </div>
</div>`;
}

function viewStory(id) {
  const idx = Math.max(0, TRIPS.findIndex((t) => t.id === id));
  const t = TRIPS[idx];
  const next = TRIPS[(idx + 1) % TRIPS.length];
  const p = slots(t);
  const album = ALBUMS.get(t.id);
  const count = p.all.length;

  return `
<div class="view">
  <section class="story-hero">
    ${frame(t, p.cover, `${t.marker} — wide establishing frame`)}
    <div class="story-copy">
      <div class="rule"><span>${esc(t.num)}</span><i></i><span>${esc(t.date)}</span><i></i><span>${esc(t.coords)}</span></div>
      <h1>${esc(t.title)}</h1>
      <div class="place">${esc(t.place)}</div>
    </div>
  </section>

  <div style="padding:80px 6vw 0">
    <div class="prose">
      <p class="lede" data-reveal>${esc(t.lede)}</p>
      <p data-reveal style="margin:32px 0 0">${esc(t.p1)}</p>
      <div class="pull" data-reveal>${esc(t.quote)}</div>
      <p data-reveal style="margin:0">${esc(t.p2)}</p>
    </div>
  </div>

  <div class="bleed" data-reveal>${frame(t, p.bleed, `${t.marker} — the full-bleed frame`)}</div>

  <div style="padding:64px 6vw 0">
    <div class="prose">
      <p data-reveal style="margin:0">${esc(t.p3)}</p>
      <div class="pair" data-reveal>
        ${frame(t, p.pair[0], "Detail frame")}
        ${frame(t, p.pair[1], "Detail frame")}
      </div>
      <div class="caption" data-reveal>${esc(t.caption)}</div>
    </div>
  </div>

  ${
    count
      ? `
  <section class="gallery" data-reveal>
    <div class="gallery-head">
      <div>
        <div class="kicker">Every frame</div>
        <div style="margin-top:10px;font-size:15px;color:var(--muted)">${count} from ${esc(album?.title || t.place)}</div>
      </div>
      <a class="btn btn-ghost" href="${esc(CFG.apiBase)}/share/${encodeURIComponent(t.share)}/zip">Download all <span class="ico" style="font-size:17px">download</span></a>
    </div>
    <div class="gallery-grid">
      ${p.all
        .map(
          (m) => `
        <a href="${esc(photoUrl(CFG.apiBase, t.share, m.id, "original"))}" target="_blank" rel="noopener" title="${esc(m.filename || "")}">
          ${frame(t, m, "", "thumb")}
          ${(m.mediaType || "photo") === "video" ? '<span class="ico" style="position:absolute;left:10px;bottom:8px;font-size:20px;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.6)">play_circle</span>' : ""}
        </a>`,
        )
        .join("")}
    </div>
  </section>`
      : ""
  }

  <a class="next" data-reveal href="#/trip/${encodeURIComponent(next.id)}">
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
      <p style="margin:0;font-size:15px;line-height:1.7;color:var(--muted);text-wrap:pretty">${TRIPS.length} journal entries so far. Click a marker to read the one attached to it.</p>
    </div>
  </div>
  <div class="map-shell"><div><iframe src="map.html" title="Map of destinations" loading="lazy"></iframe></div></div>
  <div style="padding:56px 6vw 120px">
    <div style="max-width:1320px;margin:0 auto">
      <div class="tiles">
        ${TRIPS.map(
          (t) => `
          <a class="tile" href="#/trip/${encodeURIComponent(t.id)}">
            <div class="c">${esc(t.coords)}</div>
            <div class="p">${esc(t.place)}</div>
            <div class="t">${esc(t.title)}</div>
          </a>`,
        ).join("")}
      </div>
    </div>
  </div>
</div>`;
}

function viewAbout() {
  const a = CFG.site.about;
  // The portrait can come from any album — point `portraitShare` at one and
  // `portraitIndex` at the frame within it.
  const src = a.portraitShare
    ? photoUrl(CFG.apiBase, a.portraitShare, (ALBUMS.get("__portrait")?.photos || [])[a.portraitIndex || 0]?.id, "original")
    : null;

  return `
<div class="view page">
  <div class="about">
    <div class="portrait">${
      src && !src.includes("undefined")
        ? `<div class="frame"><img src="${esc(src)}" alt="Portrait" loading="lazy"></div>`
        : '<div class="frame empty" data-hint="A portrait of you"></div>'
    }</div>
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
        <a class="btn btn-ghost" href="#/trips">Back to the trips</a>
      </div>
    </div>
  </div>
</div>`;
}

// ── render + wiring ────────────────────────────────────────────────

let io = null;

function render() {
  const html =
    route.view === "trips" ? viewTrips()
    : route.view === "story" ? viewStory(route.id)
    : route.view === "map" ? viewMap()
    : route.view === "about" ? viewAbout()
    : viewHome();

  el("view").innerHTML = html;

  document.querySelectorAll("[data-nav]").forEach((a) => {
    const on = a.dataset.nav === route.view || (route.view === "story" && a.dataset.nav === "trips");
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

  if (route.view === "home") startSlideshow();
  else stopSlideshow();
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

async function loadAlbum(t) {
  if (!t.share) return;
  try {
    const r = await fetch(`${CFG.apiBase}/share/${encodeURIComponent(t.share)}/api/album`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    ALBUMS.set(t.id, await r.json());
  } catch (err) {
    console.warn(`nomadman: album for "${t.id}" unavailable —`, err.message);
    ALBUMS.set(t.id, null);
  }
}

function onHash() {
  const next = routeOf(location.hash);
  route = next;
  render();
  scrollTo({ top: 0, behavior: "auto" });
}

async function boot() {
  CFG = await (await fetch("trips.json")).json();
  TRIPS = CFG.trips;

  route = routeOf(location.hash);
  render(); // paint placeholders immediately, then swap in photos

  const portrait = CFG.site.about.portraitShare;
  await Promise.all([
    ...TRIPS.map(loadAlbum),
    portrait ? loadAlbum({ id: "__portrait", share: portrait }) : null,
  ].filter(Boolean));
  render();

  addEventListener("hashchange", onHash);
  addEventListener("click", (e) => {
    const pick = e.target.closest("[data-pick]");
    if (pick) setSlide(Number(pick.dataset.pick));
  });
  // map.html posts the trip id when a marker is clicked
  addEventListener("message", (e) => {
    if (e.data?.type === "trip") location.hash = `#/trip/${encodeURIComponent(e.data.id)}`;
  });
}

if (typeof document !== "undefined") boot();
