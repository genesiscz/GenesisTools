#!/usr/bin/env python3
"""Opt-in APFS benchmark. Reads real sources; writes only --scratch. No installs or cache purge."""
import argparse
import collections
from fnmatch import fnmatch
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--scratch', required=True)
parser.add_argument('--boundaries', action='store_true')
args = parser.parse_args()
root = Path(args.scratch).resolve()
root.mkdir(mode=0o700, parents=True, exist_ok=False)
# Every external command has a deadline (`_run.TIMEOUT_S`), and `commands` logs each one.
from _run import APPEND, TIMEOUT_S, append_trial, commands, digest, require_corpus, run, search_trials

def info(p):
    s = os.stat(p)
    result = dict(size=s.st_size, allocated=s.st_blocks*512, flags=s.st_flags,
                  mtime_ns=s.st_mtime_ns, inode=s.st_ino, device=s.st_dev, nlink=s.st_nlink)
    if s.st_flags & 32:
        value = subprocess.run(['/usr/bin/xattr', '-px', 'com.apple.decmpfs', str(p)], capture_output=True, timeout=60)
        if value.returncode == 0:
            header = bytes.fromhex(value.stdout.decode())[:16]
            if len(header) == 16:
                result['decmpfs_header'] = list(struct.unpack('<IIQ', header))
    return result

def candidates(folder, pattern):
    result = []
    cutoff = time.time() - 86400
    for directory, _, names in os.walk(os.path.expanduser(folder)):
        for name in names:
            if not fnmatch(name, pattern):
                continue
            p = os.path.join(directory, name)
            try:
                s = os.lstat(p)
            except OSError:
                continue
            if (stat.S_ISREG(s.st_mode) and not s.st_flags & 0x40000000 and
                    64*1024 <= s.st_size <= 16*1024*1024 and s.st_mtime < cutoff):
                result.append(p)
    return sorted(result, key=lambda p: hashlib.sha256(p.encode()).hexdigest())

selected = collections.defaultdict(list)
for p in candidates('~/.claude/projects', '*.jsonl'):
    data = Path(p).read_bytes()
    image = re.search(rb'"(?:type|media_type)"\s*:\s*"(?:base64|image/[^"]+)"', data) is not None
    kind = 'claude_image' if image else 'claude_plain'
    if len(selected[kind]) < 5:
        selected[kind].append(p)
    if len(selected['claude_image']) == 5 and len(selected['claude_plain']) == 5:
        break
for kind, folder, pattern in [('tool_results','~/.claude/projects','*.txt'),
                              ('codex','~/.codex/sessions','*.jsonl'),
                              ('grok','~/.grok/sessions','*.json'),
                              ('logs','~/.genesis-tools/logs','*.log'),
                              ('json','~/.genesis-tools','*.json')]:
    files = candidates(folder, pattern)
    if kind == 'tool_results':
        files = [p for p in files if '/tool-results/' in p]
    if kind == 'grok':
        files = [p for p in files if re.fullmatch(r'[0-9a-f-]{36}\.json', os.path.basename(p))]
    selected[kind] = files[:5]
require_corpus(selected)
(root/'source-map.json').write_text(json.dumps(dict(selected), indent=2))
rows = []
for kind, paths in selected.items():
    for i, source in enumerate(paths):
        ident = kind+'-'+str(i)
        folder = root/ident
        folder.mkdir(exist_ok=True)
        plain = folder/'plain'
        original = info(source)
        run(['/usr/bin/ditto','--noclone',source,plain])
        # ditto preserves compression on an already compressed source. Materialize data fork plain.
        if info(plain)['flags'] & 32:
            with open(folder/'materialized','wb') as dst:
                subprocess.run(['/bin/cat',str(plain)],stdout=dst,check=True,timeout=TIMEOUT_S)
            os.utime(folder/'materialized', ns=(os.stat(plain).st_atime_ns,os.stat(plain).st_mtime_ns))
            plain = folder/'materialized'
        baseline = info(plain)
        row = dict(id=ident,kind=kind,source_before=original,plain=baseline,compression=[],cmp=[],reads=[],append=[])
        for repeat in range(3):
            compressed = folder/('compressed-'+str(repeat))
            row['compression'].append(run(['/usr/bin/ditto','--noclone','--hfsCompression',plain,compressed]))
            row['cmp'].append(run(['/usr/bin/cmp','-s',plain,compressed]))
            row['compressed'] = info(compressed)
        for repeat in range(3):
            for arm,p in [('plain',plain),('compressed',compressed)] if repeat%2 == 0 else [('compressed',compressed),('plain',plain)]:
                row['reads'].append(dict(arm=arm,repeat=repeat,**run(['/bin/cat',p])))
        expected = digest(plain, APPEND)
        for repeat in range(3):
            row['append'].append(append_trial(folder/('compressed-'+str(repeat)),
                                              folder/('append-'+str(repeat)), expected, info))
        row['source_after'] = info(source)
        row['source_unchanged'] = row['source_before'] == row['source_after']
        if not row['source_unchanged']:
            raise SystemExit(f'Source metadata changed during sampling: {ident}. Use a fresh corpus.')
        row['sha256'] = digest(plain)
        rows.append(row)
        (root/'results.json').write_text(json.dumps(dict(rows=rows,commands=commands),indent=2))
        print(ident,baseline['size'],row['compressed']['allocated'],flush=True)

pairs = []
for row in rows:
    folder = root / row['id']
    plain = folder / ('materialized' if (folder / 'materialized').exists() else 'plain')
    pairs.append((row['id'], plain, folder / 'compressed-2'))
search = search_trials(root / 'rg-ditto', pairs)

facts = {}
sample = root/rows[0]['id']
plain = sample/('materialized' if (sample/'materialized').exists() else 'plain')
compressed = sample/'compressed-2'
run(['/usr/bin/ditto','--hfsCompression',plain,root/'ditto-clone-default'])
facts['ditto_default'] = info(root/'ditto-clone-default')
run(['/bin/cp','-c','-p',compressed,root/'compressed-clone'])
facts['compressed_clone'] = info(root/'compressed-clone')
(root/'existing-clone').write_bytes(b'old')
run(['/bin/cp','-c','-p','-f',compressed,root/'existing-clone'])
facts['compressed_clone_overwrite'] = info(root/'existing-clone')
# Descriptor remains on old inode after replacement; old inode must be preserved by the engine.
run(['/usr/bin/ditto','--noclone',plain,root/'descriptor-file'])
with open(root/'descriptor-file','ab') as descriptor:
    os.rename(root/'descriptor-file',root/'descriptor-aside')
    run(['/bin/cp','-c','-p',compressed,root/'descriptor-file'])
    descriptor.write(b'\nheld-descriptor-write\n')
    descriptor.flush()
    os.fsync(descriptor.fileno())
    facts['descriptor'] = dict(old=info(root/'descriptor-aside'),new=info(root/'descriptor-file'),
        old_has_append=Path(root/'descriptor-aside').read_bytes().endswith(b'held-descriptor-write\n'),
        new_has_append=Path(root/'descriptor-file').read_bytes().endswith(b'held-descriptor-write\n'))
    with open(root/'lsof-descriptor.txt', 'wb') as evidence:
        run(['/usr/sbin/lsof','-nP','-Fn',root/'descriptor-aside'], stdout=evidence)

boundaries=[]
if args.boundaries:
    for size in [512*1024*1024-1,512*1024*1024,512*1024*1024+1,4*1024**3-1,4*1024**3,4*1024**3+1]:
        p=root/('boundary-'+str(size))
        with open(p,'wb') as f:
            f.truncate(size)
        operation=run(['/usr/bin/ditto','--noclone','--hfsCompression',p,str(p)+'-out'])
        comparison=run(['/usr/bin/cmp','-s',p,str(p)+'-out'])
        boundaries.append(dict(size=size,before=info(p),after=info(str(p)+'-out'),operation=operation,cmp=comparison))
        print('boundary',size,boundaries[-1]['after'],flush=True)
(root/'results.json').write_text(json.dumps(dict(complete=True,rows=rows,search=search,facts=facts,boundaries=boundaries,commands=commands,
    system=dict(uname=list(os.uname()),load=os.getloadavg(),time=time.strftime('%Y-%m-%d %H:%M'))),indent=2))
print('complete',len(rows),dict((k,len(v)) for k,v in selected.items()),flush=True)
