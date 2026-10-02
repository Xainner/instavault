import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const commands = read("src-tauri/src/commands.rs");
const client = read("src-tauri/src/instagram/client.rs");
const cdp = read("src-tauri/src/instagram/cdp_login.rs");
const lib = read("src-tauri/src/lib.rs");
const app = read("src/App.tsx");
const profiles = read("src/components/ProfilesView.tsx");
const media = read("src/components/MediaDetail.tsx");
const styles = read("src/App.css");

test("public commands cannot receive an account or load credentials", () => {
  const start = commands.indexOf("pub async fn lookup_public_profile");
  const end = commands.indexOf("/// Segundo paso deliberado", start);
  const publicCommand = commands.slice(start, end);
  assert.ok(start >= 0);
  assert.doesNotMatch(publicCommand, /account_id|creds::|load_cookies|cookie/i);
  assert.match(publicCommand, /WebProvider::public/);
});

test("the media HTTP client is credential free", () => {
  assert.doesNotMatch(client, /sessionid|csrftoken|x-ig-app-id|cookie_header|HeaderName.*cookie/i);
  assert.match(client, /Cliente sin estado/);
});

test("CDP never exports or injects browser cookies", () => {
  assert.doesNotMatch(cdp, /Network\.getCookies|Network\.setCookies|capture_cookies|set_session_cookies/);
});

test("unsafe legacy account commands are not exposed to the frontend", () => {
  assert.doesNotMatch(lib, /commands::(?:add_account|validate_account|import_browser_account|close_browser|fetch_profile)/);
});

test("opening the local library cannot fetch remote Instagram media", () => {
  assert.doesNotMatch(app, /downloadAvatar|download_avatar/);
  assert.match(profiles, /const src = localPath \?.*: null/);
  assert.match(media, /const local = m\.content_url \?\? m\.thumbnail_content_url/);
  const thumbStart = media.indexOf("const thumb = (m: Media)");
  const thumbEnd = media.indexOf("const kindStats", thumbStart);
  assert.doesNotMatch(media.slice(thumbStart, thumbEnd), /m\.thumbnail_url|m\.best_url/);
});

test("Radix dialog content renders above its blur overlay", () => {
  assert.match(styles, /\.modal-backdrop[\s\S]*?z-index:\s*100/);
  assert.match(styles, /\.modal\s*\{[\s\S]*?position:\s*fixed[\s\S]*?z-index:\s*101/);
});
