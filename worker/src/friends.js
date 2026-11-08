/**
 * Tempus Social — friends lists and requests, stored in Cloudflare D1.
 *
 * Identity is "first use wins": the first time a player opens Social, their
 * game makes a random private key and the Worker stores its hash against their
 * UUID. Every later call must present the same key. Staff can clear a key with
 * POST /friends/admin/reset (header X-Admin-Key = ADMIN_KEY secret).
 *
 * All endpoints are POST JSON and take { uuid, name, key } plus their own fields:
 *   /friends/state                      -> { me, friends[], incoming[], outgoing[] }
 *   /friends/request   { target }       -> { result: "requested" | "friends" }
 *   /friends/respond   { uuid_other, accept }
 *   /friends/cancel    { uuid_other }
 *   /friends/remove    { uuid_other }
 */

export const LIMITS = { friends: 100, outgoing: 30 };
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function normUuid(u) {
  if (typeof u !== "string") return "";
  const s = u.trim().toLowerCase().replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(s)) return "";
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

class Fail extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

// Who is calling? Registers on first use, then requires the same key.
async function identify(env, body, lookupPlayer) {
  const uuid = normUuid(body.uuid);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const key = typeof body.key === "string" ? body.key : "";
  if (!UUID_RE.test(uuid) || !NAME_RE.test(name)) throw new Fail("bad_identity");
  if (key.length < 32 || key.length > 128) throw new Fail("bad_key");
  const hash = await sha256(key);
  const now = Date.now();
  const row = await env.DB.prepare("SELECT uuid, key_hash FROM players WHERE uuid = ?").bind(uuid).first();

  if (row && row.key_hash) {
    if (row.key_hash !== hash) throw new Fail("key_mismatch", 403);
    await env.DB.prepare("UPDATE players SET name = ?, name_lc = ?, last_seen = ? WHERE uuid = ?")
      .bind(name, name.toLowerCase(), now, uuid).run();
    return { uuid, name };
  }

  // First use: the name must belong to this UUID (when the lookup services answer).
  const prof = await lookupPlayer(name);
  if (prof.missing) throw new Fail("bad_identity");
  if (prof.id && normUuid(prof.id) !== uuid) throw new Fail("bad_identity");

  if (row) {
    await env.DB.prepare("UPDATE players SET name = ?, name_lc = ?, key_hash = ?, last_seen = ? WHERE uuid = ?")
      .bind(name, name.toLowerCase(), hash, now, uuid).run();
  } else {
    await env.DB.prepare("INSERT INTO players (uuid, name, name_lc, key_hash, created, last_seen) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(uuid, name, name.toLowerCase(), hash, now, now).run();
  }
  return { uuid, name, registered: true };
}

async function count(env, sql, ...args) {
  const r = await env.DB.prepare(sql).bind(...args).first();
  return r ? Number(Object.values(r)[0]) : 0;
}

async function state(env, me) {
  const friends = await env.DB.prepare(
    "SELECT p.uuid, p.name, f.since FROM friends f JOIN players p ON p.uuid = f.b WHERE f.a = ? ORDER BY p.name_lc"
  ).bind(me.uuid).all();
  const incoming = await env.DB.prepare(
    "SELECT p.uuid, p.name, r.created FROM requests r JOIN players p ON p.uuid = r.from_uuid WHERE r.to_uuid = ? ORDER BY r.created DESC"
  ).bind(me.uuid).all();
  const outgoing = await env.DB.prepare(
    "SELECT p.uuid, p.name, r.created FROM requests r JOIN players p ON p.uuid = r.to_uuid WHERE r.from_uuid = ? ORDER BY r.created DESC"
  ).bind(me.uuid).all();
  return {
    me: { uuid: me.uuid, name: me.name },
    friends: friends.results || [],
    incoming: incoming.results || [],
    outgoing: outgoing.results || [],
    limits: LIMITS,
  };
}

async function makeFriends(env, a, b) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO friends (a, b, since) VALUES (?, ?, ?)").bind(a, b, now),
    env.DB.prepare("INSERT OR IGNORE INTO friends (a, b, since) VALUES (?, ?, ?)").bind(b, a, now),
    env.DB.prepare("DELETE FROM requests WHERE (from_uuid = ? AND to_uuid = ?) OR (from_uuid = ? AND to_uuid = ?)").bind(a, b, b, a),
  ]);
}

async function areFriends(env, a, b) {
  return !!(await env.DB.prepare("SELECT 1 AS x FROM friends WHERE a = ? AND b = ?").bind(a, b).first());
}

async function sendRequest(env, me, body, lookupPlayer) {
  const target = typeof body.target === "string" ? body.target.trim() : "";
  if (!NAME_RE.test(target)) throw new Fail("bad_name");
  if (target.toLowerCase() === me.name.toLowerCase()) throw new Fail("self");

  let other = await env.DB.prepare("SELECT uuid, name FROM players WHERE name_lc = ? ORDER BY last_seen DESC LIMIT 1")
    .bind(target.toLowerCase()).first();
  if (!other) {
    const prof = await lookupPlayer(target);
    if (prof.missing) throw new Fail("unknown_player");
    if (!prof.id) throw new Fail("lookup_unavailable", 503);
    const uuid = normUuid(prof.id);
    const now = Date.now();
    // Placeholder row so the request is waiting for them when they first open Social.
    await env.DB.prepare("INSERT OR IGNORE INTO players (uuid, name, name_lc, key_hash, created, last_seen) VALUES (?, ?, ?, NULL, ?, 0)")
      .bind(uuid, prof.name || target, (prof.name || target).toLowerCase(), now).run();
    other = { uuid, name: prof.name || target };
  }
  if (other.uuid === me.uuid) throw new Fail("self");
  if (await areFriends(env, me.uuid, other.uuid)) throw new Fail("already_friends");

  const reverse = await env.DB.prepare("SELECT 1 AS x FROM requests WHERE from_uuid = ? AND to_uuid = ?")
    .bind(other.uuid, me.uuid).first();
  if (reverse) {
    if (await count(env, "SELECT COUNT(*) AS n FROM friends WHERE a = ?", me.uuid) >= LIMITS.friends) throw new Fail("friend_limit");
    await makeFriends(env, me.uuid, other.uuid);
    return { result: "friends", other };
  }
  if (await count(env, "SELECT COUNT(*) AS n FROM friends WHERE a = ?", me.uuid) >= LIMITS.friends) throw new Fail("friend_limit");
  if (await count(env, "SELECT COUNT(*) AS n FROM requests WHERE from_uuid = ?", me.uuid) >= LIMITS.outgoing) throw new Fail("request_limit");
  await env.DB.prepare("INSERT OR IGNORE INTO requests (from_uuid, to_uuid, created) VALUES (?, ?, ?)")
    .bind(me.uuid, other.uuid, Date.now()).run();
  return { result: "requested", other };
}

async function respond(env, me, body) {
  const other = normUuid(body.uuid_other);
  if (!other) throw new Fail("bad_request");
  const req = await env.DB.prepare("SELECT 1 AS x FROM requests WHERE from_uuid = ? AND to_uuid = ?").bind(other, me.uuid).first();
  if (!req) throw new Fail("no_request", 404);
  if (body.accept === true) {
    if (await count(env, "SELECT COUNT(*) AS n FROM friends WHERE a = ?", me.uuid) >= LIMITS.friends) throw new Fail("friend_limit");
    await makeFriends(env, me.uuid, other);
    return { result: "friends" };
  }
  await env.DB.prepare("DELETE FROM requests WHERE from_uuid = ? AND to_uuid = ?").bind(other, me.uuid).run();
  return { result: "declined" };
}

async function cancel(env, me, body) {
  const other = normUuid(body.uuid_other);
  if (!other) throw new Fail("bad_request");
  await env.DB.prepare("DELETE FROM requests WHERE from_uuid = ? AND to_uuid = ?").bind(me.uuid, other).run();
  return { result: "cancelled" };
}

async function remove(env, me, body) {
  const other = normUuid(body.uuid_other);
  if (!other) throw new Fail("bad_request");
  await env.DB.prepare("DELETE FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)").bind(me.uuid, other, other, me.uuid).run();
  return { result: "removed" };
}

async function adminReset(env, request, body) {
  if (!env.ADMIN_KEY || request.headers.get("X-Admin-Key") !== env.ADMIN_KEY) throw new Fail("forbidden", 403);
  let uuid = normUuid(body.uuid);
  if (!uuid && typeof body.name === "string") {
    const r = await env.DB.prepare("SELECT uuid FROM players WHERE name_lc = ?").bind(body.name.trim().toLowerCase()).first();
    uuid = r ? r.uuid : "";
  }
  if (!uuid) throw new Fail("not_found", 404);
  const r = await env.DB.prepare("UPDATE players SET key_hash = NULL WHERE uuid = ?").bind(uuid).run();
  return { result: "reset", uuid, changed: r && r.meta ? r.meta.changes : undefined };
}

const ACTIONS = { state: null, request: sendRequest, respond, cancel, remove };

/** Returns a { status, body } pair; the caller wraps it in a CORS response. */
export async function handleFriends(path, request, env, lookupPlayer) {
  if (!env.DB) return { status: 503, body: { error: "social_not_configured" } };
  let body;
  try { body = await request.json(); } catch { return { status: 400, body: { error: "bad_request" } }; }
  if (!body || typeof body !== "object") return { status: 400, body: { error: "bad_request" } };
  try {
    if (path === "admin/reset") return { status: 200, body: { ok: true, ...(await adminReset(env, request, body)) } };
    if (!(path in ACTIONS)) return { status: 404, body: { error: "not_found" } };
    const me = await identify(env, body, lookupPlayer);
    const action = path !== "state" ? await ACTIONS[path](env, me, body, lookupPlayer) : null;
    return { status: 200, body: { ok: true, action, registered: !!me.registered, ...(await state(env, me)) } };
  } catch (e) {
    if (e instanceof Fail) return { status: e.status, body: { error: e.code } };
    console.error("friends error", e && e.message);
    return { status: 500, body: { error: "server_error" } };
  }
}
