"""The timed command runner that transparent.py and transparent-writers.py share, with its log of every command."""
import resource
import subprocess
import time

commands = []

# Every external command has a deadline: a stuck ditto, cmp, lsof or afsctool ends the run with a recorded 'timeout'
# row instead of waiting forever. A 4 GiB boundary copy took well under a minute on APFS; 30 minutes is the cap.
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
    if code not in ok:
        raise RuntimeError(row)
    return row
