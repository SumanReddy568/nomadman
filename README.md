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
  app.js        router + the five views (home, trips, story, map, about)
  styles.css    the whole design system, one file
  trips.json    ALL content: prose, coords, and each trip's share token
  map.html      d3-geo world map, markers read from trips.json
design/         the canvas source, for reference
test.js         self-check for the pure helpers — `npm test`
```

## How photos get here

Each trip points at one **shared album** in the worker. Nothing here talks to S3
directly, and nothing here needs a login — only the public share surface:

| Call | Used for |
| --- | --- |
| `GET {apiBase}/share/{token}/api/album` | album title + photo list |
| `GET {apiBase}/share/{token}/photos/{id}/thumb` | gallery grid |
| `GET {apiBase}/share/{token}/photos/{id}/original` | the big editorial frames |
| `GET {apiBase}/share/{token}/zip` | "Download all" |

Per trip the site takes the first still as the cover/hero, the next as the
full-bleed frame, the next two as the detail pair, and shows **every** frame
(videos included, badged) in the gallery grid at the bottom of the entry.

A trip with `"share": ""` still renders — its frames fall back to labelled
placeholders — so the site is deployable before the albums exist.

## Wiring up a trip

1. In the worker's photo dashboard (`/photos`), create the album with the **S3**
   storage backend and upload the trip's photos.
2. Turn **sharing on** for that album and copy its share token (the `…/share/<token>`
   segment of the share link).
3. Paste it into the trip's `"share"` field in `public/trips.json`.

Adding a trip = one more object in `trips.json`. Set `lat`/`lon` and it appears on
the map; set `"hero": true` and it joins the home slideshow (first three win).

## Requires a worker deploy

The album JSON is fetched cross-origin, so `src/photos/handler.js` in the worker
now sets `Access-Control-Allow-Origin: *` on `GET /share/:token/api/album`. That
endpoint was already public and forwardable, so this exposes nothing new — but
**the worker must be redeployed** or every album fetch fails CORS and the site
shows placeholders.

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
