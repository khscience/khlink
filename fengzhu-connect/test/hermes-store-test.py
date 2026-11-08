"""Read-only integration tests against a synthetic Hermes state database."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

HELPER = Path(__file__).resolve().parents[1] / "src" / "backends" / "hermes-store.py"


class HermesStoreTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = os.path.join(self.temp.name, "state.db")
        self.conn = sqlite3.connect(self.db)
        self.addCleanup(self.conn.close)
        self.conn.executescript("""
          CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, title TEXT,
            message_count INTEGER, started_at REAL, ended_at REAL, end_reason TEXT,
            last_activity_at REAL, parent_session_id TEXT);
          CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT,
            tool_calls TEXT, timestamp REAL);
          CREATE TABLE runtime_epoch (epoch INTEGER);
          INSERT INTO runtime_epoch VALUES (2);
          CREATE TABLE session_admissions (seq INTEGER PRIMARY KEY,
            target_session_id TEXT, status TEXT, owner_epoch INTEGER, outcome TEXT, generation INTEGER);
          CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT);
          INSERT INTO sessions VALUES ('root','local','长任务',1,100,NULL,NULL,200,NULL);
          INSERT INTO sessions VALUES ('other','local','另一任务',1,100,NULL,NULL,150,NULL);
          INSERT INTO messages VALUES (10,'root','assistant','[{"id":"tool"}]',200);
          INSERT INTO messages VALUES (11,'other','assistant',NULL,150);
          INSERT INTO session_admissions VALUES (1,'root','started',2,NULL,1);
        """)
        self.conn.commit()

    def list_sessions(self):
        env = dict(os.environ, HERMES_HOME=self.temp.name)
        output = subprocess.check_output([sys.executable, str(HELPER), "list"], env=env, text=True, encoding="utf-8")
        return {row["id"]: row for row in json.loads(output)["sessions"]}

    def messages(self, root, after=0, limit=400):
        env = dict(os.environ, HERMES_HOME=self.temp.name)
        output = subprocess.check_output(
            [sys.executable, str(HELPER), "messages", root, str(after), str(limit)],
            env=env, text=True, encoding="utf-8")
        return json.loads(output)

    def add_reset_and_compression(self):
        self.conn.execute("UPDATE sessions SET end_reason='session_reset', ended_at=210 WHERE id='root'")
        self.conn.execute("INSERT INTO sessions VALUES ('reset-child','local',NULL,1,211,220,'compression',230,'root')")
        self.conn.execute("INSERT INTO sessions VALUES ('compressed-child','local',NULL,1,231,NULL,NULL,240,'reset-child')")
        self.conn.execute("INSERT INTO sessions VALUES ('other-child','local',NULL,1,241,NULL,NULL,250,'root')")
        self.conn.execute("INSERT INTO messages VALUES (12,'reset-child','user',NULL,230)")
        self.conn.execute("INSERT INTO messages VALUES (13,'compressed-child','assistant',NULL,240)")
        self.conn.execute("INSERT INTO messages VALUES (14,'other-child','assistant',NULL,250)")
        self.conn.execute("UPDATE session_admissions SET target_session_id='compressed-child'")
        self.conn.commit()

    def set_reset_receipt(self, owner, lineage, key=None):
        self.conn.execute("INSERT OR REPLACE INTO state_meta VALUES (?,?)",
                          (key or "gateway.local_policy.v1:" + owner,
                           json.dumps({"session_id": owner, "lineage": lineage})))
        self.conn.commit()

    def test_quiet_started_turn_and_terminal_are_isolated(self):
        rows = self.list_sessions()
        self.assertEqual(rows["root"]["execution_state"], "running")
        self.assertEqual(rows["root"]["last_message"]["timestamp"], 200)
        self.assertEqual(rows["other"]["execution_state"], "idle")
        self.conn.execute("UPDATE session_admissions SET status='terminal',outcome='interrupted' WHERE seq=1")
        self.conn.commit()
        result = self.list_sessions()["root"]
        self.assertEqual(result["execution_state"], "idle")
        self.assertEqual(result["execution_outcome"], "interrupted")
        self.conn.execute("INSERT INTO session_admissions VALUES (2,'root','terminal',2,'cancelled',NULL)")
        self.conn.commit()
        self.assertEqual(self.list_sessions()["root"]["execution_outcome"], "interrupted", "a cancelled queued input did not end the turn")

    def test_old_epoch_and_unknown_never_become_completion(self):
        self.conn.execute("UPDATE runtime_epoch SET epoch=3")
        self.conn.commit()
        self.assertEqual(self.list_sessions()["root"]["execution_state"], "unknown")
        self.conn.execute("UPDATE session_admissions SET status='unknown'")
        self.conn.commit()
        self.assertEqual(self.list_sessions()["root"]["execution_state"], "unknown")

    def test_queued_and_unknown_precedence(self):
        self.conn.execute("UPDATE session_admissions SET status='queued'")
        self.conn.commit()
        self.assertEqual(self.list_sessions()["root"]["execution_state"], "queued")
        self.conn.execute("INSERT INTO session_admissions VALUES (2,'root','started',2,NULL,1)")
        self.conn.commit()
        self.assertEqual(self.list_sessions()["root"]["execution_state"], "running")
        self.conn.execute("INSERT INTO session_admissions VALUES (3,'root','unknown',2,NULL,1)")
        self.conn.commit()
        self.assertEqual(self.list_sessions()["root"]["execution_state"], "unknown")

    def test_compression_child_is_attributed_to_visible_root(self):
        self.conn.execute("UPDATE sessions SET end_reason='compression', ended_at=210 WHERE id='root'")
        self.conn.execute("INSERT INTO sessions VALUES ('child','local',NULL,1,211,NULL,NULL,300,'root')")
        self.conn.execute("INSERT INTO messages VALUES (12,'child','assistant','[{\"id\":\"tool\"}]',300)")
        self.conn.execute("UPDATE session_admissions SET target_session_id='child'")
        self.conn.commit()
        rows = self.list_sessions()
        self.assertNotIn("child", rows)
        self.assertEqual(rows["root"]["execution_state"], "running")
        self.assertEqual(rows["root"]["last_message"]["timestamp"], 300)

    def test_explicit_reset_child_and_later_compression_keep_one_history(self):
        self.add_reset_and_compression()
        self.set_reset_receipt("root", ["root", "reset-child", "compressed-child"])
        rows = self.list_sessions()
        self.assertEqual(rows["root"]["message_count"], 3)
        self.assertEqual(rows["root"]["max_message_id"], 13)
        self.assertEqual(rows["root"]["execution_state"], "running")
        self.assertNotIn("reset-child", rows)
        self.assertNotIn("other-child", rows)
        result = self.messages("root", after=10)
        self.assertEqual([r["id"] for r in result["messages"]], [12, 13])
        self.assertEqual([r["id"] for r in self.messages("root", after=12, limit=1)["messages"]], [13])
        self.assertNotIn("other-child", result["segments"])

    def test_reopened_reset_parent_keeps_only_canonical_continuation(self):
        self.add_reset_and_compression()
        self.conn.execute("UPDATE sessions SET end_reason='ws_orphan_reap' WHERE id='root'")
        self.conn.commit()
        self.set_reset_receipt("root", ["root", "reset-child", "compressed-child"])
        row = self.list_sessions()["root"]
        self.assertEqual(set(row["segments"]), {"root", "reset-child", "compressed-child"})
        self.assertEqual(row["execution_state"], "running")
        self.assertEqual(row["max_message_id"], 13)
        self.assertEqual([r["id"] for r in self.messages("root", after=10)["messages"]], [12, 13])

    def test_reopened_parent_without_matching_receipt_is_not_merged(self):
        self.add_reset_and_compression()
        self.conn.execute("UPDATE sessions SET end_reason='ws_orphan_reap' WHERE id='root'")
        self.conn.commit()
        self.set_reset_receipt("other", ["other", "reset-child"])
        self.assertEqual(self.messages("root")["segments"], ["root"])
        self.assertEqual(self.list_sessions()["root"]["max_message_id"], 10)

    def test_unexpired_turn_lease_tracks_quiet_external_turn(self):
        self.add_reset_and_compression()
        self.set_reset_receipt("root", ["root", "reset-child", "compressed-child"])
        self.conn.execute("UPDATE session_admissions SET status='terminal',outcome='completed'")
        self.conn.execute("CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL)")
        self.conn.execute("INSERT INTO session_turn_leases VALUES (?, ?)", ("compressed-child", time.time() + 300))
        self.conn.commit()
        self.assertEqual(self.list_sessions()["root"]["execution_state"], "running")
        self.conn.execute("UPDATE session_turn_leases SET expires_at=?", (time.time() - 1,))
        self.conn.commit()
        self.assertEqual(self.list_sessions()["root"]["execution_state"], "idle")

    def test_lease_only_store_and_unrelated_lease(self):
        self.conn.execute("DROP TABLE session_admissions")
        self.conn.execute("CREATE TABLE session_turn_leases (conversation_id TEXT, expires_at REAL)")
        self.conn.execute("INSERT INTO session_turn_leases VALUES (?, ?)", ("other", time.time() + 300))
        self.conn.commit()
        rows = self.list_sessions()
        self.assertEqual(rows["root"]["execution_state"], "idle")
        self.assertEqual(rows["other"]["execution_state"], "running")

    def test_old_parent_outcome_does_not_end_a_later_continuation(self):
        self.add_reset_and_compression()
        self.set_reset_receipt("root", ["root", "reset-child", "compressed-child"])
        self.conn.execute("UPDATE session_admissions SET target_session_id='root',status='terminal',outcome='failed'")
        self.conn.commit()
        row = self.list_sessions()["root"]
        self.assertEqual(row["execution_state"], "idle")
        self.assertNotIn("execution_outcome", row)

    def test_compression_parent_outcome_still_applies_to_child(self):
        self.conn.execute("UPDATE sessions SET end_reason='compression', ended_at=210 WHERE id='root'")
        self.conn.execute("INSERT INTO sessions VALUES ('child','local',NULL,1,211,NULL,NULL,300,'root')")
        self.conn.execute("INSERT INTO messages VALUES (12,'child','assistant',NULL,300)")
        self.conn.execute("UPDATE session_admissions SET status='terminal',outcome='interrupted' WHERE seq=1")
        self.conn.commit()
        row = self.list_sessions()["root"]
        self.assertEqual(row["execution_state"], "idle")
        self.assertEqual(row["execution_outcome"], "interrupted")

    def test_unapproved_reset_and_delegated_branch_are_never_merged(self):
        self.add_reset_and_compression()
        self.set_reset_receipt("other", ["other", "reset-child"])
        rows = self.list_sessions()
        self.assertEqual(rows["root"]["message_count"], 1)
        self.assertEqual([r["id"] for r in self.messages("root", after=10)["messages"]], [])
        self.assertEqual(self.messages("root")["segments"], ["root"])

    def test_missing_or_malformed_receipts_preserve_old_behavior(self):
        self.add_reset_and_compression()
        for content in (None, "{", '{}',
                        '{"session_id":"root","lineage":["root",null]}',
                        json.dumps({"session_id": "root", "lineage": ["root", "x" * 131073]})):
            self.conn.execute("DELETE FROM state_meta")
            if content is not None:
                self.conn.execute("INSERT INTO state_meta VALUES (?,?)", ("gateway.local_policy.v1:root", content))
            self.conn.commit()
            self.assertEqual(self.messages("root")["segments"], ["root"])
            self.assertEqual(self.list_sessions()["root"]["max_message_id"], 10)
        self.conn.execute("DROP TABLE state_meta")
        self.conn.commit()
        self.assertEqual(self.messages("root")["segments"], ["root"])

    def test_receipt_key_and_owner_must_match(self):
        self.add_reset_and_compression()
        self.set_reset_receipt("root", ["root", "reset-child"], key="gateway.local_policy.v1:other")
        self.assertEqual(self.messages("root")["segments"], ["root"])

    def test_explicit_pair_does_not_merge_a_non_reset_branch(self):
        self.conn.execute("INSERT INTO sessions VALUES ('delegated','local',NULL,1,211,NULL,NULL,230,'root')")
        self.conn.execute("INSERT INTO messages VALUES (12,'delegated','assistant',NULL,230)")
        self.conn.commit()
        self.set_reset_receipt("root", ["root", "delegated"])
        self.assertEqual(self.messages("root")["segments"], ["root"])
        self.assertEqual(self.list_sessions()["root"]["max_message_id"], 10)

    def test_older_store_has_no_execution_field(self):
        self.conn.execute("DROP TABLE session_admissions")
        self.conn.commit()
        self.assertNotIn("execution_state", self.list_sessions()["root"])


if __name__ == "__main__":
    unittest.main()
