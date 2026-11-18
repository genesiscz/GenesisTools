#!/usr/bin/env python3
"""Collect five macOS open-file snapshots and metadata-only activity evidence for one proposed root."""
import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import stat
import subprocess
import sys
import time

ROOTS = {
    'codex': '.codex/sessions',
    'grok': '.grok/sessions',
    't3': '.t3/userdata/logs',
    'logs': '.genesis-tools/logs',
}
EXTENSIONS = {'.jsonl', '.json', '.log', '.txt', '.md'}
LSOF = ['/usr/sbin/lsof', '-nP', '-Fn0']


def inventory(root):
    """Track file identity and size without opening a live file."""
    if not root.is_dir():
        raise ValueError(f'Root is missing or inaccessible: {root}')
    def failed(error):
        raise error
    files = {}
    for directory, _, names in os.walk(root, onerror=failed):
        for name in names:
            path = Path(directory, name)
            if path.suffix.lower() not in EXTENSIONS:
                continue
            try:
                record = path.lstat()
            except FileNotFoundError:  # Files may rotate between readdir and stat.
                continue
            if stat.S_ISREG(record.st_mode):
                files[str(path.relative_to(root))] = (record.st_dev, record.st_ino, record.st_size)
    return files


def open_under_root(root, output):
    """NUL fields preserve newlines inside names. Keep only names beneath the specified root."""
    prefix = os.fsencode(root) + b'/'
    held = set()
    pid = None
    saw_absolute = False
    for field in output.split(b'\0'):
        field = field.lstrip(b'\n')
        if field.startswith(b'p'):
            pid = int(field[1:])
        elif field.startswith(b'n/'):
            if pid is None:
                raise ValueError('lsof returned a path without a PID')
            saw_absolute = True
            name = field[1:]
            if name.startswith(prefix):
                held.add((pid, os.fsdecode(name[len(prefix):])))
    if not saw_absolute:
        raise ValueError('lsof returned no absolute path')
    return [{'pid': process, 'path': name} for process, name in sorted(held)]


def activity(before, after):
    # New or rotated files establish activity, but only growth of the same inode is an append candidate.
    grown, created = [], []
    for name, (device, inode, size) in after.items():
        previous = before.get(name)
        if previous and previous[:2] == (device, inode):
            if size > previous[2]:
                grown.append(name)
        elif size:
            created.append(name)
    return {'grew': sorted(grown), 'new_or_replaced': sorted(created)}


def observation(samples, changes):
    if len(samples) != 5:
        return 'incomplete'
    if any(sample['held_text_paths'] for sample in samples):
        return 'open text file observed'
    if not changes['grew'] and not changes['new_or_replaced']:
        return 'inconclusive: no file activity observed'
    return 'file activity observed: append-by-path still requires writer evidence'


def collect(harness, root, interval):
    evidence = dict(harness=harness, root=str(root), command=LSOF, interval_seconds=interval,
                    activity=None, samples=[], status='incomplete')
    try:
        before = inventory(root)
        for index in range(5):
            if index:
                time.sleep(interval)
            started = datetime.now(timezone.utc).isoformat()
            run = subprocess.run(LSOF, capture_output=True, timeout=60)
            if run.returncode != 0 or run.stderr.strip():
                raise ValueError(f'lsof exit {run.returncode}: {os.fsdecode(run.stderr).strip()}')
            held = open_under_root(root, run.stdout)
            text_paths = [item for item in held if Path(item['path'].removesuffix(' (deleted)')).suffix.lower() in EXTENSIONS]
            evidence['samples'].append(dict(started_utc=started, exit=run.returncode,
                                            held_under_root=held, held_text_paths=text_paths))
        evidence['activity'] = activity(before, inventory(root))
        evidence['status'] = observation(evidence['samples'], evidence['activity'])
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        evidence['error'] = str(error)
    return evidence


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('harness', choices=ROOTS)
    parser.add_argument('--root', type=Path, help='Override the default location for this observation')
    parser.add_argument('--interval', type=float, default=5, help='Seconds between snapshots (default 5)')
    args = parser.parse_args()
    if not math.isfinite(args.interval) or not 0 < args.interval <= 300:
        parser.error('--interval must be greater than zero and at most 300 seconds')
    root = (args.root or Path.home() / ROOTS[args.harness]).expanduser().resolve()
    evidence = collect(args.harness, root, args.interval)
    print(json.dumps(evidence, indent=2))
    sys.exit(1 if evidence['status'] == 'incomplete' else 0)
