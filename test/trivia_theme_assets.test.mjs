import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.mjs", import.meta.url), "utf8");

test("control plane exposes an isolated trivia-theme region asset zone", () => {
  assert.match(source, /"trivia-theme-assets":\s*\{/);
  assert.match(source, /zone:\s*"trivia-theme"/);
  assert.match(source, /parts\[5\] === "trivia-theme-assets"/);
  assert.match(source, /buildOverlayAssetsResponse\(env, request, tenant, region, "trivia-theme"\)/);
});

test("theme uploads accept only PNG or WebP and are capped at 2 MiB", () => {
  assert.match(source, /MAX_TRIVIA_THEME_UPLOAD_BYTES = 2 \* 1024 \* 1024/);
  assert.match(source, /const TRIVIA_THEME_UPLOAD_TYPES = new Set\(\[\s*"image\/png",\s*"image\/webp"\s*\]\)/);
  assert.match(source, /file\.size > MAX_TRIVIA_THEME_UPLOAD_BYTES/);
});
