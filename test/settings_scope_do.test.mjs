import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { SettingsScopeDO } from "../src/settings_scope_do.mjs";

const SCOPE = "bdn:v1:tenant:acme:region:reg01:zone:primary";
const OriginalResponse = globalThis.Response;
const OriginalWebSocketPair = globalThis.WebSocketPair;
const pairs = [];

class TestResponse {
  constructor(body = null, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = new Headers(init.headers);
    this.webSocket = init.webSocket;
  }

  async json() {
    return JSON.parse(this.body);
  }

  async text() {
    return this.body === null ? "" : String(this.body);
  }
}

class TestSocket {
  constructor({ failSend = false, failClose = false } = {}) {
    this.failSend = failSend;
    this.failClose = failClose;
    this.sent = [];
    this.closed = [];
  }

  send(payload) {
    if (this.failSend) throw new Error("socket send failed");
    this.sent.push(payload);
  }

  close(code, reason) {
    if (this.failClose) throw new Error("socket close failed");
    this.closed.push({ code, reason });
  }
}

before(() => {
  globalThis.Response = TestResponse;
  globalThis.WebSocketPair = class {
    constructor() {
      this.client = new TestSocket();
      this.server = new TestSocket();
      pairs.push(this);
    }
  };
});

after(() => {
  globalThis.Response = OriginalResponse;
  globalThis.WebSocketPair = OriginalWebSocketPair;
});

function makeRuntime(row = null) {
  const stored = new Map();
  const sockets = [];
  const state = {
    sockets,
    accepted: [],
    acceptWebSocket(socket) {
      this.accepted.push(socket);
      sockets.push(socket);
    },
    getWebSockets() {
      return [...sockets];
    },
    storage: {
      async put(key, value) {
        stored.set(key, value);
      },
      async get(key) {
        return stored.get(key);
      }
    }
  };
  const env = {
    DB: {
      prepare() {
        return {
          bind() {
            return { async first() { return row; } };
          }
        };
      }
    }
  };
  return { state, env };
}

function request(path, init = {}) {
  return new Request(`https://scope/${encodeURIComponent(SCOPE)}${path}`, init);
}

function upgradeRequest() {
  return request("/connect", { headers: { Upgrade: "websocket" } });
}

function notifyRequest(state, revision = 2) {
  return request("/notify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      state,
      meta: { updatedAt: "2026-08-16T12:00:00.000Z", updatedBy: "test" },
      revision
    })
  });
}

function lastMessage(socket) {
  return JSON.parse(socket.sent.at(-1));
}

test("upgrades with hibernation and immediately sends current D1 state", async () => {
  const row = {
    state_json: JSON.stringify({ playlist: "current" }),
    updated_at: "2026-08-16T10:00:00.000Z",
    updated_by: "operator",
    revision: 7
  };
  const { state, env } = makeRuntime(row);
  const object = new SettingsScopeDO(state, env);
  const response = await object.fetch(upgradeRequest());
  const server = pairs.at(-1).server;

  assert.equal(response.status, 101);
  assert.deepEqual(state.accepted, [server]);
  assert.equal("sessions" in object, false);
  assert.deepEqual(lastMessage(server), {
    type: "state",
    state: { playlist: "current" },
    meta: { updatedAt: row.updated_at, updatedBy: row.updated_by, revision: 7 },
    revision: 7
  });
});

test("broadcasts notifications to multiple hibernatable clients", async () => {
  const { state, env } = makeRuntime();
  const object = new SettingsScopeDO(state, env);
  await object.fetch(upgradeRequest());
  await object.fetch(upgradeRequest());

  const response = await object.fetch(notifyRequest({ playlist: "new" }, 8));
  assert.equal(response.status, 200);
  assert.deepEqual(lastMessage(state.sockets[0]).state, { playlist: "new" });
  assert.deepEqual(lastMessage(state.sockets[1]).state, { playlist: "new" });
  assert.equal(lastMessage(state.sockets[1]).revision, 8);
});

test("continues broadcasting when one attached socket fails", async () => {
  const { state, env } = makeRuntime();
  const first = new TestSocket();
  const failed = new TestSocket({ failSend: true });
  const last = new TestSocket();
  state.sockets.push(first, failed, last);

  await new SettingsScopeDO(state, env).fetch(notifyRequest({ safe: true }, 3));
  assert.deepEqual(lastMessage(first).state, { safe: true });
  assert.deepEqual(lastMessage(last).state, { safe: true });
});

test("reconstruction discovers runtime-owned sockets without process memory", async () => {
  const { state, env } = makeRuntime();
  const connected = new TestSocket();
  state.sockets.push(connected);
  const reconstructed = new SettingsScopeDO(state, env);

  assert.equal("sessions" in reconstructed, false);
  await reconstructed.fetch(notifyRequest({ afterHibernation: true }, 9));
  assert.deepEqual(lastMessage(connected).state, { afterHibernation: true });
  assert.equal(lastMessage(connected).revision, 9);
});

test("preserves HTTP and invalid-upgrade behavior", async () => {
  const { state, env } = makeRuntime();
  const object = new SettingsScopeDO(state, env);
  const invalidUpgrade = await object.fetch(request("/connect"));
  const notFound = await object.fetch(new Request("https://scope/unknown"));
  const invalidNotify = await object.fetch(request("/notify", { method: "POST", body: "not json" }));

  assert.equal(invalidUpgrade.status, 426);
  assert.equal(await invalidUpgrade.text(), "Expected websocket");
  assert.equal(notFound.status, 404);
  assert.equal(invalidNotify.status, 400);
  assert.deepEqual(await invalidNotify.json(), { ok: false, error: "invalid_json" });
});

test("hibernation handlers preserve protocol and close safely", () => {
  const { state, env } = makeRuntime();
  const object = new SettingsScopeDO(state, env);
  const socket = new TestSocket();
  const alreadyClosed = new TestSocket({ failClose: true });

  assert.doesNotThrow(() => object.webSocketMessage(socket, "ignored"));
  assert.doesNotThrow(() => object.webSocketClose(socket, 1000, "done", true));
  assert.doesNotThrow(() => object.webSocketError(socket, new Error("failed")));
  assert.deepEqual(socket.closed, [
    { code: 1000, reason: "done" },
    { code: 1011, reason: "WebSocket error" }
  ]);
  assert.doesNotThrow(() => object.webSocketClose(alreadyClosed, 1000, "done", true));
  assert.doesNotThrow(() => object.webSocketError(alreadyClosed, new Error("failed")));
});
