"""Bundle pinned Twemoji artwork and Unicode names for both clients (no runtime CDN)."""
from pathlib import Path
import hashlib
import io
import json
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
VERSION = "17.0.3"
URL = f"https://codeload.github.com/jdecked/twemoji/tar.gz/refs/tags/v{VERSION}"
raw = urllib.request.urlopen(URL, timeout=120).read()
emoji_test = urllib.request.urlopen("https://unicode.org/Public/17.0.0/emoji/emoji-test.txt", timeout=60).read()
web = ROOT / "web/public/emoji"
android = ROOT / "android/app/src/main/assets/emoji"
web.mkdir(parents=True, exist_ok=True)
android.mkdir(parents=True, exist_ok=True)
assets = {}
with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
    for member in archive.getmembers():
        parts = member.name.split("/")
        if len(parts) == 4 and parts[1:3] == ["assets", "72x72"] and parts[-1].endswith(".png"):
            assets[parts[-1][:-4]] = archive.extractfile(member).read()
        if len(parts) == 2 and parts[-1] == "LICENSE-GRAPHICS":
            graphics = archive.extractfile(member).read()
            (ROOT / "LICENSES/Twemoji-graphics.txt").write_bytes(graphics)
            for target in (web, android):  # the licence travels with the artwork in both apps
                (target / "LICENSE-GRAPHICS.txt").write_bytes(graphics)
catalog = []
for line in emoji_test.decode("utf-8").splitlines():
    if "; fully-qualified" not in line:
        continue
    code, info = line.split(";", 1)
    points = code.strip().split()
    value = "".join(chr(int(point, 16)) for point in points)
    key = "-".join(point.lower().lstrip("0") or "0" for point in points)
    if key not in assets:
        key = "-".join(p for p in key.split("-") if p != "fe0f")
    if key not in assets:
        continue
    name = info.split("#", 1)[1].strip().split(" ", 2)[-1]
    catalog.append({"emoji": value, "name": name, "asset": key})
    for target in (web, android):
        (target / f"{key}.png").write_bytes(assets[key])
for target in (web, android):
    (target / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
(ROOT / "LICENSES/Twemoji-source.json").write_text(json.dumps({"version": VERSION, "source": URL, "sha256": hashlib.sha256(raw).hexdigest(), "unicodeSource": "https://unicode.org/Public/17.0.0/emoji/emoji-test.txt", "unicodeSha256": hashlib.sha256(emoji_test).hexdigest(), "entries": len(catalog)}, indent=2) + "\n", encoding="utf-8")
print(f"Bundled {len(catalog)} emoji entries, {len(set(e['asset'] for e in catalog))} artwork files per client")

