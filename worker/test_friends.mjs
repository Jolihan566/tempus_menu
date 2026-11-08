// Offline test of the Social API against real SQLite (node:sqlite), shaped like D1.
//   node test_friends.mjs
import worker from "./src/index.js";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  first: async () => sqlite.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  run: async () => { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  _exec: () => sqlite.prepare(sql).run(...args),
});
const DB = { prepare: (sql) => stmt(sql), batch: async (list) => { sqlite.exec("BEGIN"); try { list.forEach((s) => s._exec()); sqlite.exec("COMMIT"); } catch (e) { sqlite.exec("ROLLBACK"); throw e; } return []; } };

// Fake name lookups: known accounts, plus a switch to simulate the services being down.
const ACCOUNTS = { ash: "11111111111111111111111111111111", misty: "22222222222222222222222222222222", brock: "33333333333333333333333333333333", gary: "44444444444444444444444444444444" };
let lookupsDown = false;
globalThis.fetch = async (url) => {
  if (lookupsDown) return new Response("", { status: 503 });
  const name = decodeURIComponent(url.split("/").pop()).toLowerCase();
  if (url.includes("minecraftservices.com")) {
    return ACCOUNTS[name] ? new Response(JSON.stringify({ id: ACCOUNTS[name], name: name[0].toUpperCase() + name.slice(1) })) : new Response("", { status: 404 });
  }
  return new Response("{}", { status: 503 });
};

const env = { DB, ADMIN_KEY: "admin-secret" };
const hy = (h) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
const me = (n, key) => ({ uuid: hy(ACCOUNTS[n]), name: n[0].toUpperCase() + n.slice(1), key: key || `${n}-key-0123456789abcdef0123456789abcdef` });
const call = async (path, body, headers = {}) => {
  const r = await worker.fetch(new Request(`https://x/friends/${path}`, { method: "POST", body: JSON.stringify(body), headers }), env);
  return { status: r.status, ...(await r.json()) };
};

// first use registers; wrong key is refused afterwards
let r = await call("state", me("ash"));
assert.equal(r.status, 200); assert.equal(r.registered, true); assert.deepEqual(r.friends, []);
r = await call("state", me("ash", "someone-else-key-0123456789abcdef0123"));
assert.equal(r.status, 403); assert.equal(r.error, "key_mismatch");
// name must belong to the uuid
r = await call("state", { ...me("misty"), name: "Ash" });
assert.equal(r.error, "bad_identity");

// Ash requests Misty before Misty has ever opened Social
r = await call("request", { ...me("ash"), target: "misty" });
assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.action.result, "requested"); assert.equal(r.outgoing[0].name, "Misty");
// Misty registers and sees it waiting
r = await call("state", me("misty"));
assert.equal(r.registered, true); assert.equal(r.incoming.length, 1); assert.equal(r.incoming[0].name, "Ash");
// Misty accepts
r = await call("respond", { ...me("misty"), uuid_other: me("ash").uuid, accept: true });
assert.equal(r.action.result, "friends"); assert.equal(r.friends[0].name, "Ash"); assert.equal(r.incoming.length, 0);
r = await call("state", me("ash"));
assert.equal(r.friends[0].name, "Misty"); assert.equal(r.outgoing.length, 0);

// duplicate / self / unknown
assert.equal((await call("request", { ...me("ash"), target: "Misty" })).error, "already_friends");
assert.equal((await call("request", { ...me("ash"), target: "ash" })).error, "self");
assert.equal((await call("request", { ...me("ash"), target: "nobody_here" })).error, "unknown_player");

// mutual requests auto-accept
await call("state", me("brock"));
r = await call("request", { ...me("brock"), target: "ash" });
assert.equal(r.action.result, "requested");
r = await call("request", { ...me("ash"), target: "brock" });
assert.equal(r.action.result, "friends"); assert.equal(r.friends.length, 2);

// decline, cancel, remove
r = await call("request", { ...me("gary"), target: "ash" });
assert.equal(r.action.result, "requested");
r = await call("respond", { ...me("ash"), uuid_other: me("gary").uuid, accept: false });
assert.equal(r.action.result, "declined"); assert.equal(r.incoming.length, 0);
r = await call("request", { ...me("gary"), target: "misty" });
r = await call("cancel", { ...me("gary"), uuid_other: me("misty").uuid });
assert.equal(r.outgoing.length, 0);
r = await call("remove", { ...me("ash"), uuid_other: me("brock").uuid });
assert.equal(r.friends.length, 1);
assert.equal((await call("state", me("brock"))).friends.length, 0);

// name lookups down: existing players still work; new names can't be requested
lookupsDown = true;
assert.equal((await call("state", me("ash"))).status, 200);
assert.equal((await call("request", { ...me("ash"), target: "brock" })).action.result, "requested"); // Brock is already known
assert.equal((await call("request", { ...me("ash"), target: "someone_new" })).error, "lookup_unavailable");
lookupsDown = false;

// staff key reset lets a player re-register with a new key
assert.equal((await call("admin/reset", { name: "ash" }, { "X-Admin-Key": "wrong" })).status, 403);
r = await call("admin/reset", { name: "ash" }, { "X-Admin-Key": "admin-secret" });
assert.equal(r.result, "reset");
r = await call("state", me("ash", "new-pc-key-0123456789abcdef0123456789abcd"));
assert.equal(r.status, 200); assert.equal(r.friends[0].name, "Misty"); // friends survive the reset

// bad input and not configured
assert.equal((await call("state", { uuid: "x", name: "Ash", key: "k" })).error, "bad_identity");
r = await worker.fetch(new Request("https://x/friends/state", { method: "POST", body: "{}" }), {});
assert.equal(r.status, 503);
console.log("friends tests passed");
