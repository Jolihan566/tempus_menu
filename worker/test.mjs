// Offline test: node worker/test.mjs  — fakes GitHub + Mojang, no network.
import worker, { validateSubmission, slugify } from "./src/index.js";
import assert from "node:assert/strict";

const PNG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13]).toString("base64");
const env = { GITHUB_TOKEN: "t", GH_OWNER: "o", GH_REPO: "r", GH_BASE: "main", CARD_DIR: "player_cards" };

let calls = [], openPRs = [], branchExists = false;
globalThis.fetch = async (url, init = {}) => {
  const m = init.method || "GET"; calls.push(`${m} ${url}`);
  const ok = (d, s = 200) => new Response(JSON.stringify(d), { status: s });
  if (url.includes("api.mojang.com")) return url.endsWith("/Nobody_123") ? new Response(null, { status: 204 }) : ok({ id: "uuid1", name: "Jolihan" });
  if (url.endsWith("/git/ref/heads/main")) return ok({ object: { sha: "base" } });
  if (url.endsWith("/git/commits/base")) return ok({ tree: { sha: "tree0" } });
  if (url.endsWith("/git/blobs")) return ok({ sha: "blob" }, 201);
  if (url.endsWith("/git/trees")) { const b = JSON.parse(init.body); assert.equal(b.tree[0].path, "player_cards/jolihan_card.png"); assert.equal(b.tree[1].path, "player_cards/meta/jolihan.json"); return ok({ sha: "tree1" }, 201); }
  if (url.endsWith("/git/commits")) return ok({ sha: "c1" }, 201);
  if (url.endsWith("/git/refs") && m === "POST") { if (branchExists) return ok({}, 422); branchExists = true; return ok({}, 201); }
  if (url.includes("/git/refs/heads/card/jolihan") && m === "PATCH") { assert.equal(JSON.parse(init.body).force, true); return ok({}); }
  if (url.includes("/pulls?state=open")) return ok(openPRs);
  if (url.endsWith("/pulls") && m === "POST") { openPRs = [{ number: 7 }]; return ok({ number: 7 }, 201); }
  throw new Error("unexpected " + m + " " + url);
};
const post = (body) => worker.fetch(new Request("https://x/card", { method: "POST", body: JSON.stringify(body) }), env);

// validation
assert.equal(validateSubmission({ name: "ab", image: PNG }).error, "bad_name");
assert.equal(validateSubmission({ name: "Jolihan", image: "aGVsbG8=" }).error, "bad_image");
assert.equal(validateSubmission({ name: "Jolihan", image: PNG, bio: "x".repeat(999) }).bio.length, 240);
assert.equal(slugify("Jo_Li-han"), "jo_li_han");

// unknown player
let r = await post({ name: "Nobody_123", image: PNG });
assert.equal(r.status, 400); assert.equal((await r.json()).error, "unknown_player");

// first submission -> new PR
r = await post({ name: "Jolihan", image: PNG, fav: "Pikachu", bio: "hi" });
let d = await r.json(); assert.equal(r.status, 200, JSON.stringify(d)); assert.deepEqual([d.pr, d.updated], [7, false]);

// resubmission -> branch force-moved, same PR reused
calls = []; r = await post({ name: "Jolihan", image: PNG });
d = await r.json(); assert.deepEqual([d.pr, d.updated], [7, true]);
assert.ok(calls.some(c => c.startsWith("PATCH")));
assert.ok(!calls.some(c => c.endsWith("/pulls") && c.startsWith("POST")));

// not configured / CORS preflight / 404
r = await worker.fetch(new Request("https://x/card", { method: "POST", body: "{}" }), {}); assert.equal(r.status, 503);
r = await worker.fetch(new Request("https://x/card", { method: "OPTIONS" }), env); assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
r = await worker.fetch(new Request("https://x/nope"), env); assert.equal(r.status, 404);
console.log("worker tests passed");
