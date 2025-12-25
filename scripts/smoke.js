import assert from "node:assert/strict";
import { normalizeYouTubeUrl, buildYouTubeQuery } from "../src/sources/youtube.js";
import { isSoundCloudQuery, buildSoundCloudQuery } from "../src/sources/soundcloud.js";
import { isSpotifyUrl, normalizeSpotifyUrl } from "../src/sources/spotify.js";

assert.equal(
  normalizeYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=42"),
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
);
assert.equal(
  normalizeYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL"),
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
);
assert.equal(buildYouTubeQuery("lofi beats"), "ytsearch:lofi beats");
assert.equal(
  buildYouTubeQuery("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
);

assert.equal(isSoundCloudQuery("https://soundcloud.com/artist/track"), true);
assert.equal(buildSoundCloudQuery("lofi"), "scsearch:lofi");
assert.equal(buildSoundCloudQuery("soundcloud:lofi"), "scsearch:lofi");

assert.equal(isSpotifyUrl("https://open.spotify.com/track/123"), true);
assert.equal(
  normalizeSpotifyUrl("https://open.spotify.com/intl-de/track/123?si=abc"),
  "https://open.spotify.com/track/123?si=abc"
);

console.log("smoke ok");
