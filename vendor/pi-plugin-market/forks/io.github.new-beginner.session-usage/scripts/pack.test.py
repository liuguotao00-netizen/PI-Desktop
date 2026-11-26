#!/usr/bin/env python3
"""Test publication file selection using synthetic files, never real secrets."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pack


class PublicationPrivacyTests(unittest.TestCase):
    def setUp(self):
        scratch = os.environ.get("PI_SCRATCH_DIR")
        if not scratch:
            self.fail("Set PI_SCRATCH_DIR to a temporary directory before testing")
        Path(scratch).mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(prefix="publication-privacy-", dir=scratch)
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name in pack.PACKAGE_FILES:
            self.write(name, "synthetic runtime fixture")

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def test_only_reviewed_runtime_files_are_selected(self):
        for name in (".env", "private.token", "credentials.json", "secrets.json",
                     "settings.json", "pi.sqlite", "sessions/private.jsonl",
                     "session-message-outbox.json", ".pi/goal/task.md",
                     "docs/verification-private.md", "output/private.png",
                     "renderer/unreviewed.js", "node_modules/example/index.js"):
            self.write(name, "synthetic excluded fixture")
        files = pack.collect_files(self.root)
        self.assertEqual([name for name, _ in files], sorted(pack.PACKAGE_FILES))
        self.assertEqual(len(files), 6)
        self.assertTrue(all(data == b"synthetic runtime fixture" for _, data in files))

    def test_missing_runtime_file_aborts(self):
        for name in pack.PACKAGE_FILES:
            with self.subTest(name=name):
                (self.root / name).unlink()
                with self.assertRaisesRegex(SystemExit, "required runtime file missing"):
                    pack.collect_files(self.root)
                self.write(name, "synthetic runtime fixture")

    def test_symbolic_links_in_file_or_parent_are_rejected(self):
        # Simulate symlink metadata; no Windows symlink privileges are needed.
        original = Path.is_symlink
        for name in ("main.js", "renderer"):
            blocked = self.root / name
            with self.subTest(name=name):
                def is_symlink(path):
                    return path == blocked or original(path)
                with patch.object(Path, "is_symlink", is_symlink):
                    with self.assertRaisesRegex(SystemExit, "symlink is not allowed"):
                        pack.collect_files(self.root)


if __name__ == "__main__":
    unittest.main(verbosity=2)
