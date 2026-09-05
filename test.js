// Self-check for the pure helpers in public/app.js. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeOf, photoUrl, pickPhotos } from "./public/app.js";

test("routeOf maps every hash to a view", () => {
  assert.deepEqual(routeOf(""), { view: "home", id: null });
  assert.deepEqual(routeOf("#/"), { view: "home", id: null });
  assert.deepEqual(routeOf("#/trips"), { view: "trips", id: null });
  assert.deepEqual(routeOf("#/map"), { view: "map", id: null });
  assert.deepEqual(routeOf("#/about"), { view: "about", id: null });
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
});

test("a video-only album still gets a cover", () => {
  const p = pickPhotos([{ id: "v", mediaType: "video" }]);
  assert.equal(p.cover.id, "v");
});
