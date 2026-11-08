/**
 * Tempus card-upload Worker
 *
 * Players' menus POST their rendered Trainer Card here instead of writing to
 * GitHub themselves. This Worker is the ONLY thing that holds a GitHub token.
 *
 * Every submission becomes (or updates) a pull request on its own branch
 * `card/<name>`. Nothing reaches the live gallery until you merge it on GitHub,
 * so abusive images and impersonation are caught at review.
 *
 * Endpoints
 *   GET  /health  -> { ok: true }
 *   POST /card    -> body { name, image, fav?, bio? }   (image = PNG base64, no data: prefix)
 *
 * Secrets / vars (see wrangler.toml and README.md)
 *   GITHUB_TOKEN  (secret)  fine-grained PAT: tempus_menu only, Contents RW + Pull requests RW
 *   GH_OWNER, GH_REPO, GH_BASE, CARD_DIR  (vars)
 *   RATE_LIMITER  (optional binding) per-IP limit
 */

const MAX_PNG_BYTES = 1_500_000;
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CORS = {
  // Menu pages run from file:// (Origin "null"), so a specific origin can't be pinned.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

export function cleanText(s, max) {
  if (typeof s !== "string") return "";
  // strip control chars (keep newlines), collapse runs of blank lines, trim, cap length
  return s
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

export function decodePng(b64) {
  if (typeof b64 !== "string") return null;
  const clean = b64.replace(/^data:image\/png;base64,/, "").replace(/\s/g, "");
  // base64 length guard before decoding (4 chars -> 3 bytes)
  if (clean.length * 0.75 > MAX_PNG_BYTES + 3) return { error: "too_large" };
  let bin;
  try {
    bin = atob(clean);
  } catch {
    return null;
  }
  if (bin.length > MAX_PNG_BYTES) return { error: "too_large" };
  for (let i = 0; i < PNG_SIG.length; i++) {
    if (bin.charCodeAt(i) !== PNG_SIG[i]) return null;
  }
  return { b64: clean, bytes: bin.length };
}

export function validateSubmission(body) {
  if (!body || typeof body !== "object") return { error: "bad_request" };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!NAME_RE.test(name)) return { error: "bad_name" };
  const png = decodePng(body.image);
  if (!png) return { error: "bad_image" };
  if (png.error) return { error: png.error };
  return {
    name,
    slug: slugify(name),
    png,
    fav: cleanText(body.fav, 30),
    bio: cleanText(body.bio, 240),
  };
}

// ---------------------------------------------------------------- GitHub ----
function gh(env) {
  const base = `https://api.github.com/repos/${env.GH_OWNER}/${env.GH_REPO}`;
  return async (path, init = {}) => {
    const res = await fetch(base + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "tempus-card-worker",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    return { ok: res.ok, status: res.status, data };
  };
}

// Mojang often blocks or rate-limits Cloudflare's IPs, so try several lookups.
// Each returns {id,name} | {missing:true} | null (service unavailable).
const LOOKUPS = [
  async (n) => {
    const r = await fetch(`https://api.minecraftservices.com/minecraft/profile/lookup/name/${n}`);
    if (r.status === 404 || r.status === 204) return { missing: true };
    if (!r.ok) return null;
    const d = await r.json();
    return d && d.id ? { id: d.id, name: d.name } : null;
  },
  async (n) => {
    const r = await fetch(`https://api.mojang.com/users/profiles/minecraft/${n}`);
    if (r.status === 404 || r.status === 204) return { missing: true };
    if (!r.ok) return null;
    const d = await r.json();
    return d && d.id ? { id: d.id, name: d.name } : null;
  },
  async (n) => {
    const r = await fetch(`https://playerdb.co/api/player/minecraft/${n}`);
    const d = await r.json().catch(() => null);
    if (d && d.success && d.data && d.data.player) {
      return { id: String(d.data.player.raw_id || d.data.player.id).replace(/-/g, ""), name: d.data.player.username };
    }
    if (d && d.code === "minecraft.invalid_username") return { missing: true };
    return null;
  },
];

export async function lookupPlayer(name) {
  const n = encodeURIComponent(name);
  let missingVotes = 0;
  for (const fn of LOOKUPS) {
    try {
      const res = await fn(n);
      if (res && res.id) return res;
      if (res && res.missing) missingVotes++;
    } catch { /* try the next service */ }
  }
  // Only reject as "doesn't exist" if a service actually said so and none found it.
  if (missingVotes > 0) return { missing: true };
  // Every service was down: let it through, flagged, since a human reviews the PR anyway.
  return { id: "", name, unverified: true };
}

/**
 * One commit on branch card/<slug> containing the PNG and its metadata,
 * branched fresh from the base branch each time (so a resubmission replaces
 * the previous pending one), then an open PR for that branch.
 */
export async function submitCard(env, sub, profile) {
  const api = gh(env);
  const base = env.GH_BASE || "main";
  const dir = env.CARD_DIR || "player_cards";
  const branch = `card/${sub.slug}`;

  const ref = await api(`/git/ref/heads/${base}`);
  if (!ref.ok) throw new Error(`base ref ${ref.status}`);
  const baseSha = ref.data.object.sha;

  const baseCommit = await api(`/git/commits/${baseSha}`);
  if (!baseCommit.ok) throw new Error(`base commit ${baseCommit.status}`);

  const meta = {
    name: profile.name,
    uuid: profile.id,
    fav: sub.fav,
    bio: sub.bio,
    updated: new Date().toISOString(),
    hidden: false,
  };

  const pngBlob = await api(`/git/blobs`, {
    method: "POST",
    body: JSON.stringify({ content: sub.png.b64, encoding: "base64" }),
  });
  const metaBlob = await api(`/git/blobs`, {
    method: "POST",
    body: JSON.stringify({ content: JSON.stringify(meta, null, 2) + "\n", encoding: "utf-8" }),
  });
  if (!pngBlob.ok || !metaBlob.ok) throw new Error("blob");

  const tree = await api(`/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: baseCommit.data.tree.sha,
      tree: [
        { path: `${dir}/${sub.slug}_card.png`, mode: "100644", type: "blob", sha: pngBlob.data.sha },
        { path: `${dir}/meta/${sub.slug}.json`, mode: "100644", type: "blob", sha: metaBlob.data.sha },
      ],
    }),
  });
  if (!tree.ok) throw new Error(`tree ${tree.status}`);

  const commit = await api(`/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: `Card submission: ${profile.name}`,
      tree: tree.data.sha,
      parents: [baseSha],
    }),
  });
  if (!commit.ok) throw new Error(`commit ${commit.status}`);

  // create the branch, or force-move it if a previous submission exists
  const created = await api(`/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.data.sha }),
  });
  if (!created.ok) {
    const moved = await api(`/git/refs/heads/${branch}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: commit.data.sha, force: true }),
    });
    if (!moved.ok) throw new Error(`ref ${moved.status}`);
  }

  const open = await api(
    `/pulls?state=open&head=${encodeURIComponent(`${env.GH_OWNER}:${branch}`)}`
  );
  if (open.ok && Array.isArray(open.data) && open.data.length) {
    return { pr: open.data[0].number, updated: true };
  }

  const bioLine = sub.bio ? `\n> ${sub.bio.replace(/\n/g, "\n> ")}\n` : "";
  const pr = await api(`/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: `Trainer card: ${profile.name}`,
      head: branch,
      base,
      body:
        `Submitted from the in-game menu.\n\n` +
        (profile.unverified
          ? `- Minecraft account: **${profile.name}** ⚠️ NOT VERIFIED (name lookup services were down)\n`
          : `- Minecraft account: **${profile.name}** (\`${profile.id}\`)\n`) +
        `- Favourite: ${sub.fav || "—"}\n${bioLine}\n` +
        `Merge to publish. Close to reject. The name was typed into the menu, ` +
        `so check it really is this player before merging.`,
    }),
  });
  if (!pr.ok) throw new Error(`pr ${pr.status}`);
  return { pr: pr.data.number, updated: false };
}

// ---------------------------------------------------------------- entry -----
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname !== "/card" || request.method !== "POST") return json({ error: "not_found" }, 404);
    if (!env.GITHUB_TOKEN) return json({ error: "not_configured" }, 503);

    if (env.RATE_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return json({ error: "rate_limited" }, 429);
    }

    const len = Number(request.headers.get("Content-Length") || 0);
    if (len > MAX_PNG_BYTES * 1.4 + 4096) return json({ error: "too_large" }, 413);

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400); }

    const sub = validateSubmission(body);
    if (sub.error) return json({ error: sub.error }, sub.error === "too_large" ? 413 : 400);

    const profile = await lookupPlayer(sub.name);
    if (profile.missing) return json({ error: "unknown_player" }, 400);

    try {
      const result = await submitCard(env, sub, profile);
      return json({ ok: true, status: "pending_review", ...result });
    } catch (e) {
      console.error("submit failed", e && e.message);
      return json({ error: "github_failed" }, 502);
    }
  },
};
