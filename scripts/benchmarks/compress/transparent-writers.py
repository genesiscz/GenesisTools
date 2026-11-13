#!/usr/bin/env python3
"""Compare installed afsctool writers on transparent.py's immutable scratch corpus."""
import argparse
import json
import os
from pathlib import Path
import resource
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--scratch', required=True)
args = parser.parse_args()
root = Path(args.scratch)
if (root/'writers.json').exists():
    raise SystemExit('Use a fresh corpus copy; existing compressed outputs would invalidate writer timings.')
base = json.loads((root/'results.json').read_text())
commands = []
# Every writer call has a deadline (see transparent.py): a stuck afsctool ends the run with a 'timeout' row.
TIMEOUT_S = 1800
def run(argv, ok=(0,), stdout=subprocess.DEVNULL, timeout=TIMEOUT_S):
    begin = time.monotonic_ns()
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    try:
        p = subprocess.run([str(v) for v in argv],stdout=stdout,stderr=subprocess.PIPE,timeout=timeout)
        code,stderr = p.returncode,p.stderr.decode(errors='replace')
    except subprocess.TimeoutExpired as expired:
        code,stderr = 'timeout','killed after %d s; %s' % (timeout,(expired.stderr or b'').decode(errors='replace'))
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    row = dict(argv=[str(v) for v in argv],elapsed_ms=(time.monotonic_ns()-begin)/1e6,
        cpu_ms=(after.ru_utime+after.ru_stime-before.ru_utime-before.ru_stime)*1000,exit=code,stderr=stderr)
    commands.append(row)
    if p.returncode not in ok:
        raise RuntimeError(row)
    return row

def info(p):
    s=os.stat(p)
    return dict(size=s.st_size,allocated=s.st_blocks*512,flags=s.st_flags,mtime_ns=s.st_mtime_ns,inode=s.st_ino)

rows=[]
for record in base['rows']:
    folder=root/record['id']
    plain=folder/('materialized' if (folder/'materialized').exists() else 'plain')
    for algorithm in ['ZLIB','LZVN','LZFSE']:
        row=dict(id=record['id'],kind=record['kind'],algorithm=algorithm,plain=info(plain),compression=[],cmp=[],reads=[],append=[])
        for repeat in range(3):
            target=folder/('afsctool-'+algorithm+'-'+str(repeat))
            run(['/usr/bin/ditto','--noclone',plain,target])
            row['compression'].append(run(['afsctool','-c','-T',algorithm,target]))
            row['cmp'].append(run(['/usr/bin/cmp','-s',plain,target]))
            row['compressed']=info(target)
        for repeat in range(3):
            for arm,p in [('plain',plain),('compressed',target)] if repeat%2==0 else [('compressed',target),('plain',plain)]:
                row['reads'].append(dict(arm=arm,repeat=repeat,**run(['/bin/cat',p])))
        for repeat in range(3):
            append=folder/('afsctool-append-'+algorithm+'-'+str(repeat))
            run(['/bin/cp','-c','-p',target,append])
            start=time.monotonic_ns()
            with open(append,'ab') as f:
                f.write(b'\ntransparent-append-fixture\n')
                f.flush()
                os.fsync(f.fileno())
            row['append'].append(dict(elapsed_ms=(time.monotonic_ns()-start)/1e6,after=info(append)))
        rows.append(row)
        (root/'writers.json').write_text(json.dumps(dict(rows=rows,commands=commands),indent=2))
        print(record['id'],algorithm,row['compressed']['allocated'],flush=True)
search=[]
for algorithm in ['ZLIB','LZVN','LZFSE']:
    for repeat in range(3):
        for arm in ['plain','compressed'] if repeat%2==0 else ['compressed','plain']:
            paths=[root/r['id']/('afsctool-'+algorithm+'-2' if arm=='compressed' else ('materialized' if (root/r['id']/'materialized').exists() else 'plain')) for r in base['rows']]
            search.append(dict(algorithm=algorithm,repeat=repeat,arm=arm,**run(['rg','-l','--text','transparent-no-such-token-293819',*paths],ok=(1,))))
boundaries=[]
for algorithm in ['ZLIB','LZVN','LZFSE']:
    for size in [512*1024*1024+1,4*1024**3-1,4*1024**3,4*1024**3+1]:
        target=root/('afsctool-boundary-'+algorithm+'-'+str(size))
        with open(target,'wb') as f:
            f.truncate(size)
        operation=run(['afsctool','-c','-T',algorithm,target],ok=(0,1))
        boundaries.append(dict(algorithm=algorithm,size=size,after=info(target),operation=operation))
        print('boundary',algorithm,size,boundaries[-1]['after'],flush=True)
        (root/'writers.json').write_text(json.dumps(dict(rows=rows,search=search,boundaries=boundaries,commands=commands),indent=2))
print('complete',len(rows),flush=True)
