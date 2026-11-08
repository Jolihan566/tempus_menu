# Tempus card uploads (no player tokens)

Players' menus send their Trainer Card to this Cloudflare Worker. The Worker is
the only thing holding a GitHub token, and every card arrives as a **pull
request** you approve. Nothing appears in the gallery until you merge it.

```
menu (index.html / trainer_database.html)
   └─ POST card PNG + name ─► Worker ─► PR "Trainer card: <name>" on tempus_menu
                                           └─ you merge ─► Action rebuilds cards.json ─► gallery
```

What it checks before opening a PR:
- name is a real Minecraft account (Mojang lookup; the PR shows the UUID)
- the image really is a PNG and is under 1.5 MB
- favourite ≤ 30 chars, bio ≤ 240 chars
- 5 submissions per minute per IP

A player who resubmits gets their existing PR updated, not a new one.

## One-time setup (≈10 minutes, free)

### 1. Make the GitHub token
GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token
- Repository access: **Only select repositories → tempus_menu**
- Permissions: **Contents: Read and write**, **Pull requests: Read and write**
- Expiry: pick the longest you're comfortable with and put a calendar reminder for it.
  When it expires, uploads fail with `github_failed` until you run step 3 again.

### 2. Make a free Cloudflare account
https://dash.cloudflare.com/sign-up (no card needed for Workers' free plan).

### 3. Deploy (from this `worker` folder, needs Node 18+)
```
npx wrangler login
npx wrangler secret put GITHUB_TOKEN      (paste the token from step 1)
npx wrangler deploy
```
The deploy prints a URL like `https://tempus-cards.<your-name>.workers.dev`.
Open `<that URL>/health` — it should show `{"ok":true}`.

If the deploy complains about `[[ratelimits]]`, delete that block from
`wrangler.toml` and deploy again.

### 4. Point the menus at it
In `config/fancymenu/assets/tempus_cards.js`, set:
```js
cardApi: "https://tempus-cards.<your-name>.workers.dev",
```
Ship that file with the next pack update.

## Day to day
- **Approve:** merge the PR. The *Build cards index* Action updates `player_cards/cards.json`, and the card shows up within ~5 minutes (GitHub's raw-file cache).
- **Reject:** close the PR (and delete the branch).
- **Hide a live card:** set `"hidden": true` in `player_cards/meta/<name>.json` and commit.
- **Remove a card:** delete its PNG and meta file.

## Test locally without deploying
```
node test.mjs
```
Fakes GitHub and Mojang, so it needs no token or network.

## Old tokens
Revoke every token you handed out through Discord tickets (GitHub → Settings →
Developer settings → tokens). The new menus no longer read them and clear any
stored copy on load.
