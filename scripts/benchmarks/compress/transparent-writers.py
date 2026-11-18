#!/usr/bin/env python3
"""Compare installed APFS writers on transparent.py's scratch corpus."""
import argparse
import json
import os
from pathlib import Path
import shutil

parser = argparse.ArgumentParser()
parser.add_argument('--scratch', required=True)
parser.add_argument('--boundaries', action='store_true', help='Include sparse 512 MiB and 4 GiB writer probes')
parser.add_argument('--applesauce-args', nargs=argparse.REMAINDER,
                    help='Installed applesauce in-place compression arguments; put {file} at the file position')
args = parser.parse_args()
root = Path(args.scratch)
base = json.loads((root/'results.json').read_text())
if not base.get('complete'):
    raise SystemExit('First finish transparent.py on a fresh corpus.')
writers = {}
if shutil.which('afsctool'):
    for codec in ('ZLIB', 'LZVN', 'LZFSE'):
        writers[codec] = ['afsctool', '-c', '-T', codec, '{file}']
if shutil.which('applesauce'):
    if not args.applesauce_args or args.applesauce_args.count('{file}') != 1:
        parser.error('applesauce is installed. Supply its in-place compression arguments with --applesauce-args.')
    writers['applesauce'] = ['applesauce', *args.applesauce_args]
elif args.applesauce_args is not None:
    parser.error('applesauce is unavailable')
if not writers:
    print('No supplementary writer installed. Report the ditto results alone.')
    raise SystemExit(0)
if (root/'writers.json').exists():
    raise SystemExit('Use a fresh corpus. A previous writer run has already started.')
# Reserve the run before creating its first output, including when two callers start at once.
with (root/'writers.json').open('x') as pending:
    json.dump({'complete': False}, pending)
# Every writer call has a deadline (`_run.TIMEOUT_S`): a stuck afsctool ends the run with a 'timeout' row.
from _run import APPEND, append_trial, commands, digest, run, search_trials

def info(p):
    s=os.stat(p)
    return dict(size=s.st_size,allocated=s.st_blocks*512,flags=s.st_flags,mtime_ns=s.st_mtime_ns,inode=s.st_ino)

def write_command(writer, target):
    return [target if arg == '{file}' else arg for arg in writers[writer]]

rows=[]
for record in base['rows']:
    folder=root/record['id']
    plain=folder/('materialized' if (folder/'materialized').exists() else 'plain')
    if digest(plain) != record['sha256']:
        raise SystemExit(f"Scratch input changed since the ditto trial: {record['id']}")
    expected = digest(plain, APPEND)
    for algorithm in writers:
        row=dict(id=record['id'],kind=record['kind'],algorithm=algorithm,plain=info(plain),compression=[],cmp=[],reads=[],append=[])
        for repeat in range(3):
            target=folder/('writer-'+algorithm+'-'+str(repeat))
            run(['/usr/bin/ditto','--noclone',plain,target])
            row['compression'].append(run(write_command(algorithm, target)))
            row['cmp'].append(run(['/usr/bin/cmp','-s',plain,target]))
            row['compressed']=info(target)
        for repeat in range(3):
            for arm,p in [('plain',plain),('compressed',target)] if repeat%2==0 else [('compressed',target),('plain',plain)]:
                row['reads'].append(dict(arm=arm,repeat=repeat,**run(['/bin/cat',p])))
        for repeat in range(3):
            target = folder/('writer-'+algorithm+'-'+str(repeat))
            append = folder/('writer-append-'+algorithm+'-'+str(repeat))
            row['append'].append(append_trial(target, append, expected, info))
        rows.append(row)
        (root/'writers.json').write_text(json.dumps(dict(rows=rows,commands=commands),indent=2))
        print(record['id'],algorithm,row['compressed']['allocated'],flush=True)
search=[]
for algorithm in writers:
    pairs = []
    for row in base['rows']:
        folder = root / row['id']
        plain = folder / ('materialized' if (folder / 'materialized').exists() else 'plain')
        pairs.append((row['id'], plain, folder / ('writer-'+algorithm+'-2')))
    search.extend(dict(algorithm=algorithm, **trial) for trial in search_trials(root / ('rg-'+algorithm), pairs))
boundaries=[]
for algorithm in (writers if args.boundaries else []):
    for size in [512*1024**2-1,512*1024**2,512*1024**2+1,512*1024**2+64,
                 2147188457,2147188458,4*1024**3-1,4*1024**3,4*1024**3+1]:
        target=root/('writer-boundary-'+algorithm+'-'+str(size))
        with open(target,'wb') as f:
            f.truncate(size)
        reference = root/'writer-boundary-plain'
        with open(reference, 'wb') as stream:
            stream.truncate(size)
        operation=run(write_command(algorithm, target),ok=(0,1))
        comparison = run(['/usr/bin/cmp', '-s', reference, target])
        boundaries.append(dict(algorithm=algorithm,size=size,after=info(target),operation=operation,cmp=comparison))
        print('boundary',algorithm,size,boundaries[-1]['after'],flush=True)
        (root/'writers.json').write_text(json.dumps(dict(rows=rows,search=search,boundaries=boundaries,commands=commands),indent=2))
(root/'writers.json').write_text(json.dumps(dict(complete=True,rows=rows,search=search,
                                                boundaries=boundaries,commands=commands),indent=2))
print('complete',len(rows),flush=True)
