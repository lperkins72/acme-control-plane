CREATE TABLE IF NOT EXISTS heartbeat_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  tenant TEXT NOT NULL,
  region TEXT NOT NULL,
  device_id TEXT NOT NULL,
  url TEXT,
  app_version TEXT,
  browser_name TEXT,
  browser_version TEXT,
  browser_platform TEXT,
  browser_user_agent TEXT,
  manifest_hash TEXT,
  frame_hash TEXT,
  viewport TEXT,
  visibility TEXT,
  heartbeat_policy TEXT,
  override_summary TEXT,
  scope_summary TEXT
);

CREATE TABLE IF NOT EXISTS devices (
  tenant TEXT NOT NULL,
  region TEXT NOT NULL,
  device_id TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  last_url TEXT,
  last_app_version TEXT,
  last_browser_name TEXT,
  last_browser_version TEXT,
  last_browser_platform TEXT,
  last_browser_user_agent TEXT,
  last_manifest_hash TEXT,
  last_viewport TEXT,
  last_visibility TEXT,
  last_heartbeat_policy TEXT,
  last_override_summary TEXT,
  last_scope_summary TEXT,
  PRIMARY KEY (tenant, region, device_id)
);

CREATE TABLE IF NOT EXISTS settings_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  scope TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  tenant TEXT NOT NULL,
  region TEXT,
  device_id TEXT,
  zone TEXT,
  mode TEXT,
  revision INTEGER,
  updated_at TEXT,
  updated_by TEXT,
  change_kind TEXT,
  change_scope TEXT,
  source_origin TEXT,
  state_json TEXT
);

CREATE TABLE IF NOT EXISTS settings_current (
  scope TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  tenant TEXT NOT NULL,
  region TEXT,
  device_id TEXT,
  zone TEXT,
  mode TEXT,
  revision INTEGER NOT NULL,
  updated_at TEXT,
  updated_by TEXT,
  state_json TEXT
);

CREATE TABLE IF NOT EXISTS region_assets (
  asset_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant TEXT NOT NULL,
  region TEXT NOT NULL,
  zone TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  public_url TEXT NOT NULL,
  filename_original TEXT NOT NULL,
  filename_display TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hb_tenant_region_ts ON heartbeat_events(tenant, region, ts);
CREATE INDEX IF NOT EXISTS idx_hb_tenant_region_device_ts ON heartbeat_events(tenant, region, device_id, ts);
CREATE INDEX IF NOT EXISTS idx_devices_tenant_region ON devices(tenant, region);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen);
CREATE INDEX IF NOT EXISTS idx_settings_events_scope_ts ON settings_events(scope, ts);
CREATE INDEX IF NOT EXISTS idx_settings_events_tenant_region_zone_ts ON settings_events(tenant, region, zone, ts);
CREATE INDEX IF NOT EXISTS idx_settings_current_tenant_region_zone ON settings_current(tenant, region, zone);
CREATE INDEX IF NOT EXISTS idx_region_assets_tenant_region_zone_created ON region_assets(tenant, region, zone, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_region_assets_r2_key ON region_assets(r2_key);
