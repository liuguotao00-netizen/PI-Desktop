"""Validate the Nebula Spectrum plugin against a local mirror of the host rules.

Mirrors: manifest validation, theme contribution validation, and the theme CSS
sanitizer (comments masked, no @import / markup / script expressions / foreign
url(), 256 KB cap). Every contributed theme is checked.
Run: python validate_theme.py <plugin-dir>
"""

import json
import os
import re
import sys

root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ["PI_SCRATCH_DIR"], "nebula-spectrum")
man_path = os.path.join(root, "manifest.json")
manifest = json.load(open(man_path, encoding="utf-8"))

problems = []

# ---------------------------------------------------------------- manifest ---
if not re.fullmatch(r"[a-z0-9]+(\.[a-z0-9_-]+)+", manifest.get("id", "")):
    problems.append("manifest id must match ^[a-z0-9]+(\\.[a-z0-9_-]+)+$")
for key in ("schemaVersion", "id", "name", "version", "main"):
    if key not in manifest:
        problems.append(f"manifest missing {key}")
if not os.path.isfile(os.path.join(root, manifest.get("main", ""))):
    problems.append("manifest main entry file does not exist")

KNOWN_PERMISSIONS = {
    "ui.panel", "ui.view", "ui.microphone", "ui.theme", "ui.settings",
    "ui.window.appearance", "clipboard.read", "clipboard.write", "notify",
    "fs.read", "fs.write", "fs.delete",
}
for perm in manifest.get("permissions", []):
    if perm not in KNOWN_PERMISSIONS:
        problems.append(f"unknown permission {perm}")

themes = manifest.get("contributes", {}).get("themes", [])
if not themes:
    problems.append("no contributes.themes entry")
seen_ids = set()
for theme in themes:
    tid = theme.get("id", "")
    if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]{0,63}", tid):
        problems.append(f"invalid theme id {tid!r}")
    if tid in seen_ids:
        problems.append(f"duplicate theme id {tid!r}")
    seen_ids.add(tid)
    theme_path = theme.get("path", "")
    if not theme_path.endswith(".css"):
        problems.append(f"theme {tid}: path must be a .css file")
    if theme_path.startswith(("/", "\\")) or ".." in theme_path:
        problems.append(f"theme {tid}: path must stay inside the plugin")
    if not os.path.isfile(os.path.join(root, theme_path)):
        problems.append(f"theme {tid}: css file not found")
    if theme.get("base") not in ("light", "dark"):
        problems.append(f"theme {tid}: base must be 'light' or 'dark'")
    if theme.get("assets"):
        problems.append(f"theme {tid}: assets must be absolute paths, none expected here")

if manifest.get("contributes", {}).get("windowAppearance") is not None and \
        "ui.window.appearance" not in manifest.get("permissions", []):
    problems.append("contributes.windowAppearance requires the ui.window.appearance permission")


# --------------------------------------------------------------- theme css ---
def check_css(theme_path, theme_id):
    css_path = os.path.join(root, theme_path)
    raw = open(css_path, "rb").read()
    css = raw.decode("utf-8")

    # The host masks comments before running these checks, so do the same.
    code_only = re.sub(r"/\*.*?\*/", lambda m: " " * len(m.group(0)), css, flags=re.S)

    local = []
    if len(raw) > 256 * 1024:
        local.append(f"{theme_path}: css exceeds 256 KB ({len(raw)} bytes)")
    if not code_only.strip():
        local.append(f"{theme_path}: css is empty")
    for pattern, message in (
        (r"@import\b", "may not use @import"),
        (r"<\s*/?\s*style", "may not contain markup"),
        (r"<!--", "may not contain markup"),
        (r"javascript\s*:", "may not contain script expressions"),
        (r"expression\s*\(", "may not contain script expressions"),
    ):
        if re.search(pattern, code_only, re.I):
            local.append(f"{theme_path}: {message}")
    for match in re.finditer(r"url\(\s*(['\"]?)([^'\")]*)\1\s*\)", code_only, re.I):
        if not match.group(2).strip().lower().startswith("data:"):
            local.append(f"{theme_path}: url() must be data: or a declared asset (found {match.group(2)!r})")
    if code_only.count("url(") != len(re.findall(r"url\(\s*(['\"]?)([^'\")]*)\1\s*\)", code_only, re.I)):
        local.append(f"{theme_path}: contains a malformed url() reference")

    depth = 0
    for index, ch in enumerate(code_only):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth < 0:
                local.append(f"{theme_path}: unbalanced closing brace at offset {index}")
                break
    if depth != 0:
        local.append(f"{theme_path}: unbalanced braces (open depth {depth})")

    expected = f':root[data-theme][data-plugin-theme="{theme_id}"]'
    selectors = [m.group(1).strip() for m in re.finditer(r"([^{}]+)\{", code_only)]
    for selector in selectors:
        for part in [p.strip() for p in selector.split(",")]:
            if not part.startswith(expected):
                local.append(f"{theme_path}: unscoped selector (would leak into other themes): {part[:80]}")

    # Declarations must each end with ';' or be the last one in the block.
    for block in re.finditer(r"\{([^{}]*)\}", code_only):
        body = block.group(1).strip()
        if not body:
            local.append(f"{theme_path}: empty declaration block")
            continue
        if not body.endswith(";"):
            local.append(f"{theme_path}: declaration block does not end with ';': {body[-40:]!r}")

    print(f"css      : {theme_path} — {len(raw)} bytes, {len(selectors)} rule blocks, theme id {theme_id}")
    return local


for theme in themes:
    if not theme.get("path") or not os.path.isfile(os.path.join(root, theme.get("path", ""))):
        continue
    problems.extend(check_css(theme["path"], f'plugin:{manifest["id"]}:{theme["id"]}'))

print(f"plugin   : {root}")
print(f"themes   : {', '.join(t.get('id', '?') + ' (' + t.get('base', '?') + ')' for t in themes)}")
if problems:
    print("PROBLEMS:")
    for problem in problems:
        print("  -", problem)
    sys.exit(1)
print("OK       : manifest and every theme CSS pass the local mirror of the host rules")
