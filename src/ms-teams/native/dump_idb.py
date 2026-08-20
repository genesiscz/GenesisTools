#!/usr/bin/env python3
"""Dump Teams Chromium IndexedDB stores to JSONL. Read-only against a snapshot copy."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


STORES = {
    "conversations": ("Teams:conversation-manager:", "conversations"),
    "replychains": ("Teams:replychain-manager:", "replychains"),
    "profiles": ("Teams:profiles:", "profiles"),
    "calls": ("Teams:call-history-manager:", "call-history"),
    "activity": ("Teams:activity-manager:", "feed-items"),
}


def jsonable(obj):
    if obj is None:
        return None
    name = type(obj).__name__
    if name in {"Undefined", "IdbKey"}:
        if name == "IdbKey":
            return str(obj)
        return None
    if isinstance(obj, dict):
        return {str(k): jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [jsonable(v) for v in obj]
    if isinstance(obj, (bytes, bytearray)):
        try:
            return obj.decode("utf-8")
        except UnicodeDecodeError:
            return obj.decode("latin-1")
    if isinstance(obj, (str, int, float, bool)):
        return obj
    return str(obj)


def find_database(wrapped, needle: str):
    for dbid in list(wrapped.database_ids):
        if needle in dbid.name:
            return wrapped[dbid]
    return None


def dump_store(wrapped, needle: str, store_name: str, out_path: Path) -> int:
    db = find_database(wrapped, needle)
    if db is None:
        out_path.write_text("", encoding="utf-8")
        print(f"missing database containing {needle!r}", file=sys.stderr)
        return 0
    names = list(db.object_store_names)
    if store_name not in names:
        out_path.write_text("", encoding="utf-8")
        print(f"{needle!r} has stores {names}, not {store_name!r}", file=sys.stderr)
        return 0
    store = db.get_object_store_by_name(store_name)
    n = 0
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        os.chmod(tmp, 0o600)
        for rec in store.iterate_records(live_only=True):
            payload = jsonable(rec.value)
            fh.write(json.dumps(payload, ensure_ascii=False) + "\n")
            n += 1
    tmp.replace(out_path)
    os.chmod(out_path, 0o600)
    return n


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--idb", required=True)
    parser.add_argument("--blob", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    try:
        from ccl_chromium_reader.ccl_chromium_indexeddb import WrappedIndexDB
    except ImportError:
        print("ccl_chromium_reader is not installed in this Python", file=sys.stderr)
        return 2

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    os.chmod(out, 0o700)
    blob = args.blob if Path(args.blob).exists() else None
    wrapped = WrappedIndexDB(args.idb, blob)
    counts = {}
    for label, (needle, store_name) in STORES.items():
        counts[label] = dump_store(wrapped, needle, store_name, out / f"{label}.jsonl")
    print(json.dumps({"ok": True, "counts": counts}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
