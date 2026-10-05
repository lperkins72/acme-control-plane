import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { listTriviaThemeAssetReferences } from "../src/index.mjs";

const source = await readFile(new URL("../src/index.mjs", import.meta.url), "utf8");

test("control plane exposes an isolated trivia-theme region asset zone", () => {
  assert.match(source, /"trivia-theme-assets":\s*\{/);
  assert.match(source, /zone:\s*"trivia-theme"/);
  assert.match(source, /parts\[5\] === "trivia-theme-assets"/);
  assert.match(source, /buildOverlayAssetsResponse\(env, request, tenant, region, "trivia-theme"\)/);
});

test("theme uploads require an explicit allowlisted portal origin", () => {
  assert.match(source, /function isTrustedPortalWriteOrigin\(request, env\)/);
  assert.match(source, /if \(!origin \|\| origin === "null"\) return false/);
  assert.match(source, /parts\[6\] === "upload"[\s\S]*?isTrustedPortalWriteOrigin\(request, env\)/);
});

test("theme uploads accept only PNG or WebP and are capped at 25 MiB", () => {
  assert.match(source, /MAX_TRIVIA_THEME_UPLOAD_BYTES = 25 \* 1024 \* 1024/);
  assert.match(source, /const TRIVIA_THEME_UPLOAD_TYPES = new Set\(\[\s*"image\/png",\s*"image\/webp"\s*\]\)/);
  assert.match(source, /file\.size > MAX_TRIVIA_THEME_UPLOAD_BYTES/);
});

test("malformed theme upload forms fail closed with a client error", () => {
  assert.match(source, /formData = await request\.formData\(\);[\s\S]*?error: "invalid_form_data"/);
});

test("theme asset deletion exists and fails closed while a live logo or pair references it", () => {
  assert.match(source, /parts\[5\] === "trivia-theme-assets"[\s\S]*?request\.method === "DELETE"/);
  assert.match(source, /isTrustedPortalWriteOrigin\(request, env\)/);
  assert.match(source, /error: "asset_in_use"/);
  assert.match(source, /SCREENS_BUCKET\.delete\(asset\.r2_key\)/);
  assert.match(source, /markRegionAssetDeleted\(env, asset, "portal-admin"\)/);
});

test("theme asset reference detection covers the logo and both pair roles", () => {
  const assetUrl = "/public-assets/acme/reg01/trivia-theme/festive.png";
  const references = listTriviaThemeAssetReferences({
    logoImage: assetUrl,
    triviaThemes: [
      { id: "festive", name: "Festive", questionImage: assetUrl, answerImage: "/answer.png" },
      { id: "reverse", name: "Reverse", questionImage: "/question.png", answerImage: assetUrl }
    ]
  }, assetUrl);
  assert.equal(references.logo, true);
  assert.deepEqual(references.themes, [
    { id: "festive", name: "Festive", roles: ["question"] },
    { id: "reverse", name: "Reverse", roles: ["answer"] }
  ]);
});
