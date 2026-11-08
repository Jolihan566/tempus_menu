#!/usr/bin/env python3
"""Rebuild player_cards/cards.json from the PNGs and their optional meta files.

Run from the repo root:  python tools/build_cards_index.py
The GitHub Action runs it on every push to main that touches player_cards/.

Each card is player_cards/<slug>_card.png, with optional
player_cards/meta/<slug>.json  {name, uuid, fav, bio, updated, hidden}.
Cards with "hidden": true are left out of the index (the PNG stays in the repo).
"""
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CARDS = ROOT / "player_cards"
META = CARDS / "meta"
OUT = CARDS / "cards.json"


def git_date(path: pathlib.Path) -> str:
    """Last commit date of a file, so cards without meta still get a date."""
    try:
        out = subprocess.run(
            ["git", "log", "-1", "--format=%cI", "--", str(path.relative_to(ROOT))],
            cwd=ROOT, capture_output=True, text=True, check=True,
        ).stdout.strip()
        return out or ""
    except Exception:
        return ""


def main() -> int:
    cards = []
    for png in sorted(CARDS.glob("*_card.png")):
        slug = png.name[: -len("_card.png")]
        meta = {}
        meta_file = META / f"{slug}.json"
        if meta_file.exists():
            try:
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
            except json.JSONDecodeError as e:
                print(f"warning: bad meta {meta_file.name}: {e}", file=sys.stderr)
        if meta.get("hidden"):
            continue
        cards.append({
            "slug": slug,
            "name": meta.get("name") or slug,
            "uuid": meta.get("uuid") or "",
            "fav": meta.get("fav") or "",
            "bio": meta.get("bio") or "",
            "updated": meta.get("updated") or git_date(png),
            "image": f"player_cards/{png.name}",
        })

    cards.sort(key=lambda c: c["updated"], reverse=True)
    data = {"version": 1, "count": len(cards), "cards": cards}
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    if OUT.exists() and OUT.read_text(encoding="utf-8") == text:
        print(f"cards.json unchanged ({len(cards)} cards)")
        return 0
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote cards.json ({len(cards)} cards)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
