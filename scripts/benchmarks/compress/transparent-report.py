#!/usr/bin/env python3
"""Render retained measurements as a vault report and SVG charts via fable-replace."""
import argparse
import collections
import json
import math
from pathlib import Path
import shutil
import statistics
import subprocess
import time

parser=argparse.ArgumentParser()
parser.add_argument('--scratch',required=True)
parser.add_argument('--vault',required=True)
args=parser.parse_args()
root=Path(args.scratch)
vault=Path(args.vault)
vault.mkdir(parents=True,exist_ok=True)
a=json.loads((root/'corpus-v2/results.json').read_text())
w=json.loads((root/'corpus-v2/writers.json').read_text())
allrows=[dict(x,algorithm='ditto LZVN') for x in a['rows']]+w['rows']
algorithms=['ditto LZVN','ZLIB','LZVN','LZFSE']
kinds=list(dict.fromkeys(x['kind'] for x in a['rows']))
lines=[]
def add(s=''):lines.append(s)
def table(headers,rows):
    add('| '+' | '.join(headers)+' |')
    add('| '+' | '.join('---' for _ in headers)+' |')
    for row in rows:add('| '+' | '.join(str(v) for v in row)+' |')
    add()
def percentile(values,q):
    values=sorted(values)
    p=(len(values)-1)*q
    lo=int(p)
    return values[lo]+(values[min(lo+1,len(values)-1)]-values[lo])*(p-lo)
def distribution(values):return ' / '.join(f'{percentile(values,p):.2f}' for p in [.1,.5,.9])
def samples(rows,key):return [v['elapsed_ms'] for x in rows for v in x[key]]
def svg(title,labels,values,unit):
    height=105+len(labels)*55
    output=[f'<svg xmlns="http://www.w3.org/2000/svg" width="900" height="{height}" viewBox="0 0 900 {height}">',
        '<rect width="100%" height="100%" fill="#f8fafc"/>',f'<text x="25" y="35" font-size="22" font-family="sans-serif">{title}</text>']
    maximum=max(values)*1.15
    for i,(label,value) in enumerate(zip(labels,values)):
        y=65+i*55
        output.extend([f'<text x="25" y="{y+21}" font-size="15" font-family="sans-serif">{label}</text>',
            f'<rect x="185" y="{y}" width="{590*value/maximum:.1f}" height="31" fill="{("#0f766e" if label=="LZFSE" else "#475569")}"/>',
            f'<text x="{195+590*value/maximum:.1f}" y="{y+22}" font-size="15" font-family="sans-serif">{value:.2f}{unit}</text>'])
    output.append('</svg>')
    return '\n'.join(output)

now=time.strftime('%Y-%m-%d %H:%M')
add('# Transparent compression benchmark')
add()
add(f'Written {now} Europe/Prague. Handoff h_tayd21il, tasks t1, t11, t12 and read-only t7 observations. Local Mac checkout at 029ddd1431, with concurrent uncommitted implementation work. No real transcript, history file or log was rewritten.')
add()
add('Choose `afsctool -c -T LZFSE` on a verified temporary copy. It saves slightly more than ZLIB on this corpus, with lower observed compression CPU and wall time. Keep `ditto --noclone --hfsCompression` as the installed-system fallback, report its actual LZVN type, and cap it at 512 MiB. Confidence 95% for this bounded corpus: 35 real files, 3 independent writer runs per file, all comparisons equal. The disadvantage is the optional external writer and the need to restore nanosecond timestamps after afsctool.')
add()
add('## Method and scope')
add()
add('macOS 27.2 build 26B123, arm64, Darwin 27.2.0, runtime XNU 13432.41.4~25. The initial run ended at load averages 39.9 / 42.0 / 54.2. The machine remained in normal use. Timings include fresh subprocess startup and are not throughput-only results. CPU time is retained per subprocess. No cache purge, reboot or system-wide cache manipulation was used.')
add()
add('Each kind has five real files, selected deterministically by a hash of the path from files aged at least one day and sized 64 KiB to 16 MiB. Claude image classification looks for actual base64/image media markers, not a filename. Grok final samples are UUID-named session JSON files; the first exploratory run included prompt_context JSON and is excluded from final aggregates. Logs are real named tool logs under the logs root, not five daily day logs. JSON samples are existing application JSON files. This is a stratified convenience sample, not a population-weighted estimate of all history.')
add()
add('Every source was first copied with `ditto --noclone`. Existing transparent compression was materialized through `cat` into a plain scratch data fork. Each algorithm was run three times on its own copy; `cmp -s` followed each run. Reads used `/bin/cat file > /dev/null`, three plain and three compressed runs in alternating order. Search used `rg -l --text transparent-no-such-token-293819 <the same 35 files>`, three interleaved runs per arm, exit 1 expected. Append timing includes open, write, flush and fsync on a disposable clone, three repeats per file. Source size, mtime, inode, device, flags and link count were checked again afterwards. Source atime can change from reading; this is deliberately not an integrity claim about atime.')
add()
add('All 35 source identity/mtime checks stayed equal. All 420 writer outputs passed cmp, and all 420 append fixtures became plain. Ordinary xattr listing hides compression metadata, so the independently retained `afsctool -v` output is the algorithm evidence. The initial ditto files are LZVN type 8; explicit writers produce types 4, 8 and 12.')
add()
add('`afsctool` was initially absent. After the lead explicitly authorized its installation, `HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install afsctool` installed the 1.7.3 arm64_golden_gate bottle, 568.1 KB with no runtime dependencies or service. Its help banner still prints 1.7.2. Applesauce was absent from PATH and the standard Homebrew locations and was not installed.')
add()
add('## Space and compression')
add()
summary=[]
for alg in algorithms:
    rows=[x for x in allrows if x['algorithm']==alg]
    before=sum(x['plain']['allocated'] for x in rows)
    after=sum(x['compressed']['allocated'] for x in rows)
    summary.append([alg,len(rows),before,after,f'{100*after/before:.2f}%',distribution(samples(rows,'compression')),distribution([v['cpu_ms'] for x in rows for v in x['compression']])])
table(['Writer/algorithm','Files','Allocated before B','Allocated after B','Retained','Compress wall ms p10/50/90','Compress CPU ms p10/50/90'],summary)
add('![Allocated bytes retained](space.svg)')
add()
space=[]
for kind in kinds:
    for alg in algorithms:
        rows=[x for x in allrows if x['kind']==kind and x['algorithm']==alg]
        space.append([kind,alg,sum(x['plain']['size'] for x in rows),sum(x['plain']['allocated'] for x in rows),sum(x['compressed']['allocated'] for x in rows),distribution([100*x['compressed']['allocated']/x['plain']['allocated'] for x in rows])])
table(['Kind','Algorithm','Logical B','Allocated before B','Allocated after B','Retained % per-file p10/50/90'],space)
add('## Compare, read, search and append')
add()
readrows=[]
for alg in algorithms:
    rows=[x for x in allrows if x['algorithm']==alg]
    plain=[t['elapsed_ms'] for x in rows for t in x['reads'] if t['arm']=='plain']
    compressed=[t['elapsed_ms'] for x in rows for t in x['reads'] if t['arm']=='compressed']
    readrows.append([alg,distribution(samples(rows,'cmp')),distribution(plain),distribution(compressed),f'{100*(statistics.median(compressed)/statistics.median(plain)-1):+.1f}%',distribution(samples(rows,'append'))])
table(['Algorithm','cmp wall ms p10/50/90','Plain read ms p10/50/90','Compressed read ms p10/50/90','Median read delta','Append+fsync ms p10/50/90'],readrows)
add('These are warm/uncontrolled-cache measurements. A cold-cache read was not measured and no cold number is claimed. Compression and cmp already read the data before the read timings. The file-level percentiles pool 105 observations per algorithm; they mix file sizes. Raw rows permit matched per-file comparisons. Read latency on small files includes several milliseconds of process startup.')
add()
searchrows=[]
for alg in algorithms:
    sr=a['search'] if alg=='ditto LZVN' else [x for x in w['search'] if x['algorithm']==alg]
    p=[x['elapsed_ms'] for x in sr if x['arm']=='plain'];c=[x['elapsed_ms'] for x in sr if x['arm']=='compressed']
    searchrows.append([alg,3,distribution(p),distribution(c),f'{100*(statistics.median(c)/statistics.median(p)-1):+.1f}%'])
table(['Algorithm','Runs/arm','Plain rg ms p10/50/90','Compressed rg ms p10/50/90','Median delta'],searchrows)
add('Three search runs are enough to expose a large slowdown, but not enough to attribute small differences on this loaded Mac. The original exploratory search measured LZFSE +25.9% and afsctool LZVN +39.0%; the final rerun is above. Read-budget decisions must use the final paired measurements and preserve this variability.')
add()
add('![Compression wall time](compression.svg)')
add()
add('## Size limits and timestamps')
add()
boundary=[]
for x in json.loads((root/'results.json').read_text())['boundaries']:
    boundary.append(['ditto',x['size'],x['after']['flags'],x['after']['allocated'],x['operation']['exit'],x['operation']['stderr'].strip() or 'silent'])
for x in w['boundaries']:
    boundary.append([x['algorithm'],x['size'],x['after']['flags'],x['after']['allocated'],x['operation']['exit'],'unsupported size' if 'unsupportable' in x['operation']['stderr'] else 'silent'])
for x in json.loads((root/'exact-boundaries.json').read_text()):
    boundary.append([x['algorithm'],x['size'],x['flags'],x['allocated'],x['exit'],'unsupported size' if 'unsupportable' in x['stderr'] else 'silent'])
table(['Writer','Logical B','BSD flags','Allocated B','Exit','Message'],boundary)
add('Boundary inputs are safe sparse zero fixtures; output flags and allocated bytes are the observation. This tests the writer size guard, not compression ratios for real 2 GiB or 4 GiB transcripts. Ditto materialized about 12 GiB of plain boundary outputs. They remain in scratch as requested; no cleanup or deletion ran.')
add()
add('Use max 2,147,188,457 bytes for this afsctool version and verify the compressed flag. At the maximum, LZFSE successfully compressed to 6,291,456 allocated bytes; one byte larger was rejected. The source guard includes resource-fork overhead and is stricter than 2 GiB. An LZVN file with a final chunk of one byte is rejected even below that limit, while 512 MiB + 64 bytes compressed. The tested writer cannot establish a universal 4 GiB decmpfs kernel limit. The on-disk header has a 64-bit logical size; resource-fork chunk offsets and writer guards impose narrower limits. Files outside the selected writer limit must remain intact and appear as too-big count, bytes and reason, never split.')
add()
add('Ditto kept all 35 mtimes to nanoseconds. Every afsctool output truncated the mtime to microseconds. A direct `libSystem.utimensat(AT_FDCWD, path, timespec[2], 0)` restored 1784634041809162472 ns from 1784634041809162000 ns exactly, with flag 32 retained. The engine must restore timestamps on its temporary output before comparing final metadata. Saved proof is `utimensat.json`.')
add()
add('## Rechecking the nine handoff facts')
add()
table(['Fact','Verdict in this run','Command/evidence'],[
['1 clone-default ditto','Confirmed compression behavior: default ditto output plain; --noclone compressed. Clone extent sharing is separately checked by du.','ditto --hfsCompression plain out; ditto --noclone --hfsCompression plain out; results.json facts.ditto_default'],
['2 490MB,16x,2.1s,exact mtime','Historical numbers not reproduced because the original file was unnamed. Refuted as a general expectation; cmp and exact ditto mtime confirmed35/35.','per-file tables; cmp -s; stat before/after'],
['3 screenshot file retains70%,flag distinguishes','Confirmed flag-based detection; refuted fixed70% expectation across image sessions. Image distribution is in table above.','stat st_flags &32; claude_image rows'],
['4 ditto above512MiB silently plain','Confirmed at exact boundary.','ditto --noclone --hfsCompression boundary out; 536870912 flag32,536870913 flag0,exit0'],
['5 append decompresses whole file','Confirmed420/420 disposable compressed clone appends; flags0 and full logical allocation recorded.','open(ab),write,flush,fsync; append rows'],
['6 compressed clone and overwrite stay compressed','Confirmed flags/bytes; cp -c explicitly requests cloning, resource sharing independently reproduced by du worker.','cp -c -p compressed clone; cp -c -p -f compressed existing; facts compressed_clone*'],
['7 surviving plain clone pins plain extents','Confirmed APFS ownership mechanism; no isolated volume-free-space measurement is claimed on busy system. Requires complete family replacement for saving.','du pair fixture resource-fork extent observations; clone semantics; global free-space deltas are not attribution evidence'],
['8 Claude appends by path,holds none open','Refuted as blanket claim: one Claude transcript was open in first sample,0 next4. Cannot prove path-only writes from absence. Codex13–14 paths open each sample.','five lsof -nP -Fn snapshots; lsof-summary.json'],
['9 du two compressed clones unique0','Confirmed old binary bug; worker resource-fork fix reports106496 allocated unique versus old0.','du/pair-before.json and pair-after.json; worker baseline/fix commands']])
add('The held-descriptor fixture also confirmed why a last lsof pass matters: after rename-and-replacement an append through the held descriptor reached only the aside inode. The compressed pathname lacked that append. This is a reproduced loss scenario for a naive rename implementation, not a claim that any live harness was rewritten.')
add()
add('## Can Zstd be transparent like APFS compression?')
add()
add('For ordinary unmodified macOS file readers, there is no verified native transparent Zstd path. The decmpfs mechanism dispatches to registered kernel decompressors. Writing a Zstd stream into a decmpfs xattr does not teach the kernel to decode it. A separate filesystem layer or a new kernel decompressor would be different infrastructure, with installation and compatibility costs. Confidence 95% for the current Mac: its installed compression personality advertises3,4,7,8,9,10,11,12; our actual kernel reads of types4,8,12 are byte-identical. A kernel decompressor list alone cannot exclude every private or future implementation.')
add()
add('The public XNU header does not enumerate ZLIB/LZVN/LZFSE at all: it defines the header, type1, a registration API and says additional types live in AppleFSCompression. Apple copyfile source enumerates3/4 ZLIB,7/8 LZVN,9/10 uncompressed,11/12 LZFSE,13/14 LZBITMAP. Therefore the handoff assertion that the full list is in bsd/sys/decmpfs.h was refuted. LZBITMAP13/14 are documented in copyfile but not advertised by this installed kext personality. The exact running XNU tag was unavailable from the public source endpoint, so the public main header is mechanism evidence and the installed plist is version-local evidence.')
add()
add('Primary sources: [Apple XNU decmpfs.h](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/decmpfs.h), [Apple copyfile compression-type switch](https://github.com/apple-oss-distributions/copyfile/blob/main/copyfile.c#L3597-L3637), [afsctool1.7.3 guard](https://github.com/RJVB/afsctool/blob/v1.7.3/src/afsctool.c#L435-L439), [afsctool maximum constant](https://github.com/RJVB/afsctool/blob/v1.7.3/src/afsctool.h#L53), [Apple LZFSE documentation](https://developer.apple.com/documentation/Compression/COMPRESSION_LZFSE).')
add()
add('## Defaults and eligibility')
add()
table(['Setting','Recommendation','Evidence/limit'],[
['Writer/algorithm','afsctool LZFSE; ditto fallback actual LZVN','same35-file comparison; afsctool temp output only'],
['Age','7days default','safety choice, not derived from ratio benchmark; current open handles always excluded'],
['Minimum size','64KiB','smallest benchmark eligibility; no claim of optimum below this'],
['Extensions','.jsonl,.json,.txt,.log','all measured; exclude sqlite,media,archives,sparse,hardlinks,already compressed'],
['Maximum','2147188457B afsctool;536870912B ditto','verified boundaries; count and name too-big reason'],
['Minimum saving','30%','project compression policy; verify actual flag and final allocation'],
['Scheduling','disabled until separately authorized','this run authorizes no real history apply or recurring job']])
add('The five lsof samples were read-only, exit0 and nonempty, captured while the machine had running harnesses. They do not prove that Grok was actively writing during those exact seconds or that any harness always writes by path. No root becomes safe merely because its count was0. Codex and the logger demonstrably hold files open and need per-file exclusion. T3 userdata/logs did not appear in these samples, which does not establish its writer contract.')
add()
lsof=json.loads((root/'lsof-summary.json').read_text())
table(['Time Prague','Claude','Codex','Grok','T3 logs','Genesis logs','Exit'],[[x['time'],*[x['counts'][k] for k in ['claude','codex','grok','t3','logs']],x['exit']] for x in lsof])
add('## Artifacts and rerun')
add()
add('Durable raw measurement JSON, installation output, type evidence, limits and lsof summary are beside this note under `raw/`. Full private source-path mapping, copied corpus, process inventory and unfiltered lsof snapshots remain only in scratch. Raw measurements contain commands and filesystem metadata, never transcript contents. The scratch directory is `/tmp/cc/GenesisTools/3be725f0-a4da-4c83-8aba-66a2fb4aafec/compress/bench/`. It is temporary and may disappear at reboot.')
add()
add('Run from GenesisTools on APFS with a fresh scratch directory:')
add('```bash\npython3 scripts/benchmarks/compress/transparent.py --scratch <fresh-scratch> --boundaries\npython3 scripts/benchmarks/compress/transparent-writers.py --scratch <fresh-scratch>\n```')
add()
add('The benchmark scripts explicitly mutate only the selected scratch directory. They do not install a writer, compress real sources in place or change a daemon setting. The report generator expects the retained exploratory/final layout from this session; it is a rendering tool, not an independent benchmark runner.')
add()
add('Outstanding evidence limits for the lead: cold-cache latency was intentionally unmeasured; no live harness append-by-path proof was inferred from lsof; the historical490MB sample was unidentified; a universal kernel4GiB format limit was not established. These are explicit constraints on claims, not skipped safety checks to waive before unattended use.')

raw=vault/'raw'
raw.mkdir(exist_ok=True)
for source,name in [(root/'corpus-v2/results.json','measurements-ditto.json'),(root/'corpus-v2/writers.json','measurements-afsctool.json'),(root/'results.json','exploratory-ditto-and-boundaries.json')]+[(root/n,n) for n in ['exact-boundaries.json','utimensat.json','lsof-summary.json','writer-types.json','kernel-compression-info.json','brew-install.txt']]:
    shutil.copy2(source,raw/name)
for source in [root.parent/'du/pair-before.json',root.parent/'du/pair-after.json']:
    if source.exists():shutil.copy2(source,raw/source.name)
report='\n'.join(lines)+'\n'
charts={
 'space.svg':svg('Allocated bytes retained, 35 real files',algorithms,[100*sum(x['compressed']['allocated'] for x in allrows if x['algorithm']==alg)/sum(x['plain']['allocated'] for x in allrows if x['algorithm']==alg) for alg in algorithms],'%'),
 'compression.svg':svg('Median compression wall time, 105 observations per writer',algorithms,[statistics.median(samples([x for x in allrows if x['algorithm']==alg],'compression')) for alg in algorithms],' ms')}
spec='@@ '+str(vault/'2026-11-12-ColdCompressBenchmark.md')+'\n<<< create\n'+report+'>>>\n'
for name,body in charts.items():spec+='@@ '+str(vault/name)+'\n<<< create\n'+body+'\n>>>\n'
p=subprocess.run(['bun','plugins/genesis-tools/skills/fable-replace/scripts/cli.ts'],input=spec.encode())
raise SystemExit(p.returncode)
