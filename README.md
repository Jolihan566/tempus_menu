# tempus_menu

Live data for the TempusMMO FancyMenu pages (`config/fancymenu/assets/*.html`).
The pages read these files from `raw.githubusercontent.com`, so editing a file
here changes every player's menu within ~5 minutes, with no pack update.

| File | Read by | What it is |
|---|---|---|
| `news.json` | title screen ticker | `[{ "text", "tag"?, "date"? }]` — newest first |
| `status.json` | (ready for the event banner) | active event, season, MOTD |
| `events.json` | (ready for the calendar) | recurring + one-off events, times in `timezone` |
| `leaderboards.json` | (ready for Hall of Fame) | boards of `{ name, value }` entries |
| `player_cards/cards.json` | Trainer Database | **generated** — don't edit by hand |
| `player_cards/*_card.png` | Trainer Database | card images |
| `player_cards/meta/*.json` | index builder | per-card `{ name, uuid, fav, bio, updated, hidden }` |
| `tutorials/tutorials.json` | Field Guide | categories → entries → images |
| `menu_images/` | all pages | `logo.png`, event backgrounds |
| `newsfeed.txt` | nothing yet | long-form post; kept for a future patch-notes tab |

Page text is inserted as plain text, so HTML in these files is shown, not run.

## Player cards
Players submit cards from the menu → the card Worker (`worker/`) opens a pull
request → you merge → the *Build cards index* Action regenerates `cards.json`.
No player ever holds a GitHub token. Setup and moderation: `worker/README.md`.

## Tools
- `python tools/build_cards_index.py` — rebuild `cards.json` locally (the Action does this for you).
- `python tools/compress_images.py` — shrink new Field Guide screenshots (needs Pillow).
