# Converts a classic .wsz skin for herdr-player: each sprite sheet becomes nearest-neighbour PNGs at 2x and 4x
# (Herdr smooths images it scales, so they're pre-scaled to the exact screen pixels: 1x and 2x on retina),
# plus manifest.json with sheet sizes, the visualizer palette and the playlist colours.
# Usage: python3 skin.py <skin.wsz> <out dir>
import json
import os
import re
import subprocess
import sys
import zipfile

SHEETS = ["main", "titlebar", "cbuttons", "shufrep", "posbar", "volume", "balance", "monoster",
          "playpaus", "numbers", "nums_ex", "text", "eqmain", "pledit"]

wsz, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
# Entries match case-insensitively on the file name alone: skins are often zipped one folder deep.
with zipfile.ZipFile(wsz) as z:
    entries = {os.path.basename(n).lower(): n for n in z.namelist() if not n.endswith("/")}
    def read(name):
        return z.read(entries[name]) if name in entries else None

    sheets = {}
    for name in SHEETS:
        data = read(name + ".bmp")
        if not data:
            continue
        src = os.path.join(out, name + ".src")
        open(src, "wb").write(data)  # ".bmp" files are sometimes PNG or JPEG: ffmpeg sniffs the content.
        size = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                               "-of", "csv=p=0", src], capture_output=True, text=True).stdout.strip().split(",")
        if len(size) != 2:
            continue
        for k in (2, 4):
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-vf", f"scale=iw*{k}:ih*{k}:flags=neighbor",
                            "-pix_fmt", "rgba", os.path.join(out, f"{name}@{k}.png")], check=True)
        os.remove(src)
        sheets[name] = {"w": int(size[0]), "h": int(size[1])}

    def text(name):
        data = read(name)
        return data.decode("latin-1") if data else ""

    # viscolor.txt: 24 lines of "r,g,b // comment".
    vis = [[int(x) for x in m] for m in re.findall(r"(\d+)\s*,\s*(\d+)\s*,\s*(\d+)", text("viscolor.txt"))][:24]
    # pledit.txt: [Text] Normal=#00FF00 Current=#FFFFFF NormalBG=#000000 SelectedBG=#0000FF Font=Arial
    pl = {k.lower(): v.strip() for k, v in re.findall(r"^\s*(\w+)\s*=\s*(.+?)\s*$", text("pledit.txt"), re.M)}

    # The visualizer's bar gradient (viscolor 2 at the top to 17 at the bottom) as a 3x16 sheet, so bars are images.
    if len(vis) >= 18:
        ppm = os.path.join(out, "visbar.ppm")
        open(ppm, "wb").write(b"P6 3 16 255\n" + b"".join(bytes(vis[2 + y]) * 3 for y in range(16)))
        for k in (2, 4):
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", ppm, "-vf", f"scale=iw*{k}:ih*{k}:flags=neighbor",
                            os.path.join(out, f"visbar@{k}.png")], check=True)
        os.remove(ppm)
        sheets["visbar"] = {"w": 3, "h": 16}

json.dump({"sheets": sheets, "viscolor": vis, "pledit": pl}, open(os.path.join(out, "manifest.json"), "w"))
print(json.dumps({"sheets": len(sheets)}))
