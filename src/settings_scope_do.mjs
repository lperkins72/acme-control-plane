export class SettingsScopeDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.currentState = null;
    this.currentMeta = null;
    this.revision = 0;
    this.scopeName = "";
  }

  async rememberScopeName(scope) {
    const safeScope = String(scope || "").trim();
    if (!safeScope) return "";
    this.scopeName = safeScope;
    try {
      await this.state.storage.put("scope_name", safeScope);
    } catch {
      // Storage persistence is best-effort.
    }
    return safeScope;
  }

  async resolveScopeName(requestScope = "") {
    const safeRequestScope = String(requestScope || "").trim();
    if (safeRequestScope) {
      return this.rememberScopeName(safeRequestScope);
    }
    if (this.scopeName) return this.scopeName;

    try {
      const stored = await this.state.storage.get("scope_name");
      if (stored) {
        this.scopeName = String(stored).trim();
        return this.scopeName;
      }
    } catch {
      // Fall through to empty scope.
    }

    return "";
  }

  async loadCurrentFromDb(scope) {
    const safeScope = await this.resolveScopeName(scope);
    if (!safeScope) {
      this.currentState = null;
      this.currentMeta = null;
      this.revision = 0;
      return;
    }

    try {
      const row = await this.env.DB.prepare(`
        SELECT state_json, updated_at, updated_by, revision
        FROM settings_current
        WHERE scope = ?
      `).bind(safeScope).first();

      if (!row) {
        this.currentState = null;
        this.currentMeta = null;
        this.revision = 0;
        return;
      }

      this.currentState = row.state_json ? JSON.parse(row.state_json) : null;
      this.revision = Number(row.revision || 0);
      this.currentMeta = {
        updatedAt: row.updated_at || null,
        updatedBy: row.updated_by || null,
        revision: this.revision
      };
    } catch {
      this.currentState = null;
      this.currentMeta = null;
      this.revision = 0;
    }
  }

  sendCurrentState(socket) {
    socket.send(JSON.stringify({
      type: "state",
      state: this.currentState,
      meta: this.currentMeta,
      revision: this.revision
    }));
  }

  broadcastCurrentState() {
    const payload = JSON.stringify({
      type: "state",
      state: this.currentState,
      meta: this.currentMeta,
      revision: this.revision
    });

    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        // A closing or failed socket must not prevent delivery to other clients.
      }
    }
  }

  async handleWebSocket(request, scope) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }

    await this.loadCurrentFromDb(scope);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);

    this.sendCurrentState(server);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  webSocketMessage(_socket, _message) {
    // The existing protocol is server-push only; client messages are ignored.
  }

  webSocketClose(socket, code, reason, _wasClean) {
    try {
      socket.close(code, reason);
    } catch {
      // The socket may already be closed.
    }
  }

  webSocketError(socket, _error) {
    try {
      socket.close(1011, "WebSocket error");
    } catch {
      // The socket may already be closed.
    }
  }

  async handleNotify(request, scope) {
    await this.resolveScopeName(scope);

    let body = {};
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "invalid_json" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    this.currentState = body.state && typeof body.state === "object" ? body.state : null;
    this.revision = Number(body.revision || 0);
    this.currentMeta = body.meta && typeof body.meta === "object"
      ? { ...body.meta, revision: this.revision }
      : { revision: this.revision };

    this.broadcastCurrentState();

    return new Response(JSON.stringify({ ok: true, revision: this.revision }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const parts = path.split("/").filter(Boolean);
    const encodedScope = parts.length >= 2 ? parts[0] : "";
    const scope = encodedScope ? decodeURIComponent(encodedScope) : "";

    if (path.endsWith("/connect")) {
      return this.handleWebSocket(request, scope);
    }

    if (request.method === "POST" && path.endsWith("/notify")) {
      return this.handleNotify(request, scope);
    }

    return new Response("Not found", { status: 404 });
  }
}
