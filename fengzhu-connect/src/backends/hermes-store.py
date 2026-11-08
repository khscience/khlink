# khLink: read-only view of Hermes Agent's session store (~/.hermes/state.db).
# Run by the connector inside the Hermes host (WSL) as `python3 - <command> ...`
# with this file on stdin. Prints one JSON document. Never writes the database.
import json
import os
import sqlite3
import sys
import time

HOME = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
DB = os.path.join(HOME, "state.db")
CLIP = 64 * 1024
LIST_LIMIT = 200


def reset_continuations(conn):
    # A reset can be an intentional new conversation. Hermes records canonical
    # reset lineage in its local policy receipts; only adjacent, valid members
    # of that lineage may be folded back into the old chat. Extract only those
    # fields, not the rest of the policy, and tolerate older stores.
    prefix = "gateway.local_policy.v1:"
    if not {"key", "value"}.issubset(columns(conn, "state_meta")):
        return set()
    try:
        rows = conn.execute(
            "select key, json_extract(value, '$.session_id'), json_extract(value, '$.lineage') "
            "from state_meta where key glob ? and json_valid(value)", (prefix + "*",))
        result = set()
        for key, owner, encoded in rows:
            if not isinstance(owner, str) or not owner or key != prefix + owner:
                continue
            if not isinstance(encoded, str) or len(encoded) > 131072:
                continue
            try:
                lineage = json.loads(encoded)
            except (TypeError, ValueError):
                continue
            if (not isinstance(lineage, list) or not 1 < len(lineage) <= 1000
                    or lineage[0] != owner
                    or not all(isinstance(s, str) and 0 < len(s) <= 256 for s in lineage)):
                continue
            result.update(zip(lineage, lineage[1:]))
        return result
    except sqlite3.OperationalError:
        return set()


def is_continuation(parent, child, reason, reset_edges):
    # Reopening an old parent may replace its original session_reset reason
    # when that separate websocket is reaped. The canonical receipt and the
    # real parent edge are still required; an arbitrary branch stays separate.
    return reason in ("compression", "orphaned_compression") or (
        reason in ("session_reset", "ws_orphan_reap") and (parent, child) in reset_edges)


def connect():
    conn = sqlite3.connect("file:%s?mode=ro" % DB, uri=True, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


def columns(conn, table):
    return {row[1] for row in conn.execute("pragma table_info(%s)" % table)}


def pick(row, names):
    return {name: row[name] for name in names if name in row.keys()}


def lineage_root(conn, sid, cache, reset_edges):
    # A compressed chat continues in a child row; the conversation is its root.
    seen = []
    current = sid
    while current and current not in seen:
        if current in cache:
            current = cache[current]
            break
        seen.append(current)
        row = conn.execute("select parent_session_id from sessions where id=?", (current,)).fetchone()
        parent = row["parent_session_id"] if row else None
        if not parent:
            break
        prow = conn.execute("select end_reason from sessions where id=?", (parent,)).fetchone()
        if not prow or not is_continuation(parent, current, prow["end_reason"], reset_edges):
            break
        current = parent
    for item in seen:
        cache[item] = current
    return current


def lineage(conn, root, reset_edges):
    ids = [root]
    frontier = [root]
    while frontier:
        parent = frontier.pop()
        for row in conn.execute(
                "select s.id,p.end_reason from sessions s join sessions p on p.id=s.parent_session_id "
                "where s.parent_session_id=?", (parent,)):
            if row["id"] not in ids and is_continuation(parent, row["id"], row["end_reason"], reset_edges):
                ids.append(row["id"])
                frontier.append(row["id"])
    return ids


def execution_states(conn, session_ids):
    """Read gateway admissions and unexpired conversation turn leases.

    Newer gateways retain a started admission throughout a turn, including
    long tool calls that do not append messages. An old epoch or an unknown
    admission is deliberately not treated as either running or completed. A
    dashboard turn can hold a lease without an admission. An abandoned lease
    can remain visible until its TTL expires; its holder is never disclosed.
    """
    required = {"target_session_id", "status", "owner_epoch"}
    have_admissions = required.issubset(columns(conn, "session_admissions"))
    have_leases = {"conversation_id", "expires_at"}.issubset(columns(conn, "session_turn_leases"))
    if not have_admissions and not have_leases:
        return None
    epoch = None
    if have_admissions and "epoch" in columns(conn, "runtime_epoch"):
        row = conn.execute("select epoch from runtime_epoch limit 1").fetchone()
        epoch = row[0] if row else None
    states = {}
    ids = list(dict.fromkeys(session_ids))
    # Stay below SQLite's parameter limit even for stores with many segments.
    for start in range(0, len(ids), 400):
        batch = ids[start:start + 400]
        marks = ",".join("?" for _ in batch)
        if have_admissions:
            rows = conn.execute(
                "select target_session_id, status, owner_epoch from session_admissions "
                "where target_session_id in (%s) and status in ('queued','started','unknown')" % marks,
                batch)
            for row in rows:
                state = row["status"]
                if state == "started":
                    state = "running" if epoch is not None and row["owner_epoch"] == epoch else "unknown"
                states.setdefault(row["target_session_id"], set()).add(state)
        if have_leases:
            rows = conn.execute(
                "select conversation_id from session_turn_leases "
                "where conversation_id in (%s) and expires_at>?" % marks, batch + [time.time()])
            for row in rows:
                states.setdefault(row["conversation_id"], set()).add("running")
    return states


def merged_execution_state(states, segments):
    if states is None:
        return None
    combined = set().union(*(states.get(sid, set()) for sid in segments))
    if "unknown" in combined:
        return "unknown"
    if "running" in combined:
        return "running"
    if "queued" in combined:
        return "queued"
    return "idle"


def terminal_outcomes(conn, session_ids):
    """Latest explicit gateway outcome per session, excluding queued-only inputs."""
    required = {"target_session_id", "status", "seq", "outcome", "generation"}
    if not required.issubset(columns(conn, "session_admissions")):
        return {}
    result = {}
    ids = list(dict.fromkeys(session_ids))
    for start in range(0, len(ids), 400):
        batch = ids[start:start + 400]
        marks = ",".join("?" for _ in batch)
        rows = conn.execute(
            "select a.target_session_id, a.seq, a.outcome from session_admissions a join ("
            "select target_session_id, max(seq) as seq from session_admissions "
            "where target_session_id in (%s) and status='terminal' and generation is not null "
            "group by target_session_id) latest on a.seq=latest.seq" % marks, batch)
        for row in rows:
            result[row["target_session_id"]] = (row["seq"], row["outcome"])
    return result


def applicable_outcome(conn, outcomes, session_id):
    # A turn may compress into children, but a reset starts a new turn. Follow
    # only compression ancestors so an old reset parent's outcome cannot end
    # a newer dashboard turn while interrupted compressed turns still match.
    seen = set()
    relevant = []
    current = session_id
    while current and current not in seen:
        seen.add(current)
        if current in outcomes:
            relevant.append(outcomes[current])
        row = conn.execute(
            "select s.parent_session_id, p.end_reason from sessions s "
            "left join sessions p on p.id=s.parent_session_id where s.id=?", (current,)).fetchone()
        if not row or row["end_reason"] not in ("compression", "orphaned_compression"):
            break
        current = row["parent_session_id"]
    return max(relevant, key=lambda item: item[0])[1] if relevant else None


def cmd_list():
    conn = connect()
    # Session rows, messages and admissions must describe one SQLite snapshot.
    conn.execute("begin")
    reset_edges = reset_continuations(conn)
    have = columns(conn, "sessions")
    wanted = ["id", "source", "title", "message_count", "started_at", "ended_at", "end_reason",
              "last_activity_at", "parent_session_id", "pinned", "archived", "hidden", "model", "cwd",
              "transcript_revision", "profile_name", "tool_call_count"]
    cols = [c for c in wanted if c in have]
    rows = conn.execute(
        "select %s from sessions order by coalesce(last_activity_at, started_at) desc limit ?" % ",".join(cols),
        (LIST_LIMIT * 3,)).fetchall()
    cache = {}
    merged = {}
    for row in rows:
        data = pick(row, cols)
        if data.get("hidden"):
            continue
        root = lineage_root(conn, data["id"], cache, reset_edges)
        if root != data["id"]:
            # Fold a continuation into its root: newest activity and counts win.
            target = merged.get(root)
            if target is None:
                rrow = conn.execute("select %s from sessions where id=?" % ",".join(cols), (root,)).fetchone()
                if not rrow:
                    continue
                target = merged[root] = pick(rrow, cols)
                target["segments"] = [root]
            target["segments"].append(data["id"])
            target["message_count"] = (target.get("message_count") or 0) + (data.get("message_count") or 0)
            target["last_activity_at"] = max(target.get("last_activity_at") or 0, data.get("last_activity_at") or 0)
            if data.get("title") and not target.get("title"):
                target["title"] = data["title"]
            continue
        if data.get("parent_session_id"):
            # Delegated subagents and branches are their own rows; keep only top-level chats.
            continue
        if root in merged:
            continue
        data["segments"] = [data["id"]]
        merged[root] = data
    selected = list(merged.values())[:LIST_LIMIT]
    segment_ids = [sid for data in selected for sid in data["segments"]]
    states = execution_states(conn, segment_ids)
    outcomes = terminal_outcomes(conn, segment_ids)
    out = []
    for data in selected:
        segs = data["segments"]
        marks = ",".join("?" for _ in segs)
        last = conn.execute(
            "select id, session_id, role, tool_calls is not null and tool_calls<>'' and tool_calls<>'[]' as calls, timestamp "
            "from messages where session_id in (%s) order by id desc limit 1" % marks, segs).fetchone()
        data["last_message"] = dict(last) if last else None
        data["max_message_id"] = last["id"] if last else 0
        state = merged_execution_state(states, segs)
        if state is not None:
            data["execution_state"] = state
        if state == "idle":
            # A previous segment's failure must not overwrite a later turn
            # that ran directly in the dashboard without an admission.
            last_sid = last["session_id"] if last else None
            outcome = applicable_outcome(conn, outcomes, last_sid)
            if outcome is not None:
                data["execution_outcome"] = outcome
        out.append(data)
    print(json.dumps({"sessions": out}, ensure_ascii=False))


def clip(text):
    if text is None:
        return ""
    if not isinstance(text, str):
        text = json.dumps(text, ensure_ascii=False)
    return text if len(text) <= CLIP else text[:CLIP]


def cmd_messages(root, after, limit):
    conn = connect()
    conn.execute("begin")
    have = columns(conn, "messages")
    wanted = ["id", "session_id", "role", "content", "tool_call_id", "tool_calls", "tool_name", "timestamp",
              "reasoning", "reasoning_content", "display_kind", "display_metadata", "active", "compacted",
              "finish_reason"]
    cols = [c for c in wanted if c in have]
    segs = lineage(conn, root, reset_continuations(conn))
    marks = ",".join("?" for _ in segs)
    rows = conn.execute(
        "select %s from messages where session_id in (%s) and id>? order by id limit ?" % (",".join(cols), marks),
        segs + [int(after), int(limit)]).fetchall()
    out = []
    for row in rows:
        data = pick(row, cols)
        for key in ("content", "reasoning", "reasoning_content", "tool_calls", "display_metadata"):
            if key in data and data[key] is not None:
                data[key] = clip(data[key])
        out.append(data)
    print(json.dumps({"root": root, "segments": segs, "messages": out}, ensure_ascii=False))


def main(argv):
    # The connector reads the output as UTF-8. Python otherwise writes the
    # locale's encoding, which on Windows (cp1252, the CI runner) cannot
    # encode Chinese titles.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    command = argv[1] if len(argv) > 1 else ""
    if not os.path.exists(DB):
        print(json.dumps({"error": "no-state-db"}))
        return
    if command == "list":
        cmd_list()
    elif command == "messages":
        cmd_messages(argv[2], argv[3] if len(argv) > 3 else 0, argv[4] if len(argv) > 4 else 400)
    else:
        print(json.dumps({"error": "unknown-command"}))


if __name__ == "__main__":
    main(sys.argv)
