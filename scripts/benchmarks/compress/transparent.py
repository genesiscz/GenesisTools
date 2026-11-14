#!/usr/bin/env python3
"""Opt-in APFS benchmark. Reads real sources; writes only --scratch. No installs or cache purge."""
import argparse
import collections
import glob
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import statistics
import struct
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--scratch', required=True)
parser.add_argument('--boundaries', action='store_true')
args = parser.parse_args()
root = Path(args.scratch).resolve()
root.mkdir(parents=True, exist_ok=True)
if (root/'results.json').exists():
    raise SystemExit('Use a fresh scratch directory; an existing result would invalidate writer timings.')
commands = []

# Every external command has a deadline: a stuck ditto, cmp or lsof ends the run with a recorded 'timeout' row
# instead of waiting forever. A 4 GiB boundary copy took well under a minute on APFS; 30 minutes is the cap.
TIMEOUT_S = 1800

def run(argv, ok=(0,), stdout=subprocess.DEVNULL, timeout=TIMEOUT_S):
    start = time.monotonic_ns()
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    try:
        result = subprocess.run([str(v) for v in argv], stdout=stdout, stderr=subprocess.PIPE, timeout=timeout)
        code, stderr = result.returncode, result.stderr.decode(errors='replace')
    except subprocess.TimeoutExpired as expired:
        code, stderr = 'timeout', 'killed after %d s; %s' % (timeout, (expired.stderr or b'').decode(errors='replace'))
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    row = dict(argv=[str(v) for v in argv], elapsed_ms=(time.monotonic_ns()-start)/1e6,
               cpu_ms=(after.ru_utime+after.ru_stime-before.ru_utime-before.ru_stime)*1000,
               exit=code, stderr=stderr)
    commands.append(row)
    if result.returncode not in ok:
        raise RuntimeError(row)
    return row

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

def digest(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for block in iter(lambda: f.read(1024*1024), b''):
            h.update(block)
    return h.hexdigest()

def candidates(folder, pattern):
    result = []
    for p in glob.iglob(os.path.expanduser(folder)+'/**/'+pattern, recursive=True):
        try:
            s = os.stat(p)
            if 64*1024 <= s.st_size <= 16*1024*1024 and s.st_mtime < time.time()-86400:
                result.append(p)
        except OSError:
            continue
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
        for repeat in range(3):
            target = folder/('append-'+str(repeat))
            run(['/bin/cp','-c','-p',compressed,target])
            start = time.monotonic_ns()
            with open(target,'ab') as f:
                f.write(b'\ntransparent-append-fixture\n')
                f.flush()
                os.fsync(f.fileno())
            row['append'].append(dict(elapsed_ms=(time.monotonic_ns()-start)/1e6,after=info(target)))
        row['source_after'] = info(source)
        row['source_unchanged'] = row['source_before'] == row['source_after']
        row['sha256'] = digest(plain)
        rows.append(row)
        (root/'results.json').write_text(json.dumps(dict(rows=rows,commands=commands),indent=2))
        print(ident,baseline['size'],row['compressed']['allocated'],flush=True)

search = []
for repeat in range(3):
    for arm in (['plain','compressed'] if repeat%2==0 else ['compressed','plain']):
        paths = [root/r['id']/('compressed-2' if arm=='compressed' else ('materialized' if (root/r['id']/'materialized').exists() else 'plain')) for r in rows]
        search.append(dict(arm=arm,repeat=repeat,**run(['rg','-l','--text','transparent-no-such-token-293819',*paths],ok=(1,))))

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
    run(['/usr/sbin/lsof','-nP','-Fn'],stdout=open(root/'lsof-descriptor.txt','wb'))

boundaries=[]
if args.boundaries:
    for size in [512*1024*1024-1,512*1024*1024,512*1024*1024+1,4*1024**3-1,4*1024**3,4*1024**3+1]:
        p=root/('boundary-'+str(size))
        with open(p,'wb') as f:
            f.truncate(size)
        operation=run(['/usr/bin/ditto','--noclone','--hfsCompression',p,str(p)+'-out'])
        boundaries.append(dict(size=size,before=info(p),after=info(str(p)+'-out'),operation=operation))
        print('boundary',size,boundaries[-1]['after'],flush=True)
(root/'results.json').write_text(json.dumps(dict(rows=rows,search=search,facts=facts,boundaries=boundaries,commands=commands,
    system=dict(uname=list(os.uname()),load=os.getloadavg(),time=time.strftime('%Y-%m-%d %H:%M'))),indent=2))
print('complete',len(rows),dict((k,len(v)) for k,v in selected.items()),flush=True)
