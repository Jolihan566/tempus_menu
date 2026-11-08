#!/usr/bin/env python3
"""Shrink large Field Guide screenshots and point tutorials.json at them.

Run from the repo root:  python tools/compress_images.py   (needs Pillow)

Any PNG in tutorials/tutorial_images over 400 KB gets a JPG copy (max 1600px
wide, quality 82), and tutorials.json is rewritten to use the JPG. The PNGs are
left in place so older pack versions keep working; delete them whenever.
Re-run it after adding new screenshots.
"""
import json
import pathlib
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
IMG_DIR = ROOT / "tutorials" / "tutorial_images"
DATA = ROOT / "tutorials" / "tutorials.json"
MAX_W, QUALITY, THRESHOLD = 1600, 82, 400_000


def main() -> int:
    renamed = {}
    for png in sorted(IMG_DIR.glob("*.png")):
        if png.stat().st_size <= THRESHOLD:
            continue
        jpg = png.with_suffix(".jpg")
        with Image.open(png) as im:
            im = im.convert("RGB")
            if im.width > MAX_W:
                im = im.resize((MAX_W, round(im.height * MAX_W / im.width)), Image.LANCZOS)
            im.save(jpg, "JPEG", quality=QUALITY, optimize=True, progressive=True)
        renamed[png.name] = jpg.name
        print(f"{png.name}: {png.stat().st_size//1024} KB -> {jpg.name}: {jpg.stat().st_size//1024} KB")

    if renamed:
        raw = DATA.read_text(encoding="utf-8")
        data = json.loads(raw)
        changed = 0
        for cat in data.get("categories", []):
            for entry in cat.get("entries", []):
                imgs = entry.get("images") or []
                new = [renamed.get(i, i) for i in imgs]
                if new != imgs:
                    entry["images"] = new
                    changed += 1
        DATA.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"tutorials.json: updated {changed} entries")
    return 0


if __name__ == "__main__":
    sys.exit(main())
