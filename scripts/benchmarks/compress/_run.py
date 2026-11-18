"""The timed command runner that transparent.py and transparent-writers.py share, with its log of every command."""
import hashlib
import os
import resource
import subprocess
import time

commands = []

# Every external command has a deadline: a stuck ditto, cmp, lsof or afsctool ends the run with a recorded 'timeout'
# row instead of waiting forever. A 4 GiB boundary copy took well under a minute on APFS; 30 minutes is the cap.
TIMEOUT_S = 1800

KINDS = ('claude_plain', 'claude_image', 'tool_results', 'codex', 'grok', 'logs', 'json')
APPEND = b'\ntransparent-append-fixture\n'


def require_corpus(selected):
    missing = {kind: len(selected.get(kind, [])) for kind in KINDS if len(selected.get(kind, [])) != 5}
    if missing:
        raise ValueError(f'Need five eligible files of each kind. Counts for incomplete kinds: {missing}')


def digest(path, suffix=b''):
    checksum = hashlib.sha256()
    with open(path, 'rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            checksum.update(block)
    checksum.update(suffix)
    return checksum.hexdigest()


def append_trial(compressed, target, expected_digest, info):
    run(['/bin/cp', '-c', '-p', compressed, target])
    before = info(target)
    if (before['flags'] & 32) != (info(compressed)['flags'] & 32):
        raise ValueError(f'Clone changed the compression flag: {target}')
    start = time.monotonic_ns()
    with open(target, 'ab') as stream:
        stream.write(APPEND)
        stream.flush()
        os.fsync(stream.fileno())
    elapsed_ms = (time.monotonic_ns() - start) / 1e6
    after = info(target)
    if after['flags'] & 32 or digest(target) != expected_digest:
        raise ValueError(f'First append failed flag or byte verification: {target}')
    return dict(elapsed_ms=elapsed_ms, before=before, after=after)


def search_trials(folder, pairs):
    # Matched directory entries point only at scratch inodes. No copy or link creation is timed.
    for arm in ('plain', 'compressed'):
        (folder / arm).mkdir(parents=True)
    for name, plain, compressed in pairs:
        os.link(plain, folder / 'plain' / name)
        os.link(compressed, folder / 'compressed' / name)
    trials = []
    pattern = 'bench-miss-' + hashlib.sha256(str(folder.parent).encode()).hexdigest()
    for repeat in range(3):
        for arm in (('plain', 'compressed') if repeat % 2 == 0 else ('compressed', 'plain')):
            result = run(['rg', '--no-config', '--no-ignore', '-l', '--text', pattern, folder / arm], ok=(1,))
            trials.append(dict(arm=arm, repeat=repeat, **result))
    return trials

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
    if code not in ok:
        raise RuntimeError(row)
    return row
