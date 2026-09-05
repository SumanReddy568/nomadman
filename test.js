// Self-check for the pure helpers in public/app.js and public/admin.js.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeOf, photoUrl, pickPhotos, fmtCoords, mapTrip } from "./public/app.js";
import { splitParas, joinParas, nextRank } from "./public/admin.js";

test("routeOf maps every hash to a view", () => {
  assert.deepEqual(routeOf(""), { view: "home", id: null });
  assert.deepEqual(routeOf("#/"), { view: "home", id: null });
  assert.deepEqual(routeOf("#/trips"), { view: "trips", id: null });
  assert.deepEqual(routeOf("#/map"), { view: "map", id: null });
  assert.deepEqual(routeOf("#/about"), { view: "about", id: null });
  assert.deepEqual(routeOf("#/admin"), { view: "admin", id: null });
  assert.deepEqual(routeOf("#/trip/kyoto"), { view: "story", id: "kyoto" });
  assert.deepEqual(routeOf("#/trip/torres%20del%20paine"), { view: "story", id: "torres del paine" });
  // unknown routes fall back home rather than rendering nothing
  assert.deepEqual(routeOf("#/nope"), { view: "home", id: null });
});

test("photoUrl escapes the token and id", () => {
  assert.equal(
    photoUrl("https://w.dev", "tok en", "a/b", "thumb"),
    "https://w.dev/share/tok%20en/photos/a%2Fb/thumb",
  );
  assert.match(photoUrl("https://w.dev", "t", "p"), /\/thumb$/); // default variant
});

test("fmtCoords picks the right hemisphere and degrades to empty", () => {
  assert.equal(fmtCoords(34.15, 77.58), "34.15° N, 77.58° E");
  assert.equal(fmtCoords(-50.94, -73.41), "50.94° S, 73.41° W");
  assert.equal(fmtCoords(0, 0), "0.00° N, 0.00° E");
  // an album with no map pin must not print "null° N"
  assert.equal(fmtCoords(null, null), "");
  assert.equal(fmtCoords(undefined, 5), "");
});

test("mapTrip fills every field a view reads", () => {
  const t = mapTrip(
    {
      id: "a1",
      title: "Above the treeline",
      place: "Ladakh, India",
      description: "album blurb",
      lat: 34.15,
      lon: 77.58,
      shareToken: "tok",
      coverPhotoId: "p1",
      photoCount: 12,
      createdAt: Date.UTC(2024, 8, 1),
      journal: { rank: 1, hero: true, date: "Sept 2024", lede: "Cold hands.", body: ["one", "", "two"], quote: "q", caption: "c" },
    },
    0,
  );
  assert.equal(t.num, "01");
  assert.equal(t.coords, "34.15° N, 77.58° E");
  assert.equal(t.hero, true);
  assert.equal(t.lede, "Cold hands.");
  assert.deepEqual(t.body, ["one", "two"], "blank paragraphs are dropped");
  assert.equal(t.share, "tok");
});

test("mapTrip degrades for a trip published with nothing but a rank", () => {
  const t = mapTrip({ id: "a2", title: "Kyoto", description: "rained all week", journal: { rank: 3 } }, 9);
  assert.equal(t.num, "10");
  assert.equal(t.place, "Kyoto", "falls back to the title when there is no pin");
  assert.equal(t.coords, "");
  assert.equal(t.lede, "rained all week", "album description becomes the lede");
  assert.deepEqual(t.body, []);
  assert.equal(t.hero, false);
  assert.equal(t.title, "Kyoto");
});

test("mapTrip survives a row with no journal at all", () => {
  const t = mapTrip({ id: "a3" }, 0);
  assert.equal(t.title, "Untitled trip");
  assert.deepEqual(t.body, []);
  assert.equal(t.coords, "");
});

test("pickPhotos keeps videos out of the editorial frames but in the grid", () => {
  const media = [
    { id: "v1", mediaType: "video" },
    { id: "p1" },
    { id: "p2", mediaType: "photo" },
    { id: "p3" },
    { id: "p4" },
  ];
  const p = pickPhotos(media);
  assert.equal(p.cover.id, "p1");
  assert.equal(p.bleed.id, "p2");
  assert.deepEqual(p.pair.map((m) => m.id), ["p3", "p4"]);
  assert.equal(p.all.length, 5, "the gallery still shows the video");
});

test("pickPhotos degrades instead of throwing", () => {
  assert.deepEqual(pickPhotos(undefined), { cover: null, bleed: null, pair: [null, null], all: [] });
  const one = pickPhotos([{ id: "only" }]);
  assert.equal(one.cover.id, "only");
  assert.equal(one.bleed, null);
  assert.deepEqual(one.pair, [null, null]);
  // a video-only album still gets a cover rather than a blank hero
  assert.equal(pickPhotos([{ id: "v", mediaType: "video" }]).cover.id, "v");
});

test("splitParas/joinParas round-trip the entry textarea", () => {
  assert.deepEqual(splitParas("one\n\ntwo\n\n\n  three  "), ["one", "two", "three"]);
  assert.deepEqual(splitParas("   "), []);
  assert.deepEqual(splitParas(undefined), []);
  // a single paragraph with a soft line break stays one paragraph
  assert.deepEqual(splitParas("line one\nline two"), ["line one\nline two"]);
  const paras = ["a", "b"];
  assert.deepEqual(splitParas(joinParas(paras)), paras);
  assert.equal(joinParas(undefined), "");
});

test("nextRank puts a newly published trip last", () => {
  assert.equal(nextRank([]), 1);
  assert.equal(nextRank([{ journal: { rank: 1 } }, { journal: { rank: 7 } }]), 8);
  // unpublished albums and garbage ranks are ignored, not counted as 0
  assert.equal(nextRank([{ journal: null }, { journal: { rank: 2 } }, {}]), 3);
  assert.equal(nextRank([{ journal: { rank: undefined } }]), 1);
});
