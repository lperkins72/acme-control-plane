export class TenantRegionDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  resolveOfflineThresholdMs(value, fallbackMs) {
    const thresholdMinutes = Number(value);
    if (!Number.isFinite(thresholdMinutes) || thresholdMinutes <= 0) {
      return fallbackMs;
    }
    return thresholdMinutes * 60 * 1000;
  }

  minutesForTimeString(value) {
    const match = /^(\d{2}):(\d{2})$/.exec(String(value || "").trim());
    if (!match) return null;
    return (Number(match[1]) * 60) + Number(match[2]);
  }

  timePartsInZone(date, timezone) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "America/Chicago",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(date);
    return {
      hour: Number(parts.find((part) => part.type === "hour")?.value || 0),
      minute: Number(parts.find((part) => part.type === "minute")?.value || 0)
    };
  }

  isDayWindow(policy, date = new Date()) {
    const startMinutes = this.minutesForTimeString(policy?.dayStartTime);
    const endMinutes = this.minutesForTimeString(policy?.dayEndTime);
    if (startMinutes === null || endMinutes === null) return true;

    const current = this.timePartsInZone(date, policy?.timezone || "America/Chicago");
    const currentMinutes = (current.hour * 60) + current.minute;
    if (startMinutes === endMinutes) return true;
    if (startMinutes < endMinutes) {
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    }
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  resolvePolicyOfflineThresholdMs(policy, fallbackMs, date = new Date()) {
    const legacyThresholdMinutes = Number(policy?.offlineThresholdMinutes);
    const dayThresholdMinutes = policy?.dayOfflineThresholdMinutes === undefined
      ? legacyThresholdMinutes
      : Number(policy.dayOfflineThresholdMinutes);
    const nightThresholdMinutes = policy?.nightOfflineThresholdMinutes === undefined
      ? legacyThresholdMinutes
      : Number(policy.nightOfflineThresholdMinutes);
    const active = this.isDayWindow(policy, date);
    const selectedMinutes = active ? dayThresholdMinutes : nightThresholdMinutes;
    return this.resolveOfflineThresholdMs(selectedMinutes, fallbackMs);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "POST" && path.endsWith("/upsert")) {
      const body = await request.json();
      const { tenant, region, device_id } = body || {};

      if (!tenant || !region || !device_id) {
        return new Response(JSON.stringify({ ok: false, error: "tenant_region_device_required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" }
        });
      }

      await this.state.storage.put(device_id, body);

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    if (request.method === "GET" && path.endsWith("/list")) {
      const now = Date.now();
      const defaultOfflineMs = 1800000;
      const requestedOfflineMs = Number(url.searchParams.get("offline_ms") || 0);
      const usesOverride = Number.isFinite(requestedOfflineMs) && requestedOfflineMs > 0;

      const map = await this.state.storage.list();
      const items = [];

      for (const [device_id, value] of map.entries()) {
        const lastSeen = Number(value.last_seen || 0);
        const heartbeatPolicy = value.heartbeat_policy && typeof value.heartbeat_policy === "object"
          ? value.heartbeat_policy
          : null;
        const effectiveOfflineMs = usesOverride
          ? requestedOfflineMs
          : this.resolvePolicyOfflineThresholdMs(heartbeatPolicy, defaultOfflineMs, new Date(now));

        items.push({
          device_id,
          tenant: value.tenant || "",
          region: value.region || "",
          url: value.url || "",
          app_version: value.app_version || "",
          browser_name: value.browser_name || "",
          browser_version: value.browser_version || "",
          browser_platform: value.browser_platform || "",
          browser_user_agent: value.browser_user_agent || "",
          last_seen: lastSeen,
          visibility: value.visibility || "visible",
          status: (now - lastSeen) <= effectiveOfflineMs ? "online" : "offline",
          effective_offline_ms: effectiveOfflineMs,
          heartbeat_policy: heartbeatPolicy,
          scope_summary: value.scope_summary || {},
          override_summary: value.override_summary || {},
          proof: value.proof || {},
          metrics: value.metrics || {}
        });
      }

      items.sort((a, b) => {
        if (a.status !== b.status) return a.status === "online" ? -1 : 1;
        return (b.last_seen || 0) - (a.last_seen || 0);
      });

      return new Response(JSON.stringify({
        tenant: path.split("/")[1] || "",
        region: path.split("/")[2] || "",
        now,
        offline_ms: usesOverride ? requestedOfflineMs : 0,
        uses_device_policy: !usesOverride,
        total: items.length,
        items
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("Not found", { status: 404 });
  }
}
