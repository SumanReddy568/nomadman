# nomadman

Travel photo journal. A static front-end over the photo albums already living in
[`cloud-fare-open-api-worker`](https://github.com/SumanReddy568/cloud-fare-open-api-worker)
(D1 metadata + S3 bytes, bucket `sumanreddy-worker-photos-bucket`).

Design source: the Claude Design canvas in `design/` (`Nomadman.dc.html`, `map.html`).
That's the mockup — `public/` is the implementation.

```
wrangler.toml   static-assets Worker: uploads public/, no server code
public/
  index.html    shell: nav, <main>, footer
  app.js        router + the public views (home, trips, story, map, about)
  admin.js      the journal editor, loaded only on #/admin
  styles.css    the whole design system, one file
  config.json   API origin + the site's own standing copy. No trip content.
  map.html      d3-geo world map, markers read from the live feed
design/         the canvas source, for reference
test.js         self-check for the pure helpers — `npm test`
```

## Where the content lives

Nothing in this repo. A **trip is an album** in the worker's photo library that
you published to the journal. The public feed returns those, and the photos are
read live through each album's share token — publishing *is* the sync, nothing
is ever copied here.

| Call | Used for | Auth |
| --- | --- | --- |
| `GET {apiBase}/journal/api/trips` | the trip index + entry copy | none |
| `GET {apiBase}/share/{token}/api/album` | one trip's photo list | none |
| `GET {apiBase}/share/{token}/photos/{id}/thumb` | gallery grid | none |
| `GET {apiBase}/share/{token}/photos/{id}/original` | editorial frames | none |
| `GET {apiBase}/share/{token}/zip` | "Download all" | none |
| `POST {apiBase}/login` | the editor | — |
| `GET/POST/PATCH {apiBase}/photos/api/albums` | the editor | bearer |

Per trip the site takes the first still as the cover/hero, the next as the
full-bleed frame, the next two as the detail pair, and shows **every** frame
(videos included, badged) in the gallery grid at the foot of the entry.

## The editor (`#/admin`)

Sign in with the same account as the photo library. There is no separate
password and no backend of its own — nomadman calls the worker's existing
`/login` and album APIs straight from the browser.

- **In the journal** — the toggle that publishes an album. That's the sync.
- **Order / Date label / home hero** — where it sits and how it's captioned.
- **Lede, entry, pull quote, caption** — the writing. Blank lines split
  paragraphs. Left empty, the album's own description becomes the lede.
- **+ New trip** — creates an S3-backed album; upload into it at `/photos`.

An album published with its share link off is flagged, because the journal
reads photos through that link and would otherwise show empty frames.

## Requires a worker deploy

This site depends on worker changes that are **not deployed yet** — until they
are, the journal renders its empty state:

- `GET /journal/api/trips`, the public trip feed (new).
- `Access-Control-Allow-Origin: *` on `GET /share/:token/api/album`, so the
  album JSON can be read cross-origin. Both endpoints were already public and
  forwardable, so neither exposes anything new.
- Migration `0010_album_journal.sql` adds the nullable `albums.journal` column.
  **Apply it before deploying**, or every publish fails:

  ```sh
  npx wrangler d1 migrations apply photos_db --remote
  ```

```sh
cd ../cloud-fare-open-api-worker && npx wrangler deploy
```

## Develop

```sh
npm run dev      # plain static server on :3000, fastest loop
npm test         # node --test over the pure helpers
npm run preview  # wrangler dev — the real Worker runtime
npm run deploy   # wrangler deploy -> nomadman.<subdomain>.workers.dev
```

`file://` won't work — `trips.json` is fetched, so it needs a server.

## Why a Worker and not Pages

`wrangler.toml` declares an `[assets]` directory and no `main`, so this is a
static-assets Worker: wrangler uploads `public/` and Cloudflare serves it. Same
account as `open-api-worker`, separate deployment, separate origin — which is
exactly why that worker needs the CORS header above.
