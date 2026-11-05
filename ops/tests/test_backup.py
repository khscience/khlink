"""Linux integration tests for the actual single-snapshot backup script.

Run: python3 ops/tests/test_backup.py
Uses synthetic SQLite data and TemporaryDirectory; never production paths.
"""
import fcntl
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "backup.sh"


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="khlink-backup-fixture-")
        self.root = Path(self.temp.name)
        self.source_dir = self.root / "source"
        self.source_dir.mkdir()
        self.source = self.source_dir / "fixture.db"
        self.dest = self.root / "backups"
        self.dest.mkdir()
        self.latest = self.dest / "bridge-latest.db"
        self.env = dict(os.environ, KH_LINK_BACKUP_SOURCE=str(self.source),
                        KH_LINK_BACKUP_DIR=str(self.dest))
        with sqlite3.connect(self.source) as db:
            db.execute("CREATE TABLE fixture(id INTEGER PRIMARY KEY, value TEXT)")
            db.execute("INSERT INTO fixture(value) VALUES('first')")

    def tearDown(self):
        self.temp.cleanup()

    def run_backup(self, env=None, script=SCRIPT):
        return subprocess.run(["/bin/sh", str(script)], env=env or self.env,
                              capture_output=True, text=True, timeout=15)

    def completed(self):
        return sorted(p.name for p in self.dest.glob("bridge-*.db"))

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.completed(), ["bridge-latest.db"])
        self.assertEqual(self.latest.stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(self.dest.glob(".bridge-latest.*")), [])
        with sqlite3.connect(f"file:{self.latest}?mode=ro", uri=True) as db:
            self.assertEqual(db.execute("PRAGMA quick_check").fetchone()[0], "ok")
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "delete")

    def test_success_replaces_and_retains_exactly_one(self):
        self.assert_success(self.run_backup())
        with sqlite3.connect(self.source) as db:
            db.execute("INSERT INTO fixture(value) VALUES('second')")
        self.assert_success(self.run_backup())
        with sqlite3.connect(f"file:{self.latest}?mode=ro", uri=True) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM fixture").fetchone()[0], 2)

    def test_prunes_only_old_backups_and_sidecars(self):
        for name in ("bridge-20260101-000000.db", "bridge-20260101-000000.db-wal",
                     "bridge-20260101-000000.db-shm", "bridge-20260101-000000.db-journal"):
            (self.dest / name).write_text("old fixture")
        (self.dest / "other-product.db").write_text("keep")
        nested = self.dest / "nested"
        nested.mkdir()
        (nested / "bridge-nested.db").write_text("keep")
        self.assert_success(self.run_backup())
        self.assertTrue((self.dest / "other-product.db").exists())
        self.assertTrue((nested / "bridge-nested.db").exists())
        self.assertFalse(any(self.dest.glob("bridge-*.db-*")))

    def test_corrupt_source_preserves_previous_good_snapshot(self):
        self.assert_success(self.run_backup())
        before = self.latest.read_bytes()
        old = self.dest / "bridge-20260101-000000.db"
        old.write_bytes(before)
        self.source.write_bytes(b"invalid synthetic sqlite database")
        result = self.run_backup()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.latest.read_bytes(), before)
        self.assertTrue(old.exists())
        self.assertEqual(list(self.dest.glob(".bridge-latest.*")), [])

    def test_failed_integrity_check_does_not_prune_or_replace(self):
        self.assert_success(self.run_backup())
        before = self.latest.read_bytes()
        old = self.dest / "bridge-20260101-000000.db"
        old.write_bytes(before)
        real_sqlite = shutil.which("sqlite3")
        stub_dir = self.root / "bin"
        stub_dir.mkdir()
        stub = stub_dir / "sqlite3"
        stub.write_text("#!/bin/sh\nfor arg do\n"
                        "  if [ \"$arg\" = 'PRAGMA quick_check;' ]; then echo 'simulated failed validation'; exit 0; fi\n"
                        "done\nexec \"$KH_TEST_REAL_SQLITE\" \"$@\"\n")
        stub.chmod(0o700)
        env = dict(self.env, PATH=str(stub_dir) + os.pathsep + self.env["PATH"],
                   KH_TEST_REAL_SQLITE=real_sqlite)
        result = self.run_backup(env)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.latest.read_bytes(), before)
        self.assertTrue(old.exists())
        self.assertEqual(list(self.dest.glob(".bridge-latest.*")), [])

    def test_concurrent_backup_does_not_modify_latest(self):
        self.assert_success(self.run_backup())
        before = self.latest.read_bytes()
        with open(self.dest / ".backup.lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_backup()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("already running", result.stderr)
        self.assertEqual(self.latest.read_bytes(), before)

    def test_source_directory_cannot_be_pruned(self):
        source_before = self.source.read_bytes()
        marker = self.source_dir / "bridge-real-source.db"
        marker.write_text("keep")
        result = self.run_backup(dict(self.env, KH_LINK_BACKUP_DIR=str(self.source_dir)))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.source.read_bytes(), source_before)
        self.assertTrue(marker.exists())

    def test_symlink_target_is_rejected(self):
        protected = self.root / "protected.db"
        protected.write_text("keep")
        self.latest.symlink_to(protected)
        result = self.run_backup()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(protected.read_text(), "keep")
        self.assertTrue(self.latest.is_symlink())

    def test_wal_source_produces_standalone_latest(self):
        with sqlite3.connect(self.source) as writer:
            writer.execute("PRAGMA journal_mode=WAL")
            writer.execute("INSERT INTO fixture(value) VALUES('wal content')")
            writer.commit()
            self.assert_success(self.run_backup())
            with sqlite3.connect(f"file:{self.latest}?mode=ro", uri=True) as reader:
                self.assertEqual(reader.execute("SELECT COUNT(*) FROM fixture").fetchone()[0], 2)
        self.assertFalse(any(self.dest.glob("bridge-latest.db-*")))

    def test_shell_entry_does_not_require_executable_permission(self):
        copied = self.root / "backup-noexec.sh"
        shutil.copyfile(SCRIPT, copied)
        copied.chmod(0o600)
        self.assert_success(self.run_backup(script=copied))
        unit = SCRIPT.with_name("fengzhu-agent-bridge-backup.service").read_text()
        self.assertIn("ExecStart=/bin/sh /opt/fengzhu-agent-bridge/ops/backup.sh", unit)


if __name__ == "__main__":
    unittest.main(verbosity=2)
