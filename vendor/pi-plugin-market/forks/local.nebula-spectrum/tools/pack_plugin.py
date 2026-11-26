"""Pack the theme plugin into a .piplug the way PluginPack does.

Verified against dist/local.nebula-spectrum-0.5.0.piplug: a plain ZIP with
compress_type = STORED (0), entries sorted by name, no directory entries,
no archive comment, manifest.json at the root. The plugin centre rejects
packages produced by a compressing ZIP tool.
"""

import hashlib
import json
import pathlib
import zipfile

PLUGIN_DIR = pathlib.Path(r"D:\AgentWorkSpace\PiAgent\Customeize theme\nebula-spectrum")
SKIP_DIRS = {".git", "node_modules", "dist"}

manifest = json.loads((PLUGIN_DIR / "manifest.json").read_text(encoding="utf-8"))
version = manifest["version"]
plug_id = manifest["id"]
out_dir = PLUGIN_DIR / "dist"
out_dir.mkdir(exist_ok=True)
out_path = out_dir / f"{plug_id}-{version}.piplug"

files = []
for path in PLUGIN_DIR.rglob("*"):
    if not path.is_file():
        continue
    rel = path.relative_to(PLUGIN_DIR)
    if rel.parts[0] in SKIP_DIRS:
        continue
    files.append((rel.as_posix(), path))
files.sort()

with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_STORED, allowZip64=False) as zf:
    for name, path in files:
        info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_STORED
        info.create_system = 0
        info.external_attr = 0
        zf.writestr(info, path.read_bytes())

digest = hashlib.sha256(out_path.read_bytes()).hexdigest()
print("package  :", out_path)
print("entries  :", len(files))
for name, _ in files:
    print("   -", name)
print("sizeBytes:", out_path.stat().st_size)
print("sha256   :", digest)

with zipfile.ZipFile(out_path) as zf:
    bad = [i.filename for i in zf.infolist() if i.compress_type != zipfile.ZIP_STORED]
    print("non-stored entries:", bad or "none")
    print("manifest at root:", "manifest.json" in zf.namelist())
