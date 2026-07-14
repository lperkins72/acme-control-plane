import { TenantRegionDO } from "./tenant_region_do.mjs";
import { SettingsScopeDO } from "./settings_scope_do.mjs";

export { TenantRegionDO, SettingsScopeDO };

const SERVICE_NAME = "acme-control-plane";
const API_VERSION = "2026-07-10-tenant-v1";
const SCHEMA_VERSION = 1;
const MAX_SETTINGS_BODY_BYTES = 128 * 1024;
const MAX_HEARTBEAT_BODY_BYTES = 64 * 1024;
const MAX_PRIMARY_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_FOOTER_UPLOAD_BYTES = 12 * 1024 * 1024;
const VALID_ZONES = new Set(["primary", "secondary", "trivia", "footer"]);
const REGION_SCOPED_ZONES = new Set(["primary", "trivia", "footer"]);
const DEVICE_SCOPED_ZONES = new Set(["primary", "secondary"]);
const ALLOWED_OVERRIDE_MODES = new Set(["region-default", "device-override", "device-only"]);
const PRIMARY_UPLOAD_TYPES = new Map([
  ["image/jpeg", "image"],
  ["image/png", "image"],
  ["image/webp", "image"],
  ["video/mp4", "video"]
]);
const FOOTER_UPLOAD_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml"
]);
const TENANT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REGION_RE = /^reg(0[1-9]|[1-9]\d)$/;
const DEVICE_RE = /^nuc-\d{3}$/;
const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-BDN-Updated-By"
};

function parseAllowedOrigins(value) {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function normalizeOriginValue(value) {
  const candidate = String(value || "").trim().replace(/\/+$/, "");
  if (!candidate) return null;

  try {
    const parsed = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
    return {
      origin: parsed.origin.toLowerCase(),
      hostname: parsed.hostname.toLowerCase()
    };
  } catch {
    return null;
  }
}

function isOriginAllowed(request, env) {
  const allowedOrigins = parseAllowedOrigins(env.SETTINGS_AUTH_ORIGINS)
    .map(normalizeOriginValue)
    .filter(Boolean);
  if (!allowedOrigins.length) return true;

  const origin = request.headers.get("Origin");
  if (!origin || origin === "null") return true;

  const requestOrigin = normalizeOriginValue(origin);
  if (!requestOrigin) return false;

  return allowedOrigins.some((allowedOrigin) =>
    allowedOrigin.origin === requestOrigin.origin ||
    allowedOrigin.hostname === requestOrigin.hostname
  );
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: CORS_HEADERS
  });
}

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    webSocket: response.webSocket
  });
}

function assetResponse(body, contentType) {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": contentType || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function normalizeToken(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeTenant(value) {
  const tenant = normalizeToken(value);
  return TENANT_RE.test(tenant) ? tenant : "";
}

function normalizeRegion(value) {
  const region = normalizeToken(value);
  return REGION_RE.test(region) ? region : "";
}

function normalizeDeviceId(value) {
  const deviceId = normalizeToken(value);
  return DEVICE_RE.test(deviceId) ? deviceId : "";
}

function normalizeZone(value) {
  const zone = normalizeToken(value);
  return VALID_ZONES.has(zone) ? zone : "";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseScope(scope) {
  const raw = String(scope || "").trim();
  if (!raw) return null;

  const regionMatch = /^bdn:v1:tenant:([^:]+):region:(reg\d{2}):zone:(primary|trivia|footer)$/i.exec(raw);
  if (regionMatch) {
    const tenant = normalizeTenant(regionMatch[1]);
    const region = normalizeRegion(regionMatch[2]);
    const zone = normalizeZone(regionMatch[3]);
    if (!tenant || !region || !zone || !REGION_SCOPED_ZONES.has(zone)) return null;

    return {
      scope: `bdn:v1:tenant:${tenant}:region:${region}:zone:${zone}`,
      scope_type: "region",
      tenant,
      region,
      device_id: "",
      zone,
      mode: "region-default"
    };
  }

  const deviceMatch = /^bdn:v1:tenant:([^:]+):device:(reg\d{2}):(nuc-\d{3}):zone:(primary|secondary)$/i.exec(raw);
  if (deviceMatch) {
    const tenant = normalizeTenant(deviceMatch[1]);
    const region = normalizeRegion(deviceMatch[2]);
    const deviceId = normalizeDeviceId(deviceMatch[3]);
    const zone = normalizeZone(deviceMatch[4]);
    if (!tenant || !region || !deviceId || !zone || !DEVICE_SCOPED_ZONES.has(zone)) return null;

    return {
      scope: `bdn:v1:tenant:${tenant}:device:${region}:${deviceId}:zone:${zone}`,
      scope_type: "device",
      tenant,
      region,
      device_id: deviceId,
      zone,
      mode: zone === "primary" ? "device-override" : "device-only"
    };
  }

  return null;
}

function detectChangeKind(scopeMeta) {
  if (!scopeMeta) return "unknown";
  if (scopeMeta.scope_type === "region") return "region-default-update";
  if (scopeMeta.mode === "device-only") return "device-only-update";
  return "device-override-update";
}

function normalizeUpdatedBy(value, fallback) {
  const candidate = String(value || "").trim();
  if (!candidate) return fallback;
  return candidate.slice(0, 80);
}

function sanitizeString(value, maxLength = 256) {
  return String(value || "").trim().slice(0, maxLength);
}

function sanitizeFileSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

function sanitizePositiveNumber(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function extname(value) {
  const candidate = String(value || "");
  const dotIndex = candidate.lastIndexOf(".");
  if (dotIndex <= 0) return "";
  return candidate.slice(dotIndex).toLowerCase();
}

function basenameWithoutExtension(value) {
  const candidate = String(value || "");
  const dotIndex = candidate.lastIndexOf(".");
  if (dotIndex <= 0) return candidate;
  return candidate.slice(0, dotIndex);
}

function guessPrimaryTypeFromSrc(src) {
  return /\.mp4(?:$|\?)/i.test(String(src || "")) ? "video" : "image";
}

function defaultRegionPagesProjectUrl(tenant, region) {
  return `https://${tenant}-${region}-signage.pages.dev`;
}

function buildPrimaryScope(tenant, region) {
  return `bdn:v1:tenant:${tenant}:region:${region}:zone:primary`;
}

function buildPrimaryDeviceScope(tenant, region, deviceId) {
  return `bdn:v1:tenant:${tenant}:device:${region}:${deviceId}:zone:primary`;
}

function buildZoneAssetPublicUrl(request, tenant, region, zone, assetName) {
  const base = new URL(request.url);
  base.pathname = zone === "primary"
    ? `/public-assets/${tenant}/${region}/${assetName}`
    : `/public-assets/${tenant}/${region}/${zone}/${assetName}`;
  base.search = "";
  return base.toString();
}

function buildZoneAssetR2Key(tenant, region, zone, assetName) {
  return `tenants/${tenant}/regions/${region}/${zone}/${assetName}`;
}

function buildPrimaryAssetPublicUrl(request, tenant, region, assetName) {
  return buildZoneAssetPublicUrl(request, tenant, region, "primary", assetName);
}

function buildPrimaryAssetR2Key(tenant, region, assetName) {
  return buildZoneAssetR2Key(tenant, region, "primary", assetName);
}

function buildFooterAssetPublicUrl(request, tenant, region, assetName) {
  return buildZoneAssetPublicUrl(request, tenant, region, "footer", assetName);
}

function buildFooterAssetR2Key(tenant, region, assetName) {
  return buildZoneAssetR2Key(tenant, region, "footer", assetName);
}

async function readJsonBody(request, maxBytes) {
  let raw = "";
  try {
    raw = await request.text();
  } catch {
    return { ok: false, error: "invalid_body" };
  }

  const rawBytes = new TextEncoder().encode(raw).length;
  if (rawBytes > maxBytes) {
    return { ok: false, error: "payload_too_large" };
  }

  if (!raw.trim()) {
    return { ok: true, value: {} };
  }

  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}

function validateScopeSummary(summary, tenant, region, deviceId) {
  if (summary === undefined) {
    return { ok: true, value: {} };
  }

  if (!isPlainObject(summary)) {
    return { ok: false, error: "invalid_scope_summary" };
  }

  const normalized = {};
  for (const [zoneKey, scopeValue] of Object.entries(summary)) {
    const zone = normalizeZone(zoneKey);
    if (!zone) {
      return { ok: false, error: "invalid_scope_summary_zone" };
    }
    if (typeof scopeValue !== "string" || scopeValue.length > 240) {
      return { ok: false, error: "invalid_scope_summary_value" };
    }

    const scopeMeta = parseScope(scopeValue);
    if (!scopeMeta || scopeMeta.zone !== zone) {
      return { ok: false, error: "invalid_scope_summary_scope" };
    }
    if (scopeMeta.tenant !== tenant || scopeMeta.region !== region) {
      return { ok: false, error: "scope_summary_tenant_region_mismatch" };
    }
    if (scopeMeta.scope_type === "device" && scopeMeta.device_id !== deviceId) {
      return { ok: false, error: "scope_summary_device_mismatch" };
    }

    normalized[zone] = scopeMeta.scope;
  }

  return { ok: true, value: normalized };
}

function validateOverrideSummary(summary) {
  if (summary === undefined) {
    return { ok: true, value: {} };
  }

  if (!isPlainObject(summary)) {
    return { ok: false, error: "invalid_override_summary" };
  }

  const normalized = {};
  for (const [zoneKey, zoneSummary] of Object.entries(summary)) {
    const zone = normalizeZone(zoneKey);
    if (!zone) {
      return { ok: false, error: "invalid_override_summary_zone" };
    }
    if (!isPlainObject(zoneSummary)) {
      return { ok: false, error: "invalid_override_summary_value" };
    }

    const mode = sanitizeString(zoneSummary.mode, 40);
    if (!ALLOWED_OVERRIDE_MODES.has(mode)) {
      return { ok: false, error: "invalid_override_summary_mode" };
    }

    normalized[zone] = {
      mode,
      hasOverride: Boolean(zoneSummary.hasOverride)
    };
  }

  return { ok: true, value: normalized };
}

function validateHeartbeatPolicy(policy) {
  if (policy === undefined) {
    return { ok: true, value: null };
  }

  if (!isPlainObject(policy)) {
    return { ok: false, error: "invalid_heartbeat_policy" };
  }

  const dayStartTime = sanitizeString(policy.dayStartTime || "", 5);
  const dayEndTime = sanitizeString(policy.dayEndTime || "", 5);
  const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (!timePattern.test(dayStartTime) || !timePattern.test(dayEndTime)) {
    return { ok: false, error: "invalid_heartbeat_policy_time" };
  }

  const activeIntervalSeconds = Number(policy.activeIntervalSeconds);
  const idleIntervalSeconds = Number(policy.idleIntervalSeconds);
  const legacyOfflineThresholdMinutes = Number(policy.offlineThresholdMinutes);
  const dayOfflineThresholdMinutes = policy.dayOfflineThresholdMinutes === undefined
    ? legacyOfflineThresholdMinutes
    : Number(policy.dayOfflineThresholdMinutes);
  const nightOfflineThresholdMinutes = policy.nightOfflineThresholdMinutes === undefined
    ? legacyOfflineThresholdMinutes
    : Number(policy.nightOfflineThresholdMinutes);
  if (!Number.isFinite(activeIntervalSeconds) || activeIntervalSeconds < 60 || activeIntervalSeconds > 86400) {
    return { ok: false, error: "invalid_heartbeat_policy_active_interval" };
  }
  if (!Number.isFinite(idleIntervalSeconds) || idleIntervalSeconds < 60 || idleIntervalSeconds > 86400) {
    return { ok: false, error: "invalid_heartbeat_policy_idle_interval" };
  }
  if (!Number.isFinite(dayOfflineThresholdMinutes) || dayOfflineThresholdMinutes < 5 || dayOfflineThresholdMinutes > 1440) {
    return { ok: false, error: "invalid_heartbeat_policy_day_offline_threshold" };
  }
  if (!Number.isFinite(nightOfflineThresholdMinutes) || nightOfflineThresholdMinutes < 5 || nightOfflineThresholdMinutes > 1440) {
    return { ok: false, error: "invalid_heartbeat_policy_night_offline_threshold" };
  }

  const currentMode = sanitizeString(policy.currentMode || "", 16);
  if (currentMode && currentMode !== "active" && currentMode !== "idle") {
    return { ok: false, error: "invalid_heartbeat_policy_mode" };
  }

  const currentIntervalSeconds = policy.currentIntervalSeconds === undefined
    ? null
    : Number(policy.currentIntervalSeconds);
  if (currentIntervalSeconds !== null && (!Number.isFinite(currentIntervalSeconds) || currentIntervalSeconds < 60 || currentIntervalSeconds > 86400)) {
    return { ok: false, error: "invalid_heartbeat_policy_current_interval" };
  }
  const currentOfflineThresholdMinutes = policy.currentOfflineThresholdMinutes === undefined
    ? null
    : Number(policy.currentOfflineThresholdMinutes);
  if (currentOfflineThresholdMinutes !== null && (!Number.isFinite(currentOfflineThresholdMinutes) || currentOfflineThresholdMinutes < 5 || currentOfflineThresholdMinutes > 1440)) {
    return { ok: false, error: "invalid_heartbeat_policy_current_offline_threshold" };
  }

  return {
    ok: true,
    value: {
      dayStartTime,
      dayEndTime,
      activeIntervalSeconds,
      idleIntervalSeconds,
      dayOfflineThresholdMinutes,
      nightOfflineThresholdMinutes,
      timezone: sanitizeString(policy.timezone || "America/Chicago", 64) || "America/Chicago",
      currentMode: currentMode || null,
      currentIntervalSeconds,
      currentOfflineThresholdMinutes
    }
  };
}

async function readCurrentScopeState(env, scope) {
  const row = await env.DB.prepare(`
    SELECT state_json, updated_at, updated_by, revision
    FROM settings_current
    WHERE scope = ?
  `).bind(scope).first();

  if (!row) {
    return {
      state: null,
      meta: null,
      revision: 0
    };
  }

  let state = null;
  try {
    state = row.state_json ? JSON.parse(row.state_json) : null;
  } catch {
    state = null;
  }

  return {
    state,
    meta: {
      updatedAt: row.updated_at || null,
      updatedBy: row.updated_by || null,
      revision: Number(row.revision || 0)
    },
    revision: Number(row.revision || 0)
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { cf: { cacheTtl: 0, cacheEverything: false }, headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`fetch_failed:${response.status}`);
  }
  return response.json();
}

function normalizePrimaryManifestPayload(payload) {
  const manifest = isPlainObject(payload) ? payload : {};
  const defaultDurationSeconds = sanitizePositiveNumber(manifest.defaultDurationSeconds, 5, 1, 300);
  return {
    defaultDurationSeconds,
    items: Array.isArray(manifest.items)
      ? manifest.items
        .filter((item) => isPlainObject(item) && sanitizeString(item.src, 500))
        .map((item) => ({
          src: sanitizeString(item.src, 500),
          type: sanitizeString(item.type || guessPrimaryTypeFromSrc(item.src), 20).toLowerCase() === "video" ? "video" : "image",
          durationSeconds: Number.isFinite(Number(item.durationSeconds)) ? Number(item.durationSeconds) : defaultDurationSeconds,
          source: "manifest"
        }))
      : []
  };
}

function normalizeFooterManifestPayload(payload) {
  const manifest = isPlainObject(payload) ? payload : {};
  return {
    assets: Array.isArray(manifest.assets)
      ? manifest.assets
        .filter((item) => isPlainObject(item) && sanitizeString(item.path, 500))
        .map((item) => ({
          label: sanitizeString(item.label || item.path.split("/").pop() || item.path, 240),
          path: sanitizeString(item.path, 500),
          type: "image",
          source: "manifest"
        }))
      : []
  };
}

function buildDefaultPrimaryPlaylists(manifest) {
  return {
    Default: manifest.items.map((item) => ({
      src: item.src,
      type: item.type,
      durationSeconds: sanitizePositiveNumber(item.durationSeconds, manifest.defaultDurationSeconds, 1, 300)
    }))
  };
}

function sortPrimaryAssetLibrary(items) {
  return [...items].sort((left, right) => {
    const leftName = sanitizeString(left.filename_original || left.filename_display || left.src || left.public_url || "", 240).toLowerCase();
    const rightName = sanitizeString(right.filename_original || right.filename_display || right.src || right.public_url || "", 240).toLowerCase();
    if (leftName !== rightName) {
      return leftName.localeCompare(rightName);
    }

    const leftSrc = sanitizeString(left.public_url || left.src || "", 500).toLowerCase();
    const rightSrc = sanitizeString(right.public_url || right.src || "", 500).toLowerCase();
    return leftSrc.localeCompare(rightSrc);
  });
}

function sortFooterAssetLibrary(items) {
  return [...items].sort((left, right) => {
    const leftName = sanitizeString(left.label || left.filename_original || left.filename_display || left.path || left.public_url || "", 240).toLowerCase();
    const rightName = sanitizeString(right.label || right.filename_original || right.filename_display || right.path || right.public_url || "", 240).toLowerCase();
    if (leftName !== rightName) {
      return leftName.localeCompare(rightName);
    }

    const leftPath = sanitizeString(left.path || left.public_url || "", 500).toLowerCase();
    const rightPath = sanitizeString(right.path || right.public_url || "", 500).toLowerCase();
    return leftPath.localeCompare(rightPath);
  });
}

function buildDefaultPrimaryPlaylistFromLibrary(assetLibrary, defaultDurationSeconds) {
  return assetLibrary.map((item) => ({
    src: sanitizeString(item.public_url || item.src || "", 500),
    type: sanitizeString(item.type || guessPrimaryTypeFromSrc(item.public_url || item.src || ""), 20).toLowerCase() === "video" ? "video" : "image",
    durationSeconds: sanitizePositiveNumber(item.durationSeconds, defaultDurationSeconds, 1, 300)
  })).filter((item) => item.src);
}

function normalizePrimaryPlaylists(playlists, defaultDurationSeconds) {
  if (!isPlainObject(playlists)) {
    return {};
  }

  const normalized = {};
  for (const [name, items] of Object.entries(playlists)) {
    const safeName = sanitizeString(name, 80);
    if (!safeName || !Array.isArray(items)) {
      continue;
    }

    normalized[safeName] = items
      .filter((item) => isPlainObject(item) && sanitizeString(item.src, 500))
      .map((item) => ({
        src: sanitizeString(item.src, 500),
        type: sanitizeString(item.type || guessPrimaryTypeFromSrc(item.src), 20).toLowerCase() === "video" ? "video" : "image",
        durationSeconds: sanitizePositiveNumber(item.durationSeconds, defaultDurationSeconds, 1, 300)
      }));
  }

  return normalized;
}

function normalizePrimaryState(payload, manifest) {
  if (!isPlainObject(payload)) {
    return { ok: false, error: "invalid_body" };
  }

  const playlists = normalizePrimaryPlaylists(payload.playlists, manifest.defaultDurationSeconds);
  if (!Object.keys(playlists).length) {
    return { ok: false, error: "playlists_required" };
  }

  const activePlaylistName = sanitizeString(payload.activePlaylistName, 80);
  const resolvedActivePlaylistName = playlists[activePlaylistName]
    ? activePlaylistName
    : Object.keys(playlists)[0];

  return {
    ok: true,
    value: {
      playlists,
      activePlaylistName: resolvedActivePlaylistName,
      dissolveEnabled: Boolean(payload.dissolveEnabled),
      dissolveDuration: sanitizePositiveNumber(payload.dissolveDuration, 0.8, 0.2, 10)
    }
  };
}

async function listRegionAssets(env, tenant, region, zone) {
  if (!env.DB) return [];
  const result = await env.DB.prepare(`
    SELECT asset_id, tenant, region, zone, r2_key, public_url, filename_original, filename_display, content_type, size_bytes, status, created_by, created_at, updated_at
    FROM region_assets
    WHERE tenant = ? AND region = ? AND zone = ? AND status = 'active'
    ORDER BY created_at DESC
  `).bind(tenant, region, zone).all();

  return (result.results || []).map((row) => ({
    asset_id: Number(row.asset_id),
    tenant: sanitizeString(row.tenant, 64),
    region: sanitizeString(row.region, 16),
    zone: sanitizeString(row.zone, 20),
    r2_key: sanitizeString(row.r2_key, 500),
    public_url: sanitizeString(row.public_url, 500),
    filename_original: sanitizeString(row.filename_original, 240),
    filename_display: sanitizeString(row.filename_display, 240),
    content_type: sanitizeString(row.content_type, 120),
    size_bytes: Number(row.size_bytes || 0),
    status: sanitizeString(row.status, 20),
    created_by: sanitizeString(row.created_by || "", 120),
    created_at: sanitizeString(row.created_at, 40),
    updated_at: sanitizeString(row.updated_at, 40),
    type: sanitizeString(row.content_type, 120).toLowerCase().startsWith("video/")
      ? "video"
      : "image"
  }));
}

async function readActiveRegionAssetById(env, tenant, region, zone, assetId) {
  if (!env.DB) return null;
  const numericAssetId = Number(assetId);
  if (!Number.isFinite(numericAssetId) || numericAssetId <= 0) {
    return null;
  }

  const result = await env.DB.prepare(`
    SELECT asset_id, tenant, region, zone, r2_key, public_url, filename_original, filename_display, content_type, size_bytes, status, created_by, created_at, updated_at
    FROM region_assets
    WHERE asset_id = ? AND tenant = ? AND region = ? AND zone = ? AND status = 'active'
    LIMIT 1
  `).bind(numericAssetId, tenant, region, zone).first();

  if (!result) {
    return null;
  }

  return {
    asset_id: Number(result.asset_id),
    tenant: sanitizeString(result.tenant, 64),
    region: sanitizeString(result.region, 16),
    zone: sanitizeString(result.zone, 20),
    r2_key: sanitizeString(result.r2_key, 500),
    public_url: sanitizeString(result.public_url, 500),
    filename_original: sanitizeString(result.filename_original, 240),
    filename_display: sanitizeString(result.filename_display, 240),
    content_type: sanitizeString(result.content_type, 120),
    size_bytes: Number(result.size_bytes || 0),
    status: sanitizeString(result.status, 20),
    created_by: sanitizeString(result.created_by || "", 120),
    created_at: sanitizeString(result.created_at, 40),
    updated_at: sanitizeString(result.updated_at, 40)
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function listPlaylistsReferencingSrc(playlists, src) {
  if (!isPlainObject(playlists) || !src) {
    return [];
  }

  const matches = [];
  for (const [name, items] of Object.entries(playlists)) {
    if (!Array.isArray(items)) {
      continue;
    }
    if (items.some((item) => sanitizeString(item?.src, 500) === src)) {
      matches.push(name);
    }
  }
  return matches;
}

function removeSrcFromPlaylists(playlists, src) {
  const nextPlaylists = isPlainObject(playlists) ? cloneJson(playlists) : {};
  const cleanedPlaylists = [];

  for (const [name, items] of Object.entries(nextPlaylists)) {
    if (!Array.isArray(items)) {
      continue;
    }
    const filtered = items.filter((item) => sanitizeString(item?.src, 500) !== src);
    if (filtered.length !== items.length) {
      cleanedPlaylists.push(name);
      nextPlaylists[name] = filtered;
    }
  }

  return {
    playlists: nextPlaylists,
    cleaned_playlists: cleanedPlaylists
  };
}

function listFooterOverlaysReferencingPath(state, path) {
  const overlays = Array.isArray(state?.overlays) ? state.overlays : [];
  const matches = [];
  overlays.forEach((overlay, index) => {
    if (sanitizeString(overlay?.imagePath, 500) === path) {
      matches.push(index + 1);
    }
  });
  return matches;
}

function removeFooterPathReferences(state, path) {
  const nextState = isPlainObject(state) ? cloneJson(state) : {};
  const overlays = Array.isArray(nextState.overlays) ? nextState.overlays : [];
  const cleanedOverlays = [];

  overlays.forEach((overlay, index) => {
    if (sanitizeString(overlay?.imagePath, 500) !== path) {
      return;
    }
    cleanedOverlays.push(index + 1);
    overlay.imagePath = "";
    if (String(overlay.type || "") === "image") {
      overlay.enabled = false;
      overlay.type = "none";
    }
  });

  return {
    state: nextState,
    cleaned_overlays: cleanedOverlays
  };
}

async function markRegionAssetDeleted(env, asset, deletedBy) {
  if (!env.DB || !asset?.asset_id) {
    return;
  }
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE region_assets
    SET status = 'deleted', updated_at = ?, created_by = COALESCE(created_by, ?)
    WHERE asset_id = ?
  `).bind(updatedAt, deletedBy, asset.asset_id).run();
}

async function writeScopeStateFromMeta(env, scopeMeta, stateValue, updatedBy, now, request) {
  const current = await readCurrentScopeState(env, scopeMeta.scope);
  const nextRevision = current.revision + 1;
  const updatedAt = new Date().toISOString();
  const changeKind = detectChangeKind(scopeMeta);
  const changeScope = scopeMeta.scope_type === "region" ? "region" : "device";
  const sourceOrigin = sanitizeString(request.headers.get("Origin") || "", 200);
  const stateJson = JSON.stringify(stateValue || {});

  await env.DB.prepare(`
    INSERT INTO settings_current
    (scope, scope_type, tenant, region, device_id, zone, mode, revision, updated_at, updated_by, state_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET
      scope_type=excluded.scope_type,
      tenant=excluded.tenant,
      region=excluded.region,
      device_id=excluded.device_id,
      zone=excluded.zone,
      mode=excluded.mode,
      revision=excluded.revision,
      updated_at=excluded.updated_at,
      updated_by=excluded.updated_by,
      state_json=excluded.state_json
  `).bind(
    scopeMeta.scope,
    scopeMeta.scope_type,
    scopeMeta.tenant,
    scopeMeta.region,
    scopeMeta.device_id,
    scopeMeta.zone,
    scopeMeta.mode,
    nextRevision,
    updatedAt,
    updatedBy,
    stateJson
  ).run();

  try {
    await env.DB.prepare(`
      INSERT INTO settings_events
      (ts, scope, scope_type, tenant, region, device_id, zone, mode, revision, updated_at, updated_by, change_kind, change_scope, source_origin, state_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      now,
      scopeMeta.scope,
      scopeMeta.scope_type,
      scopeMeta.tenant,
      scopeMeta.region,
      scopeMeta.device_id,
      scopeMeta.zone,
      scopeMeta.mode,
      nextRevision,
      updatedAt,
      updatedBy,
      changeKind,
      changeScope,
      sourceOrigin,
      stateJson
    ).run();
  } catch {
    // Audit logging is best-effort.
  }

  const id = env.SETTINGS_SCOPE_DO.idFromName(scopeMeta.scope);
  const stub = env.SETTINGS_SCOPE_DO.get(id);
  const currentResponse = {
    ok: true,
    state: stateValue || {},
    meta: {
      updatedAt,
      updatedBy,
      revision: nextRevision,
      changeKind,
      changeScope,
      sourceOrigin
    },
    revision: nextRevision
  };

  try {
    await stub.fetch(`https://scope/${encodeURIComponent(scopeMeta.scope)}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentResponse)
    });
  } catch {
    // Websocket fan-out is best-effort.
  }

  return currentResponse;
}

async function buildPrimaryConfigResponse(env, request, tenant, region) {
  const pagesProjectUrl = defaultRegionPagesProjectUrl(tenant, region);
  let manifest = { defaultDurationSeconds: 5, items: [] };
  try {
    manifest = normalizePrimaryManifestPayload(await fetchJson(`${pagesProjectUrl}/assets/primary/manifest.json`));
  } catch {
    manifest = { defaultDurationSeconds: 5, items: [] };
  }

  const scope = buildPrimaryScope(tenant, region);
  const current = await readCurrentScopeState(env, scope);
  const syncState = isPlainObject(current.state) ? current.state : null;
  const uploadedAssets = await listRegionAssets(env, tenant, region, "primary");
  const manifestAssets = manifest.items.map((item) => ({
    asset_id: null,
    tenant,
    region,
    zone: "primary",
    src: item.src,
    public_url: item.src,
    filename_display: sanitizeString(item.src.split("/").pop() || item.src, 240),
    filename_original: sanitizeString(item.src.split("/").pop() || item.src, 240),
    content_type: item.type === "video" ? "video/mp4" : "",
    size_bytes: 0,
    status: "manifest",
    created_by: "manifest",
    created_at: "",
    updated_at: "",
    type: item.type,
    durationSeconds: sanitizePositiveNumber(item.durationSeconds, manifest.defaultDurationSeconds, 1, 300),
    source: "manifest"
  }));
  const assetLibrary = sortPrimaryAssetLibrary([...uploadedAssets, ...manifestAssets]);
  const defaultPlaylist = buildDefaultPrimaryPlaylistFromLibrary(assetLibrary, manifest.defaultDurationSeconds);
  const effectivePlaylists = syncState?.playlists && typeof syncState.playlists === "object"
    ? normalizePrimaryPlaylists(syncState.playlists, manifest.defaultDurationSeconds)
    : buildDefaultPrimaryPlaylists(manifest);
  effectivePlaylists.Default = defaultPlaylist;
  const activePlaylistName = effectivePlaylists[sanitizeString(syncState?.activePlaylistName, 80)]
    ? sanitizeString(syncState.activePlaylistName, 80)
    : (effectivePlaylists.Default ? "Default" : Object.keys(effectivePlaylists)[0] || "Default");

  return {
    ok: true,
    tenant,
    region,
    scope,
    source: {
      pages_project_url: pagesProjectUrl,
      manifest_url: `${pagesProjectUrl}/assets/primary/manifest.json`,
      sync_url: new URL(request.url).origin
    },
    manifest,
    sync_state: syncState,
    sync_meta: current.meta,
    effective_playlist_name: activePlaylistName,
    effective_playlists: effectivePlaylists,
    effective_playlist_items: Array.isArray(effectivePlaylists[activePlaylistName]) ? effectivePlaylists[activePlaylistName] : [],
    asset_library: assetLibrary
  };
}

async function buildFooterAssetsResponse(env, request, tenant, region) {
  const pagesProjectUrl = defaultRegionPagesProjectUrl(tenant, region);
  let manifest = { assets: [] };
  try {
    manifest = normalizeFooterManifestPayload(await fetchJson(`${pagesProjectUrl}/assets/footer/manifest.json`));
  } catch {
    manifest = { assets: [] };
  }

  const uploadedAssets = await listRegionAssets(env, tenant, region, "footer");
  const manifestAssets = manifest.assets.map((item) => ({
    asset_id: null,
    tenant,
    region,
    zone: "footer",
    path: item.path,
    src: item.path,
    public_url: item.path,
    label: item.label,
    filename_display: sanitizeString(item.path.split("/").pop() || item.path, 240),
    filename_original: sanitizeString(item.path.split("/").pop() || item.path, 240),
    content_type: "",
    size_bytes: 0,
    status: "manifest",
    created_by: "manifest",
    created_at: "",
    updated_at: "",
    type: "image",
    source: "manifest"
  }));

  const assetLibrary = sortFooterAssetLibrary([
    ...uploadedAssets.map((item) => ({
      ...item,
      path: item.public_url || item.r2_key,
      src: item.public_url || item.r2_key,
      label: sanitizeString(item.filename_original || item.filename_display || item.public_url, 240)
    })),
    ...manifestAssets
  ]);

  return {
    ok: true,
    tenant,
    region,
    source: {
      pages_project_url: pagesProjectUrl,
      manifest_url: `${pagesProjectUrl}/assets/footer/manifest.json`,
      sync_url: new URL(request.url).origin
    },
    manifest,
    asset_library: assetLibrary
  };
}

async function writePrimaryScopeState(env, tenant, region, stateValue, updatedBy, now, request) {
  const scopeMeta = parseScope(buildPrimaryScope(tenant, region));
  return writeScopeStateFromMeta(env, scopeMeta, stateValue, updatedBy, now, request);
}

function getTenantRegionStub(env, tenant, region) {
  const id = env.TENANT_REGION_DO.idFromName(`tenant:${tenant}:region:${region}`);
  return env.TENANT_REGION_DO.get(id);
}

async function fetchTenantRegionItems(env, tenant, region, search = "") {
  const stub = getTenantRegionStub(env, tenant, region);
  const resp = await stub.fetch(`https://do/${tenant}/${region}/list${search}`);
  const payload = await resp.json();
  const items = Array.isArray(payload?.items) ? payload.items : [];

  if (env.DB && items.length) {
    const primaryOverrideRows = await env.DB.prepare(`
      SELECT device_id
      FROM settings_current
      WHERE tenant = ? AND region = ? AND zone = 'primary' AND scope_type = 'device'
    `).bind(tenant, region).all();

    const pinnedDeviceIds = new Set(
      Array.isArray(primaryOverrideRows?.results)
        ? primaryOverrideRows.results.map((row) => normalizeDeviceId(row?.device_id || "")).filter(Boolean)
        : []
    );

    payload.items = items.map((item) => {
      const deviceId = normalizeDeviceId(item?.device_id || "");
      if (!deviceId || !pinnedDeviceIds.has(deviceId)) {
        return item;
      }

      const nextOverrideSummary = isPlainObject(item?.override_summary)
        ? cloneJson(item.override_summary)
        : {};
      nextOverrideSummary.primary = {
        mode: "device-override",
        hasOverride: true
      };

      const nextScopeSummary = isPlainObject(item?.scope_summary)
        ? cloneJson(item.scope_summary)
        : {};
      nextScopeSummary.primary = buildPrimaryDeviceScope(tenant, region, deviceId);

      return {
        ...item,
        override_summary: nextOverrideSummary,
        scope_summary: nextScopeSummary
      };
    });
  }

  return payload;
}

function buildOverrideSummary(tenant, region, items, offlineMs) {
  const zones = ["primary", "secondary", "trivia", "footer"];
  const summary = {};

  for (const zone of zones) {
    summary[zone] = {
      activeRegionDefaults: 0,
      activeDeviceOverrides: 0,
      activeDeviceOnly: 0,
      staleRegionDefaults: 0,
      staleDeviceOverrides: 0,
      staleDeviceOnly: 0,
      unknown: 0
    };
  }

  let activeDevices = 0;
  let staleDevices = 0;

  for (const item of items) {
    const isActive = item.status === "online";
    if (isActive) {
      activeDevices += 1;
    } else {
      staleDevices += 1;
    }

    const deviceSummary = item.override_summary && typeof item.override_summary === "object"
      ? item.override_summary
      : {};

    for (const zone of zones) {
      const zoneSummary = deviceSummary[zone] && typeof deviceSummary[zone] === "object"
        ? deviceSummary[zone]
        : null;

      if (!zoneSummary) {
        summary[zone].unknown += 1;
        continue;
      }

      const mode = String(zoneSummary.mode || "");
      const bucketPrefix = isActive ? "active" : "stale";

      if (mode === "region-default") {
        summary[zone][`${bucketPrefix}RegionDefaults`] += 1;
      } else if (mode === "device-override") {
        summary[zone][`${bucketPrefix}DeviceOverrides`] += 1;
      } else if (mode === "device-only") {
        summary[zone][`${bucketPrefix}DeviceOnly`] += 1;
      } else {
        summary[zone].unknown += 1;
      }
    }
  }

  return {
    tenant,
    region,
    offline_ms: offlineMs,
    active_devices: activeDevices,
    stale_devices: staleDevices,
    zones: summary
  };
}

async function readHealth(env) {
  const allowedOrigins = parseAllowedOrigins(env.SETTINGS_AUTH_ORIGINS);
  const health = {
    ok: true,
    service: SERVICE_NAME,
    version: API_VERSION,
    schema_version: SCHEMA_VERSION,
    deployment_model: "manual-wrangler",
    tenant_model: "tenant-region-device",
    allowed_origins: allowedOrigins,
    durable_objects: ["TENANT_REGION_DO", "SETTINGS_SCOPE_DO"],
    d1: {
      available: false
    }
  };

  if (!env.DB) {
    health.ok = false;
    health.d1.error = "db_unavailable";
    return health;
  }

  try {
    const countRow = await env.DB.prepare(`
      SELECT
        COUNT(DISTINCT tenant) AS tenant_count,
        COUNT(DISTINCT region) AS region_count,
        COUNT(*) AS device_count
      FROM devices
    `).first();
    health.d1.available = true;
    health.d1.tenant_count = Number(countRow?.tenant_count || 0);
    health.d1.region_count = Number(countRow?.region_count || 0);
    health.d1.device_count = Number(countRow?.device_count || 0);
  } catch (error) {
    health.ok = false;
    health.d1.error = sanitizeString(error?.message || "db_query_failed", 200);
  }

  return health;
}

async function listTenants(env) {
  const query = await env.DB.prepare(`
    SELECT tenant, COUNT(DISTINCT region) AS region_count, COUNT(*) AS device_count
    FROM devices
    GROUP BY tenant
    ORDER BY tenant
  `).all();
  return (query.results || []).map((row) => ({
    tenant: row.tenant,
    region_count: Number(row.region_count || 0),
    device_count: Number(row.device_count || 0)
  }));
}

async function listRegionsForTenant(env, tenant, searchParams, now) {
  const query = await env.DB.prepare(`
    SELECT DISTINCT region
    FROM devices
    WHERE tenant = ?
    ORDER BY region
  `).bind(tenant).all();
  const regions = (query.results || []).map((row) => row.region).filter(Boolean);
  const offlineMs = Number(searchParams.get("offline_ms") || 0);
  const querySuffix = offlineMs > 0 ? `?offline_ms=${offlineMs}` : "";
  const result = [];

  for (const region of regions) {
    let data = { items: [] };
    try {
      data = await fetchTenantRegionItems(env, tenant, region, querySuffix);
    } catch {
      data = { items: [] };
    }

    const items = Array.isArray(data.items) ? data.items : [];
    let visible = 0;
    let hidden = 0;
    let offline = 0;

    for (const item of items) {
      if (item.status !== "online") {
        offline += 1;
        continue;
      }
      if (item.visibility === "hidden") {
        hidden += 1;
      } else {
        visible += 1;
      }
    }

    const online = visible + hidden;

    result.push({
      tenant,
      region,
      total: items.length,
      online,
      offline,
      visible,
      hidden,
      override_summary: buildOverrideSummary(tenant, region, items, offlineMs).zones
    });
  }

  return {
    tenant,
    regions: result,
    ts: now,
    offline_ms: offlineMs || undefined
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const now = Date.now();

    if (path === "/api/health" && request.method === "GET") {
      const health = await readHealth(env);
      return json({ ...health, ts: now }, health.ok ? 200 : 503);
    }

    if (path.startsWith("/public-assets/") && request.method === "GET") {
      const parts = path.split("/").filter(Boolean);
      const tenant = normalizeTenant(parts[1] || "");
      const region = normalizeRegion(parts[2] || "");
      const maybeZone = normalizeZone(parts[3] || "");
      const zone = maybeZone && REGION_SCOPED_ZONES.has(maybeZone) ? maybeZone : "primary";
      const assetName = sanitizeFileSegment(parts.slice(zone === "primary" && !maybeZone ? 3 : 4).join("/"));
      if (!tenant || !region || !assetName || !zone) {
        return json({ ok: false, error: "invalid_asset_path" }, 400);
      }
      if (!env.SCREENS_BUCKET) {
        return json({ ok: false, error: "asset_bucket_unavailable" }, 503);
      }

      const object = await env.SCREENS_BUCKET.get(buildZoneAssetR2Key(tenant, region, zone, assetName));
      if (!object) {
        return json({ ok: false, error: "asset_not_found" }, 404);
      }
      return assetResponse(object.body, object.httpMetadata?.contentType || "application/octet-stream");
    }

    if (path.startsWith("/api/tenants/")) {
      const parts = path.split("/").filter(Boolean);
      const tenant = normalizeTenant(parts[2] || "");
      const region = normalizeRegion(parts[4] || "");

      if (
        tenant &&
        region &&
        parts.length === 6 &&
        parts[3] === "regions" &&
        parts[5] === "footer-assets" &&
        request.method === "GET"
      ) {
        if (!isOriginAllowed(request, env)) {
          return json({ ok: false, error: "origin_not_allowed" }, 403);
        }
        if (!env.DB) {
          return json({ ok: false, error: "db_unavailable" }, 503);
        }
        return json(await buildFooterAssetsResponse(env, request, tenant, region));
      }

      if (
        tenant &&
        region &&
        parts.length === 7 &&
        parts[3] === "regions" &&
        parts[5] === "footer-assets" &&
        parts[6] === "upload" &&
        request.method === "POST"
      ) {
        if (!isOriginAllowed(request, env)) {
          return json({ ok: false, error: "origin_not_allowed" }, 403);
        }
        if (!env.DB) {
          return json({ ok: false, error: "db_unavailable" }, 503);
        }
        if (!env.SCREENS_BUCKET) {
          return json({ ok: false, error: "asset_bucket_unavailable" }, 503);
        }
        const contentLength = Number(request.headers.get("Content-Length") || 0);
        if (contentLength > MAX_FOOTER_UPLOAD_BYTES) {
          return json({ ok: false, error: "payload_too_large" }, 413);
        }

        const formData = await request.formData();
        const file = formData.get("file");
        if (!(file instanceof File)) {
          return json({ ok: false, error: "file_required" }, 400);
        }
        if (file.size <= 0 || file.size > MAX_FOOTER_UPLOAD_BYTES) {
          return json({ ok: false, error: "invalid_file_size" }, 400);
        }

        const contentType = sanitizeString(file.type || "", 120).toLowerCase();
        if (!FOOTER_UPLOAD_TYPES.has(contentType)) {
          return json({ ok: false, error: "unsupported_file_type" }, 400);
        }

        const baseName = sanitizeFileSegment(basenameWithoutExtension(file.name) || "footer-asset") || "footer-asset";
        const extension = extname(file.name) || ".png";
        const assetName = `${Date.now()}-${baseName}${extension}`;
        const r2Key = buildFooterAssetR2Key(tenant, region, assetName);
        const publicUrl = buildFooterAssetPublicUrl(request, tenant, region, assetName);
        const arrayBuffer = await file.arrayBuffer();

        await env.SCREENS_BUCKET.put(r2Key, arrayBuffer, {
          httpMetadata: {
            contentType
          }
        });

        const nowIso = new Date().toISOString();
        await env.DB.prepare(`
          INSERT INTO region_assets
          (tenant, region, zone, r2_key, public_url, filename_original, filename_display, content_type, size_bytes, status, created_by, created_at, updated_at)
          VALUES (?, ?, 'footer', ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        `).bind(
          tenant,
          region,
          r2Key,
          publicUrl,
          sanitizeString(file.name, 240),
          assetName,
          contentType,
          file.size,
          normalizeUpdatedBy(formData.get("updatedBy"), "portal-admin"),
          nowIso,
          nowIso
        ).run();

        return json({
          ok: true,
          asset: {
            tenant,
            region,
            zone: "footer",
            path: publicUrl,
            src: publicUrl,
            public_url: publicUrl,
            filename_original: sanitizeString(file.name, 240),
            filename_display: assetName,
            label: sanitizeString(file.name, 240),
            content_type: contentType,
            size_bytes: file.size,
            type: "image",
            status: "active",
            source: "upload"
          }
        });
      }

      if (
        tenant &&
        region &&
        parts.length === 7 &&
        parts[3] === "regions" &&
        parts[5] === "footer-assets" &&
        request.method === "DELETE"
      ) {
        if (!isOriginAllowed(request, env)) {
          return json({ ok: false, error: "origin_not_allowed" }, 403);
        }
        if (!env.DB) {
          return json({ ok: false, error: "db_unavailable" }, 503);
        }
        if (!env.SCREENS_BUCKET) {
          return json({ ok: false, error: "asset_bucket_unavailable" }, 503);
        }

        const asset = await readActiveRegionAssetById(env, tenant, region, "footer", parts[6]);
        if (!asset) {
          return json({ ok: false, error: "asset_not_found" }, 404);
        }

        const footerScopeMeta = parseScope(`bdn:v1:tenant:${tenant}:region:${region}:zone:footer`);
        const currentFooter = await readCurrentScopeState(env, footerScopeMeta.scope);
        const referencedOverlays = listFooterOverlaysReferencingPath(currentFooter.state, asset.public_url);
        const cleanupReferences = url.searchParams.get("cleanup") === "references";

        if (referencedOverlays.length && !cleanupReferences) {
          return json({
            ok: false,
            error: "asset_in_use",
            references: {
              overlays: referencedOverlays
            }
          }, 409);
        }

        if (referencedOverlays.length && cleanupReferences) {
          const cleaned = removeFooterPathReferences(currentFooter.state, asset.public_url);
          await writeScopeStateFromMeta(
            env,
            footerScopeMeta,
            cleaned.state,
            "portal-admin",
            now,
            request
          );
        }

        await env.SCREENS_BUCKET.delete(asset.r2_key);
        await markRegionAssetDeleted(env, asset, "portal-admin");

        return json({
          ok: true,
          deleted_asset_id: asset.asset_id,
          zone: "footer",
          cleanup_applied: cleanupReferences && referencedOverlays.length > 0,
          references_removed: {
            overlays: cleanupReferences ? referencedOverlays : []
          }
        });
      }

      if (
        tenant &&
        region &&
        parts.length === 6 &&
        parts[3] === "regions" &&
        parts[5] === "primary-config" &&
        request.method === "GET"
      ) {
        if (!isOriginAllowed(request, env)) {
          return json({ ok: false, error: "origin_not_allowed" }, 403);
        }
        if (!env.DB) {
          return json({ ok: false, error: "db_unavailable" }, 503);
        }
        return json(await buildPrimaryConfigResponse(env, request, tenant, region));
      }

      if (
        tenant &&
        region &&
        parts.length === 6 &&
        parts[3] === "regions" &&
        parts[5] === "primary-config" &&
        request.method === "POST"
      ) {
        if (!isOriginAllowed(request, env)) {
          return json({ ok: false, error: "origin_not_allowed" }, 403);
        }
        if (!env.DB) {
          return json({ ok: false, error: "db_unavailable" }, 503);
        }
        const body = await readJsonBody(request, MAX_SETTINGS_BODY_BYTES);
        if (!body.ok) return json({ ok: false, error: body.error }, 400);
        const primaryConfig = await buildPrimaryConfigResponse(env, request, tenant, region);
        const normalized = normalizePrimaryState(body.value, primaryConfig.manifest);
        if (!normalized.ok) {
          return json({ ok: false, error: normalized.error }, 400);
        }
        await writePrimaryScopeState(
          env,
          tenant,
          region,
          normalized.value,
          normalizeUpdatedBy(body.value.updatedBy || body.value.updated_by, "portal-admin"),
          now,
          request
        );
        return json(await buildPrimaryConfigResponse(env, request, tenant, region));
      }

      if (
        tenant &&
        region &&
        parts.length === 7 &&
        parts[3] === "regions" &&
        parts[5] === "primary-assets" &&
        parts[6] === "upload" &&
        request.method === "POST"
      ) {
        if (!isOriginAllowed(request, env)) {
          return json({ ok: false, error: "origin_not_allowed" }, 403);
        }
        if (!env.DB) {
          return json({ ok: false, error: "db_unavailable" }, 503);
        }
        if (!env.SCREENS_BUCKET) {
          return json({ ok: false, error: "asset_bucket_unavailable" }, 503);
        }
        const contentLength = Number(request.headers.get("Content-Length") || 0);
        if (contentLength > MAX_PRIMARY_UPLOAD_BYTES) {
          return json({ ok: false, error: "payload_too_large" }, 413);
        }

        const formData = await request.formData();
        const file = formData.get("file");
        if (!(file instanceof File)) {
          return json({ ok: false, error: "file_required" }, 400);
        }
        if (file.size <= 0 || file.size > MAX_PRIMARY_UPLOAD_BYTES) {
          return json({ ok: false, error: "invalid_file_size" }, 400);
        }

        const contentType = sanitizeString(file.type || "", 120).toLowerCase();
        const primaryType = PRIMARY_UPLOAD_TYPES.get(contentType);
        if (!primaryType) {
          return json({ ok: false, error: "unsupported_file_type" }, 400);
        }

        const baseName = sanitizeFileSegment(basenameWithoutExtension(file.name) || "primary-asset") || "primary-asset";
        const extension = extname(file.name) || (primaryType === "video" ? ".mp4" : ".jpg");
        const assetName = `${Date.now()}-${baseName}${extension}`;
        const r2Key = buildPrimaryAssetR2Key(tenant, region, assetName);
        const publicUrl = buildPrimaryAssetPublicUrl(request, tenant, region, assetName);
        const arrayBuffer = await file.arrayBuffer();

        await env.SCREENS_BUCKET.put(r2Key, arrayBuffer, {
          httpMetadata: {
            contentType
          }
        });

        const nowIso = new Date().toISOString();
        await env.DB.prepare(`
          INSERT INTO region_assets
          (tenant, region, zone, r2_key, public_url, filename_original, filename_display, content_type, size_bytes, status, created_by, created_at, updated_at)
          VALUES (?, ?, 'primary', ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        `).bind(
          tenant,
          region,
          r2Key,
          publicUrl,
          sanitizeString(file.name, 240),
          assetName,
          contentType,
          file.size,
          normalizeUpdatedBy(formData.get("updatedBy"), "portal-admin"),
          nowIso,
          nowIso
        ).run();

        return json({
          ok: true,
          asset: {
            tenant,
            region,
            zone: "primary",
            src: publicUrl,
            public_url: publicUrl,
            filename_original: sanitizeString(file.name, 240),
            filename_display: assetName,
            content_type: contentType,
            size_bytes: file.size,
            type: primaryType,
            source: "uploaded",
            created_at: nowIso
          }
        });
      }

      if (
        tenant &&
        region &&
        parts.length === 7 &&
        parts[3] === "regions" &&
        parts[5] === "primary-assets" &&
        request.method === "DELETE"
      ) {
        if (!isOriginAllowed(request, env)) {
          return json({ ok: false, error: "origin_not_allowed" }, 403);
        }
        if (!env.DB) {
          return json({ ok: false, error: "db_unavailable" }, 503);
        }
        if (!env.SCREENS_BUCKET) {
          return json({ ok: false, error: "asset_bucket_unavailable" }, 503);
        }

        const asset = await readActiveRegionAssetById(env, tenant, region, "primary", parts[6]);
        if (!asset) {
          return json({ ok: false, error: "asset_not_found" }, 404);
        }

        const primaryScopeMeta = parseScope(buildPrimaryScope(tenant, region));
        const currentPrimary = await readCurrentScopeState(env, primaryScopeMeta.scope);
        const currentPlaylists = isPlainObject(currentPrimary.state?.playlists) ? currentPrimary.state.playlists : {};
        const referencedPlaylists = listPlaylistsReferencingSrc(currentPlaylists, asset.public_url);
        const cleanupReferences = url.searchParams.get("cleanup") === "references";

        if (referencedPlaylists.length && !cleanupReferences) {
          return json({
            ok: false,
            error: "asset_in_use",
            references: {
              playlists: referencedPlaylists
            }
          }, 409);
        }

        if (referencedPlaylists.length && cleanupReferences) {
          const cleaned = removeSrcFromPlaylists(currentPlaylists, asset.public_url);
          const nextState = {
            ...(isPlainObject(currentPrimary.state) ? cloneJson(currentPrimary.state) : {}),
            playlists: cleaned.playlists
          };
          const activePlaylistName = sanitizeString(nextState.activePlaylistName, 80);
          if (activePlaylistName && !nextState.playlists[activePlaylistName]) {
            nextState.activePlaylistName = Object.keys(nextState.playlists)[0] || "Default";
          }

          await writeScopeStateFromMeta(
            env,
            primaryScopeMeta,
            nextState,
            "portal-admin",
            now,
            request
          );
        }

        await env.SCREENS_BUCKET.delete(asset.r2_key);
        await markRegionAssetDeleted(env, asset, "portal-admin");

        return json({
          ok: true,
          deleted_asset_id: asset.asset_id,
          zone: "primary",
          cleanup_applied: cleanupReferences && referencedPlaylists.length > 0,
          references_removed: {
            playlists: cleanupReferences ? referencedPlaylists : []
          }
        });
      }
    }

    if (path.startsWith("/settings/")) {
      if (!isOriginAllowed(request, env)) {
        return json({ ok: false, error: "origin_not_allowed" }, 403);
      }

      const scope = decodeURIComponent(path.slice("/settings/".length));
      const scopeMeta = parseScope(scope);
      if (!scopeMeta) return json({ ok: false, error: "invalid_scope" }, 400);
      if (!env.DB) return json({ ok: false, error: "db_unavailable" }, 503);

      if (request.method === "GET") {
        const current = await readCurrentScopeState(env, scopeMeta.scope);
        return json({ ok: true, ...current });
      }

      if (request.method === "DELETE") {
        const current = await readCurrentScopeState(env, scopeMeta.scope);
        const updatedAt = new Date().toISOString();
        const fallbackUpdater = scopeMeta.scope_type === "region" ? "region-admin" : "device-admin";
        const updatedBy = normalizeUpdatedBy(request.headers.get("X-BDN-Updated-By"), fallbackUpdater);
        const changeKind = `${detectChangeKind(scopeMeta)}-cleared`;
        const changeScope = scopeMeta.scope_type === "region" ? "region" : "device";
        const sourceOrigin = sanitizeString(request.headers.get("Origin") || "", 200);

        await env.DB.prepare(`DELETE FROM settings_current WHERE scope = ?`).bind(scopeMeta.scope).run();

        try {
          await env.DB.prepare(`
            INSERT INTO settings_events
            (ts, scope, scope_type, tenant, region, device_id, zone, mode, revision, updated_at, updated_by, change_kind, change_scope, source_origin, state_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            now,
            scopeMeta.scope,
            scopeMeta.scope_type,
            scopeMeta.tenant,
            scopeMeta.region,
            scopeMeta.device_id,
            scopeMeta.zone,
            scopeMeta.mode,
            0,
            updatedAt,
            updatedBy,
            changeKind,
            changeScope,
            sourceOrigin,
            "null"
          ).run();
        } catch {
          // Audit logging is best-effort during rollout.
        }

        const id = env.SETTINGS_SCOPE_DO.idFromName(scopeMeta.scope);
        const stub = env.SETTINGS_SCOPE_DO.get(id);
        const clearedResponse = {
          ok: true,
          state: null,
          meta: {
            updatedAt,
            updatedBy,
            revision: 0,
            changeKind,
            changeScope,
            sourceOrigin,
            deleted: true,
            previousRevision: current.revision || 0
          },
          revision: 0
        };

        try {
          await stub.fetch(`https://scope/${encodeURIComponent(scopeMeta.scope)}/notify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(clearedResponse)
          });
        } catch {
          // Websocket fan-out is best-effort.
        }

        return json(clearedResponse);
      }

      if (request.method === "POST") {
        const body = await readJsonBody(request, MAX_SETTINGS_BODY_BYTES);
        if (!body.ok) return json({ ok: false, error: body.error }, 400);
        if (!isPlainObject(body.value.state)) {
          return json({ ok: false, error: "state_required" }, 400);
        }

        const current = await readCurrentScopeState(env, scopeMeta.scope);
        const nextRevision = current.revision + 1;
        const updatedAt = new Date().toISOString();
        const fallbackUpdater = scopeMeta.scope_type === "region" ? "region-admin" : "device-client";
        const updatedBy = normalizeUpdatedBy(body.value.meta?.updatedBy, fallbackUpdater);
        const changeKind = detectChangeKind(scopeMeta);
        const changeScope = scopeMeta.scope_type === "region" ? "region" : "device";
        const sourceOrigin = sanitizeString(request.headers.get("Origin") || "", 200);
        const stateJson = JSON.stringify(body.value.state || {});

        await env.DB.prepare(`
          INSERT INTO settings_current
          (scope, scope_type, tenant, region, device_id, zone, mode, revision, updated_at, updated_by, state_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(scope) DO UPDATE SET
            scope_type=excluded.scope_type,
            tenant=excluded.tenant,
            region=excluded.region,
            device_id=excluded.device_id,
            zone=excluded.zone,
            mode=excluded.mode,
            revision=excluded.revision,
            updated_at=excluded.updated_at,
            updated_by=excluded.updated_by,
            state_json=excluded.state_json
        `).bind(
          scopeMeta.scope,
          scopeMeta.scope_type,
          scopeMeta.tenant,
          scopeMeta.region,
          scopeMeta.device_id,
          scopeMeta.zone,
          scopeMeta.mode,
          nextRevision,
          updatedAt,
          updatedBy,
          stateJson
        ).run();

        try {
          await env.DB.prepare(`
            INSERT INTO settings_events
            (ts, scope, scope_type, tenant, region, device_id, zone, mode, revision, updated_at, updated_by, change_kind, change_scope, source_origin, state_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            now,
            scopeMeta.scope,
            scopeMeta.scope_type,
            scopeMeta.tenant,
            scopeMeta.region,
            scopeMeta.device_id,
            scopeMeta.zone,
            scopeMeta.mode,
            nextRevision,
            updatedAt,
            updatedBy,
            changeKind,
            changeScope,
            sourceOrigin,
            stateJson
          ).run();
        } catch {
          // Audit logging is best-effort during rollout.
        }

        const id = env.SETTINGS_SCOPE_DO.idFromName(scopeMeta.scope);
        const stub = env.SETTINGS_SCOPE_DO.get(id);
        const currentResponse = {
          ok: true,
          state: body.value.state || {},
          meta: {
            updatedAt,
            updatedBy,
            revision: nextRevision,
            changeKind,
            changeScope,
            sourceOrigin
          },
          revision: nextRevision
        };

        try {
          await stub.fetch(`https://scope/${encodeURIComponent(scopeMeta.scope)}/notify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(currentResponse)
          });
        } catch {
          // Websocket fan-out is best-effort.
        }

        return json(currentResponse);
      }

      return json({ ok: false, error: "method_not_allowed" }, 405);
    }

    if (path.startsWith("/connect/")) {
      if (!isOriginAllowed(request, env)) {
        return json({ ok: false, error: "origin_not_allowed" }, 403);
      }

      const scope = decodeURIComponent(path.slice("/connect/".length));
      const scopeMeta = parseScope(scope);
      if (!scopeMeta) return json({ ok: false, error: "invalid_scope" }, 400);

      const id = env.SETTINGS_SCOPE_DO.idFromName(scopeMeta.scope);
      const stub = env.SETTINGS_SCOPE_DO.get(id);
      const response = await stub.fetch(new Request(`https://scope/${encodeURIComponent(scopeMeta.scope)}/connect`, request));
      return withCors(response);
    }

    if (path === "/api/settings-auth" && request.method === "POST") {
      if (!isOriginAllowed(request, env)) {
        return json({ ok: false, error: "origin_not_allowed" }, 403);
      }

      const expectedPin = String(env.SECONDARY_SETTINGS_PIN || "").trim();
      if (!expectedPin) {
        return json({ ok: false, error: "settings_pin_not_configured" }, 503);
      }

      const body = await readJsonBody(request, 4096);
      if (!body.ok) return json({ ok: false, error: body.error }, 400);

      const submittedPin = String(body.value.pin || "").trim();
      if (!submittedPin) {
        return json({ ok: false, error: "pin_required" }, 400);
      }

      if (submittedPin !== expectedPin) {
        return json({ ok: false, error: "invalid_pin" }, 401);
      }

      return json({ ok: true });
    }

    if (path === "/api/heartbeat" && request.method === "POST") {
      const body = await readJsonBody(request, MAX_HEARTBEAT_BODY_BYTES);
      if (!body.ok) return json({ error: body.error }, 400);
      if (!env.DB) return json({ error: "db_unavailable" }, 503);

      const safeTenant = normalizeTenant(body.value.tenant);
      const safeRegion = normalizeRegion(body.value.region);
      const safeDeviceId = normalizeDeviceId(body.value.device_id);
      if (!safeTenant || !safeRegion || !safeDeviceId) {
        return json({ error: "valid tenant, region, and device_id required" }, 400);
      }

      const scopeSummaryResult = validateScopeSummary(
        body.value.scope_summary,
        safeTenant,
        safeRegion,
        safeDeviceId
      );
      if (!scopeSummaryResult.ok) {
        return json({ error: scopeSummaryResult.error }, 400);
      }

      const overrideSummaryResult = validateOverrideSummary(body.value.override_summary);
      if (!overrideSummaryResult.ok) {
        return json({ error: overrideSummaryResult.error }, 400);
      }

      const heartbeatPolicyResult = validateHeartbeatPolicy(body.value.heartbeat_policy);
      if (!heartbeatPolicyResult.ok) {
        return json({ error: heartbeatPolicyResult.error }, 400);
      }

      const payload = {
        tenant: safeTenant,
        region: safeRegion,
        device_id: safeDeviceId,
        url: sanitizeString(body.value.url || "", 500),
        app_version: sanitizeString(body.value.app_version || "", 80),
        manifest_hash: sanitizeString(body.value.manifest_hash || "", 120),
        frame_hash: sanitizeString(body.value.frame_hash || "", 120),
        viewport: sanitizeString(body.value.viewport || "", 40),
        visibility: sanitizeString(body.value.visibility || "", 40),
        heartbeat_policy: heartbeatPolicyResult.value,
        override_summary: overrideSummaryResult.value,
        scope_summary: scopeSummaryResult.value,
        proof: isPlainObject(body.value.proof) ? body.value.proof : {},
        metrics: isPlainObject(body.value.metrics) ? body.value.metrics : {},
        last_seen: now
      };

      const stub = getTenantRegionStub(env, safeTenant, safeRegion);
      await stub.fetch(`https://do/${safeTenant}/${safeRegion}/upsert`, {
        method: "POST",
        body: JSON.stringify(payload)
      });

      await env.DB.prepare(`
        INSERT INTO heartbeat_events
        (ts, tenant, region, device_id, url, app_version, manifest_hash, frame_hash, viewport, visibility, heartbeat_policy, override_summary, scope_summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        now,
        safeTenant,
        safeRegion,
        safeDeviceId,
        payload.url,
        payload.app_version,
        payload.manifest_hash,
        payload.frame_hash,
        payload.viewport,
        payload.visibility,
        JSON.stringify(payload.heartbeat_policy || null),
        JSON.stringify(payload.override_summary || {}),
        JSON.stringify(payload.scope_summary || {})
      ).run();

      await env.DB.prepare(`
        INSERT INTO devices (tenant, region, device_id, first_seen, last_seen, last_url, last_app_version, last_manifest_hash, last_viewport, last_visibility, last_heartbeat_policy, last_override_summary, last_scope_summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant, region, device_id) DO UPDATE SET
          last_seen=excluded.last_seen,
          last_url=excluded.last_url,
          last_app_version=excluded.last_app_version,
          last_manifest_hash=excluded.last_manifest_hash,
          last_viewport=excluded.last_viewport,
          last_visibility=excluded.last_visibility,
          last_heartbeat_policy=excluded.last_heartbeat_policy,
          last_override_summary=excluded.last_override_summary,
          last_scope_summary=excluded.last_scope_summary
      `).bind(
        safeTenant,
        safeRegion,
        safeDeviceId,
        now,
        now,
        payload.url,
        payload.app_version,
        payload.manifest_hash,
        payload.viewport,
        payload.visibility,
        JSON.stringify(payload.heartbeat_policy || null),
        JSON.stringify(payload.override_summary || {}),
        JSON.stringify(payload.scope_summary || {})
      ).run();

      return json({ ok: true, ts: now });
    }

    if (path === "/api/tenants" && request.method === "GET") {
      if (!env.DB) return json({ error: "db_unavailable" }, 503);
      const tenants = await listTenants(env);
      return json({ tenants, ts: now });
    }

    if (path.startsWith("/api/tenants/") && request.method === "GET") {
      if (!env.DB) return json({ error: "db_unavailable" }, 503);

      const parts = path.split("/").filter(Boolean);
      const tenant = normalizeTenant(parts[2] || "");
      if (!tenant) return json({ error: "valid tenant required" }, 400);

      if (parts.length === 4 && parts[3] === "regions") {
        const result = await listRegionsForTenant(env, tenant, url.searchParams, now);
        return json(result);
      }

      if (parts.length >= 6 && parts[3] === "regions") {
        const region = normalizeRegion(parts[4] || "");
        const action = parts[5] || "";
        if (!region) return json({ error: "valid region required" }, 400);

        let data = { items: [] };
        try {
          data = await fetchTenantRegionItems(env, tenant, region, url.search);
        } catch {
          return json({ error: "region_unavailable" }, 502);
        }

        const items = Array.isArray(data.items) ? data.items : [];
        const offlineMs = data.uses_device_policy
          ? null
          : Number(data.offline_ms || url.searchParams.get("offline_ms") || 1800000);

        if (action === "devices") {
          return json({
            tenant,
            region,
            now: data.now || now,
            offline_ms: offlineMs,
            uses_device_policy: Boolean(data.uses_device_policy),
            total: items.length,
            items
          });
        }

        if (action === "override-summary") {
          return json(buildOverrideSummary(tenant, region, items, offlineMs));
        }
      }
    }

    return json({
      ok: true,
      service: SERVICE_NAME,
      version: API_VERSION,
      message: "BDN tenant control plane"
    });
  }
};
