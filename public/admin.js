// The journal editor. Loaded on demand by app.js when the route is /admin,
// so the public site never pays for it.
//
// There is no backend here. This talks straight to open-api-worker with the
// SAME account that owns the photo library:
//
//   POST  /login                      -> bearer token (source "photo-album")
//   GET   /photos/api/albums          -> your albums
//   POST  /photos/api/albums          -> create a trip
//   PATCH /photos/api/albums/:id      -> publish / unpublish / write the entry
//
// Publishing is the whole "sync": once an album is in the journal, the public
// pages read its photos live through its share token. Nothing is copied.
//
// The journal has ONE editor. This route isn't linked from anywhere public and
// refuses any account that isn't the super-user — but that's courtesy, not the
// control: the worker rejects a journal write from anyone else regardless of
// what this file does (see the gate in src/photos/handler.js).

import { CFG, esc, afterRender, loadTrips } from "./app.js";

const SOURCE = "photo-album";
const TOKEN_KEY = "nomadman_token";
const EMAIL_KEY = "nomadman_email";

let albums = [];
let isSuper = null; // null = not checked yet
let error = "";
let busy = false;
// albumId -> full album (with its photo list), fetched when a card needs the
// frame picker. The list endpoint doesn't carry photos.
const DETAIL = new Map();
// albumId -> ordered [photoId] being edited, so a click repaints instantly
// instead of waiting for a save. Order is the layout — see the helpers above.
const PICKED = new Map();
let drafting = null; // albumId currently waiting on the model
let dragId = null; // frame being dragged in the sequence strip

const token = () => localStorage.getItem(TOKEN_KEY) || "";
const account = () => localStorage.getItem(EMAIL_KEY) || "";

// ── pure helpers (exported for test.js) ────────────────────────────

/** Textarea -> body[]: blank lines separate paragraphs. */
export function splitParas(text) {
  return String(text || "")
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** body[] -> textarea. Inverse of splitParas for text that round-trips. */
export function joinParas(list) {
  return (Array.isArray(list) ? list : []).join("\n\n");
}

// The selection is an ORDERED list, not a set: its order is the layout. 1st
// leads the entry and is its cover, 2nd is the full-width frame, 3rd and 4th
// are the detail pair, the rest fill the grid. That's why AI sequencing and
// manual picking both write to the same array.

/** Drops ids no longer in the album (deleted photos), keeping order. */
export function cleanSelection(albumPhotos, ids) {
  const live = new Set((albumPhotos || []).map((p) => p.id));
  return (ids || []).filter((id) => live.has(id));
}

/**
 * Adds or removes one frame.
 *
 * While the selection is still in album order, adding inserts at the
 * chronological position — hand-picking a trip shouldn't need manual sorting.
 * Once it ISN'T (the model resequenced it, or "Date order" was never pressed
 * after), that order is a deliberate layout, so a new frame appends rather
 * than shoving itself in front of the chosen cover.
 */
export function togglePick(albumPhotos, current, id) {
  const ids = current || [];
  if (ids.includes(id)) return ids.filter((x) => x !== id);

  const album = (albumPhotos || []).map((p) => p.id);
  const rank = (x) => album.indexOf(x);
  const inAlbumOrder = ids.every((x, i) => i === 0 || rank(ids[i - 1]) <= rank(x));
  if (!inAlbumOrder) return [...ids, id];

  const out = [...ids];
  const before = out.findIndex((x) => rank(x) > rank(id));
  if (before === -1) out.push(id);
  else out.splice(before, 0, id);
  return out;
}

/** Moves one frame to an absolute position. Clamped; never wraps or mutates. */
export function moveToIndex(ids, id, to) {
  const out = [...(ids || [])];
  const from = out.indexOf(id);
  if (from === -1) return out;
  const target = Math.min(Math.max(Number(to), 0), out.length - 1);
  if (!Number.isInteger(target) || target === from) return out;
  out.splice(target, 0, out.splice(from, 1)[0]);
  return out;
}

/** Nudge one step. The keyboard/touch path — HTML5 drag does neither. */
export function moveInList(ids, id, delta) {
  const from = (ids || []).indexOf(id);
  if (from === -1) return [...(ids || [])];
  return moveToIndex(ids, id, from + delta);
}

/** Restores album (chronological) order for the current selection. */
export function dateOrder(albumPhotos, ids) {
  const chosen = new Set(ids || []);
  return (albumPhotos || []).map((p) => p.id).filter((id) => chosen.has(id));
}

/**
 * The model only sequences the frames it was shown (the first few). Its order
 * leads, anything else stays selected behind it.
 */
export function mergeDraftOrder(current, drafted) {
  const cur = current || [];
  const lead = (drafted || []).filter((id) => cur.includes(id));
  return [...lead, ...cur.filter((id) => !lead.includes(id))];
}

/** Next free rank, so a newly published trip lands at the end of the journal. */
export function nextRank(list) {
  const ranks = (list || [])
    .map((a) => a.journal?.rank)
    .filter((r) => Number.isFinite(r));
  return ranks.length ? Math.max(...ranks) + 1 : 1;
}

// ── worker API ─────────────────────────────────────────────────────

// Matches src/photos/dashboard_page.js exactly — the worker stores this hash,
// so any difference here means "Invalid login hash".
async function sha256Hash(email, password) {
  const enc = new TextEncoder().encode(email.toLowerCase() + ":" + password);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function api(path, opts = {}) {
  const res = await fetch(CFG.apiBase + path, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${token()}` },
  });
  if (res.status === 401) {
    signOut(false);
    throw new Error("Session expired — sign in again.");
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `Request failed (${res.status})`);
  }
  return res.json();
}

function patchAlbum(id, body) {
  return api(`/photos/api/albums/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function signOut(rerender = true) {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EMAIL_KEY);
  albums = [];
  isSuper = null;
  if (rerender) renderAdmin();
}

// The worker decides this, not the browser — /photos/api/config reports the
// caller's super-user status, and the PATCH gate re-checks it server-side
// regardless of what this returns. Hiding the editor is courtesy; the gate is
// the actual control.
async function loadIdentity() {
  const cfg = await api("/photos/api/config");
  isSuper = !!cfg.isSuper;
  if (cfg.email) localStorage.setItem(EMAIL_KEY, cfg.email);
  return isSuper;
}

// ── views ──────────────────────────────────────────────────────────

function loginView() {
  return `
<div class="view page">
  <div class="inner" style="max-width:420px">
    <div class="kicker">Journal editor</div>
    <h1 style="font-size:clamp(28px,3.6vw,44px)">Sign in</h1>
    <p style="margin:20px 0 0;font-size:15px;line-height:1.7;color:var(--muted)">
      The same account as your photo library at
      <a href="${esc(CFG.apiBase)}/photos" target="_blank" rel="noopener">/photos</a>.
    </p>
    <form id="login-form" class="adm-form" style="margin-top:28px">
      <label>Email<input type="email" id="adm-email" autocomplete="username" required value="${esc(account())}"></label>
      <label>Password<input type="password" id="adm-pass" autocomplete="current-password" required></label>
      ${error ? `<div class="adm-error">${esc(error)}</div>` : ""}
      <button class="btn btn-primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Signing in…" : "Sign in"}</button>
    </form>
  </div>
</div>`;
}

function albumCard(a) {
  const j = a.journal;
  const published = !!j;
  const warnShare = published && !a.shareEnabled;
  return `
<div class="adm-card${published ? " on" : ""}" data-album="${esc(a.id)}">
  <div class="adm-card-head">
    <div>
      <div class="adm-title">${esc(a.title)}</div>
      <div class="adm-meta">
        ${a.photoCount || 0} ${a.photoCount === 1 ? "frame" : "frames"}
        · ${a.locationName ? esc(a.locationName) : "no map pin"}
        · ${a.storageBackend === "s3" ? "S3" : "D1"}
        ${a.role === "collaborator" ? " · shared with you" : ""}
      </div>
    </div>
    <div class="adm-card-actions">
      <a class="btn btn-ghost sm" href="${esc(CFG.apiBase)}/photos?album=${encodeURIComponent(a.id)}" target="_blank" rel="noopener">Add photos</a>
      <label class="adm-switch">
        <input type="checkbox" data-publish ${published ? "checked" : ""}>
        <span>In the journal</span>
      </label>
    </div>
  </div>

  ${warnShare ? `
  <div class="adm-warn">
    This album's public link is off, so the journal can't show its photos.
    <button class="btn btn-ghost sm" data-enable-share>Turn the link on</button>
  </div>` : ""}

  ${published ? `
  <div class="adm-entry">
    <div class="adm-row">
      <label class="sm">Order<input type="number" data-f="rank" value="${esc(j.rank ?? 9999)}" min="0" step="1"></label>
      <label class="sm">Date label<input type="text" data-f="date" value="${esc(j.date || "")}" placeholder="Sept 2024"></label>
      <label class="adm-switch"><input type="checkbox" data-f="hero" ${j.hero ? "checked" : ""}><span>Use on the home hero</span></label>
    </div>
    <label>Lede — the opening line<textarea data-f="lede" rows="2" placeholder="${esc(a.description || "The first morning I could not walk up one flight of stairs.")}">${esc(j.lede || "")}</textarea></label>
    <label>Entry — blank line between paragraphs<textarea data-f="body" rows="7" placeholder="It does hard light, and then it does none…">${esc(joinParas(j.body))}</textarea></label>
    <label>Pull quote<textarea data-f="quote" rows="2">${esc(j.quote || "")}</textarea></label>
    <label>Caption under the detail pair<input type="text" data-f="caption" value="${esc(j.caption || "")}"></label>
    ${pickerBlock(a)}
    <div class="adm-row end">
      <span class="adm-saved" hidden>Saved</span>
      <button class="btn btn-primary sm" data-save>Save entry</button>
    </div>
  </div>` : ""}
</div>`;
}

// The frame picker. An album is the whole shoot; the entry is an edit of it.
// Nothing picked = the entry shows the whole album, which is what entries
// published before this existed keep doing.
function pickerBlock(a) {
  const detail = DETAIL.get(a.id);
  if (!detail) {
    return `<div class="adm-picker"><button class="btn btn-ghost sm" data-load-photos>Choose which frames appear…</button></div>`;
  }
  const photos = detail.photos || [];
  // Thumbs here load through the share link (an <img> can't send a bearer
  // token), so with the link off the picker would be a grid of blanks.
  if (!a.shareEnabled) {
    return `<div class="adm-picker"><div class="adm-meta">Turn the album's public link on to choose frames.</div></div>`;
  }
  if (!photos.length) {
    return `<div class="adm-picker"><div class="adm-meta">No photos in this album yet — add some, then pick the ones this entry shows.</div></div>`;
  }
  const picked = PICKED.get(a.id) || [];
  const n = picked.length;
  const SLOT = ["Cover", "Full width", "Detail", "Detail"];
  return `
  <div class="adm-picker">
    <div class="adm-picker-head">
      <div>
        <div class="adm-picker-title">Frames in this entry</div>
        <div class="adm-meta">${n ? `${n} of ${photos.length} chosen` : `nothing chosen — the entry shows all ${photos.length}`}</div>
      </div>
      <div class="adm-card-actions">
        <button class="btn btn-ghost sm" data-pick-date ${n ? "" : "disabled"}>Date order</button>
        <button class="btn btn-ghost sm" data-pick-none ${n ? "" : "disabled"}>Clear</button>
        <button class="btn btn-ghost sm" data-draft ${n && drafting !== a.id ? "" : "disabled"}>
          ${drafting === a.id ? "Reading the photos…" : "✨ Draft with AI"}
        </button>
      </div>
    </div>
    <div class="adm-meta" style="margin:2px 0 10px">
      Order is the layout: 1 is the cover and home hero, 2 runs full width, 3
      and 4 are the detail pair, the rest fill the grid. Drag a frame to move
      it (or use ◀ ▶), or let drafting sequence them — it reads up to the first
      six and rewrites the fields above.
    </div>
    ${n ? `
    <div class="adm-seq">
      ${picked.map((pid, i) => {
        const ph = photos.find((x) => x.id === pid);
        return `
        <div class="adm-seq-item" draggable="true" data-seq-id="${esc(pid)}">
          <div class="adm-seq-frame">
            <img draggable="false" src="${esc(CFG.apiBase)}/share/${encodeURIComponent(a.shareToken)}/photos/${encodeURIComponent(pid)}/thumb" alt="${esc(ph?.filename || "Frame")}" loading="lazy">
            <span class="adm-thumb-n">${i + 1}</span>
          </div>
          <div class="adm-seq-slot">${i < SLOT.length ? SLOT[i] : "Grid"}</div>
          <div class="adm-seq-move">
            <button type="button" data-move-id="${esc(pid)}" data-move-by="-1" ${i === 0 ? "disabled" : ""} title="Move earlier">◀</button>
            <button type="button" data-move-id="${esc(pid)}" data-move-by="1" ${i === n - 1 ? "disabled" : ""} title="Move later">▶</button>
          </div>
        </div>`;
      }).join("")}
    </div>` : ""}

    <div class="adm-thumbs">
      ${photos.map((ph) => {
        const at = picked.indexOf(ph.id);
        const on = at !== -1;
        return `
        <button type="button" class="adm-thumb${on ? " on" : ""}" data-pick-photo="${esc(ph.id)}" title="${esc(ph.filename || "")}">
          <img src="${esc(CFG.apiBase)}/share/${encodeURIComponent(a.shareToken)}/photos/${encodeURIComponent(ph.id)}/thumb" alt="${esc(ph.filename || "Frame")}" loading="lazy">
          ${on ? `<span class="adm-thumb-n">${at + 1}</span>` : ""}
          ${on && at < SLOT.length ? `<span class="adm-thumb-slot">${SLOT[at]}</span>` : ""}
        </button>`;
      }).join("")}
    </div>
  </div>`;
}

function editorView() {
  const published = albums.filter((a) => a.journal).length;
  return `
<div class="view page">
  <div class="inner">
    <div class="adm-head">
      <div>
        <div class="kicker">Journal editor</div>
        <h1 style="font-size:clamp(28px,3.6vw,44px)">Your trips</h1>
        <p class="adm-meta" style="margin-top:10px">
          ${published} of ${albums.length} ${albums.length === 1 ? "album" : "albums"} published ·
          signed in as ${esc(account())}
        </p>
      </div>
      <div class="adm-card-actions">
        <button class="btn btn-primary" id="new-trip">+ New trip</button>
        <button class="btn btn-ghost" id="sign-out">Sign out</button>
      </div>
    </div>

    ${error ? `<div class="adm-error" style="margin-top:20px">${esc(error)}</div>` : ""}

    <p class="adm-note">
      Publishing an album <em>is</em> the sync — the journal reads its photos live
      through the album's share link, so anything you upload at
      <a href="${esc(CFG.apiBase)}/photos" target="_blank" rel="noopener">/photos</a> appears here straight away.
    </p>

    <div class="adm-list">
      ${albums.length ? albums.map(albumCard).join("") : '<div class="adm-empty">No albums yet. Create your first trip above.</div>'}
    </div>
  </div>
</div>`;
}

// ── wiring ─────────────────────────────────────────────────────────

function cardBody(card) {
  const id = card.dataset.album;
  const get = (f) => card.querySelector(`[data-f="${f}"]`);
  return {
    rank: Number(get("rank")?.value ?? 9999),
    hero: !!get("hero")?.checked,
    date: get("date")?.value || null,
    lede: get("lede")?.value || null,
    body: splitParas(get("body")?.value),
    quote: get("quote")?.value || null,
    caption: get("caption")?.value || null,
    // Curated frames, in album order. Untouched pickers keep whatever was
    // already stored rather than silently clearing the selection.
    photos: PICKED.has(id)
      ? cleanSelection(DETAIL.get(id)?.photos, PICKED.get(id))
      : (albums.find((a) => a.id === id)?.journal?.photos || []),
  };
}

async function withError(fn) {
  try {
    error = "";
    await fn();
  } catch (err) {
    error = err.message;
  }
  await renderAdmin();
}

function wireEditor(root) {
  root.querySelector("#sign-out").addEventListener("click", () => signOut());

  root.querySelector("#new-trip").addEventListener("click", () =>
    withError(async () => {
      const title = prompt("Trip name — the location is geocoded from it, e.g. \"Ladakh 2024\"");
      if (!title?.trim()) return;
      // S3 backend to match where the rest of the archive lives; the album is
      // created empty and photos are added in the photo library.
      await api("/photos/api/albums", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), storageBackend: "s3" }),
      });
      await refresh();
    }));

  root.querySelectorAll(".adm-card").forEach((card) => {
    const id = card.dataset.album;

    card.querySelector("[data-publish]").addEventListener("change", (e) =>
      withError(async () => {
        // Unpublish sends null; publish seeds a rank so the trip lands last
        // and the entry fields appear ready to fill in.
        const journal = e.target.checked ? { rank: nextRank(albums), body: [] } : null;
        await patchAlbum(id, { journal });
        await refresh();
      }));

    // Photos aren't in the album LIST response, so the picker fetches them the
    // first time it's opened, then seeds the selection from what's stored.
    card.querySelector("[data-load-photos]")?.addEventListener("click", () =>
      withError(async () => {
        const detail = await api(`/photos/api/albums/${encodeURIComponent(id)}`);
        DETAIL.set(id, detail);
        const stored = albums.find((a) => a.id === id)?.journal?.photos || [];
        PICKED.set(id, cleanSelection(detail.photos, stored));
      }));

    card.querySelectorAll("[data-pick-photo]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const photos = DETAIL.get(id)?.photos || [];
        PICKED.set(id, togglePick(photos, PICKED.get(id), btn.dataset.pickPhoto));
        renderAdmin(); // repaint the numbering + the draft button's state
      });
    });

    card.querySelector("[data-pick-none]")?.addEventListener("click", () => {
      PICKED.set(id, []);
      renderAdmin();
    });

    // Drag to reorder. Delegated on the strip because renderAdmin() rebuilds
    // these nodes on every state change.
    const seq = card.querySelector(".adm-seq");
    if (seq) {
      const itemAt = (e) => e.target.closest("[data-seq-id]");
      const clearHints = () =>
        seq.querySelectorAll(".over").forEach((n) => n.classList.remove("over"));

      seq.addEventListener("dragstart", (e) => {
        const item = itemAt(e);
        if (!item) return;
        dragId = item.dataset.seqId;
        e.dataTransfer.effectAllowed = "move";
        // Firefox starts no drag at all without data set.
        e.dataTransfer.setData("text/plain", dragId);
        item.classList.add("dragging");
      });

      seq.addEventListener("dragover", (e) => {
        const item = itemAt(e);
        if (!item || !dragId || item.dataset.seqId === dragId) return;
        e.preventDefault(); // the default is "reject the drop"
        e.dataTransfer.dropEffect = "move";
        clearHints();
        item.classList.add("over");
      });

      seq.addEventListener("dragleave", (e) => itemAt(e)?.classList.remove("over"));

      seq.addEventListener("drop", (e) => {
        const item = itemAt(e);
        if (!item || !dragId) return;
        e.preventDefault();
        const order = [...seq.querySelectorAll("[data-seq-id]")].map((n) => n.dataset.seqId);
        PICKED.set(id, moveToIndex(PICKED.get(id), dragId, order.indexOf(item.dataset.seqId)));
        dragId = null;
        renderAdmin();
      });

      // Fires on a cancelled drag too, so the half-dragged styling never sticks.
      seq.addEventListener("dragend", () => {
        dragId = null;
        clearHints();
        seq.querySelectorAll(".dragging").forEach((n) => n.classList.remove("dragging"));
      });
    }

    card.querySelectorAll("[data-move-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        PICKED.set(id, moveInList(PICKED.get(id), btn.dataset.moveId, Number(btn.dataset.moveBy)));
        renderAdmin();
      });
    });

    card.querySelector("[data-pick-date]")?.addEventListener("click", () => {
      PICKED.set(id, dateOrder(DETAIL.get(id)?.photos, PICKED.get(id)));
      renderAdmin();
    });

    // Draft the entry from the chosen frames. The result only fills the form —
    // it is never saved for you.
    card.querySelector("[data-draft]")?.addEventListener("click", () =>
      withError(async () => {
        const photoIds = cleanSelection(DETAIL.get(id)?.photos, PICKED.get(id));
        drafting = id;
        await renderAdmin();
        try {
          const res = await api(`/photos/api/albums/${encodeURIComponent(id)}/journal/draft`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ photoIds }),
          });
          const album = albums.find((a) => a.id === id);
          const d = res.draft || {};
          // Keep rank/hero/date — those are the owner's layout decisions, not
          // the model's. Only the prose is replaced.
          album.journal = {
            ...album.journal,
            lede: d.lede,
            body: d.body,
            quote: d.quote,
            caption: d.caption,
          };
          // Its sequence is the layout decision: which frame is the cover, the
          // full-width one, the detail pair. Frames it wasn't shown stay put
          // behind them. Nothing is saved until "Save entry".
          if (res.photos?.length) {
            PICKED.set(id, mergeDraftOrder(PICKED.get(id), res.photos));
          }
        } finally {
          drafting = null;
        }
      }));

    card.querySelector("[data-enable-share]")?.addEventListener("click", () =>
      withError(async () => {
        await patchAlbum(id, { shareEnabled: true });
        await refresh();
      }));

    card.querySelector("[data-save]")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const saved = card.querySelector(".adm-saved");
      btn.disabled = true;
      try {
        error = "";
        const updated = await patchAlbum(id, { journal: cardBody(card) });
        Object.assign(albums.find((a) => a.id === id) || {}, updated);
        await loadTrips(); // keep the public views in step with the edit
        saved.hidden = false;
        setTimeout(() => { saved.hidden = true; }, 2000);
      } catch (err) {
        error = err.message;
        await renderAdmin();
        return;
      } finally {
        btn.disabled = false;
      }
    });
  });
}

function wireLogin(root) {
  root.querySelector("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = root.querySelector("#adm-email").value.trim();
    const password = root.querySelector("#adm-pass").value;
    busy = true;
    await withError(async () => {
      try {
        const hash = await sha256Hash(email, password);
        const r = await fetch(`${CFG.apiBase}/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: SOURCE, hash }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || "Login failed");
        localStorage.setItem(TOKEN_KEY, data.token);
        localStorage.setItem(EMAIL_KEY, data.email || email);
        await refresh();
      } finally {
        busy = false;
      }
    });
  });
}

async function refresh() {
  if (!(await loadIdentity())) return; // no point listing albums they can't publish
  albums = await api("/photos/api/albums");
  await loadTrips();
}

function notOwnerView() {
  return `
<div class="view page">
  <div class="inner" style="max-width:460px">
    <div class="kicker">Journal editor</div>
    <h1 style="font-size:clamp(28px,3.6vw,44px)">Not your journal.</h1>
    <p style="margin:20px 0 0;font-size:15px;line-height:1.7;color:var(--muted)">
      You're signed in as ${esc(account())}, but only the journal owner can
      publish trips here. Your own albums are unaffected — they live at
      <a href="${esc(CFG.apiBase)}/photos" target="_blank" rel="noopener">/photos</a>.
    </p>
    <button class="btn btn-ghost" id="sign-out" style="margin-top:26px">Sign out</button>
  </div>
</div>`;
}

// ── entry point ────────────────────────────────────────────────────

export async function renderAdmin() {
  const root = document.getElementById("view");

  if (token() && isSuper === null && !error) {
    try {
      await refresh();
    } catch (err) {
      error = err.message;
    }
  }

  if (!token()) {
    root.innerHTML = loginView();
    afterRender("admin");
    wireLogin(root);
    return;
  }

  if (isSuper === false) {
    root.innerHTML = notOwnerView();
    afterRender("admin");
    root.querySelector("#sign-out").addEventListener("click", () => signOut());
    return;
  }

  if (isSuper !== true) {
    // Identity couldn't be confirmed (network, expired session). Fall back to
    // the sign-in form with the reason rather than an editor shell that can't
    // save anything.
    root.innerHTML = loginView();
    afterRender("admin");
    wireLogin(root);
    return;
  }

  root.innerHTML = editorView();
  afterRender("admin");
  wireEditor(root);
}
