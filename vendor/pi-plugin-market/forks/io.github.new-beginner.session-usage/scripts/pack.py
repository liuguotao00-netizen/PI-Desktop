#!/usr/bin/env python3
"""Pack the plugin root into dist/<id>-<version>.piplug (store-compressed zip)."""

from __future__ import annotations

import hashlib
import json
import struct
import sys
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAX_PACKAGE_BYTES = 50 * 1024 * 1024
# Only reviewed runtime files may enter an installable archive. Never glob the
# workspace: Git ignores do not protect a packer from local credentials.
PACKAGE_FILES = (
    "LICENSE", "README.md", "main.js", "manifest.json",
    "renderer/index.html", "renderer/session-context.mjs",
)


def crc32(data: bytes) -> int:
    return zlib.crc32(data) & 0xFFFFFFFF


def make_zip(files: list[tuple[str, bytes]]) -> bytes:
    out = bytearray()
    central = bytearray()
    offset = 0
    for name, data in files:
        name_b = name.encode("utf-8")
        c = crc32(data)
        local = bytearray()
        local += struct.pack(
            "<IHHHHHIIIHH",
            0x04034B50,
            20,
            0,
            0,
            0,
            0,
            c,
            len(data),
            len(data),
            len(name_b),
            0,
        )
        local += name_b
        local += data
        out += local
        cen = bytearray()
        cen += struct.pack(
            "<IHHHHHHIIIHHHHHII",
            0x02014B50,
            20,
            20,
            0,
            0,
            0,
            0,
            c,
            len(data),
            len(data),
            len(name_b),
            0,
            0,
            0,
            0,
            0,
            offset,
        )
        cen += name_b
        central += cen
        offset += len(local)
    central_offset = len(out)
    out += central
    count = len(files)
    out += struct.pack(
        "<IHHHHIIH",
        0x06054B50,
        0,
        0,
        count,
        count,
        len(central),
        central_offset,
        0,
    )
    return bytes(out)


def collect_files(src: Path) -> list[tuple[str, bytes]]:
    files: list[tuple[str, bytes]] = []
    root = src.resolve()
    for rel in sorted(PACKAGE_FILES):
        path = src / rel
        parts = Path(rel).parts
        if any((src.joinpath(*parts[:index])).is_symlink()
               for index in range(1, len(parts) + 1)):
            raise SystemExit(f"symlink is not allowed in a plugin: {rel}")
        try:
            path.resolve().relative_to(root)
        except ValueError:
            raise SystemExit(f"unsafe plugin path: {rel}") from None
        if not path.is_file():
            raise SystemExit(f"required runtime file missing: {rel}")
        files.append((rel, path.read_bytes()))
    return files


def main() -> int:
    manifest_path = ROOT / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"invalid manifest.json: {error}") from error
    plugin_id = manifest.get("id")
    version = manifest.get("version")
    if not isinstance(plugin_id, str) or not plugin_id.strip() or any(ch in plugin_id for ch in "/\\"):
        raise SystemExit(f"manifest id is not a safe filename component: {plugin_id}")
    if not isinstance(version, str) or not version.strip() or any(ch in version for ch in "/\\") or version in {".", ".."}:
        raise SystemExit(f"manifest version is not a safe filename component: {version}")
    blob = make_zip(collect_files(ROOT))
    if len(blob) > MAX_PACKAGE_BYTES:
        raise SystemExit(f"package exceeds {MAX_PACKAGE_BYTES} byte limit: {len(blob)}")
    out_dir = ROOT / "dist"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{plugin_id}-{version}.piplug"
    out.write_bytes(blob)
    print(out)
    print("sha256", hashlib.sha256(blob).hexdigest())
    print("size", len(blob))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
