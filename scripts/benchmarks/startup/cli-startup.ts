/**
 * User and system CPU for a command, repeated N times, reported as the median.
 *
 * CPU time is the metric; wall time on this Mac swings with load average, so the
 * wall column is context, never the verdict. Print `uptime` beside the run.
 *
 *   bun scripts/benchmarks/startup/cli-startup.ts "claude who" 7 bun src/claude/index.ts who --help
 */
const [, , label, repeatsRaw, ...cmd] = process.argv;

if (!label || !repeatsRaw || cmd.length === 0) {
    console.error('usage: bun scripts/benchmarks/startup/cli-startup.ts "<label>" <repeats> <cmd...>');
    process.exit(2);
}

const repeats = Number(repeatsRaw);
if (!Number.isInteger(repeats) || repeats <= 0) {
    console.error("repeats must be a positive integer");
    process.exit(2);
}

const user: number[] = [];
const sys: number[] = [];
const cpuTotals: number[] = [];
const wall: number[] = [];

for (let i = 0; i < repeats; i++) {
    const started = performance.now();
    const proc = Bun.spawn(["/usr/bin/time", "-p", ...cmd], { stdout: "ignore", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    wall.push(performance.now() - started);

    if (proc.exitCode !== 0) {
        console.error(stderr.slice(-400));
        throw new Error(`measured command exited ${proc.exitCode}`);
    }

    const userMatch = stderr.match(/^user\s+([\d.]+)$/m);
    const sysMatch = stderr.match(/^sys\s+([\d.]+)$/m);

    if (!userMatch || !sysMatch) {
        console.error(stderr.slice(-400));
        throw new Error("`/usr/bin/time -p` printed no user/sys line");
    }

    const userSec = Number(userMatch[1]);
    const sysSec = Number(sysMatch[1]);
    user.push(userSec);
    sys.push(sysSec);
    cpuTotals.push(userSec + sysSec);
}

const median = (values: number[]): number => {
    if (values.length === 0) {
        return 0;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 1) {
        return sorted[mid] ?? 0;
    }

    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

const cpu = median(cpuTotals);

console.log(
    `${label}\tuser ${median(user).toFixed(3)}s\tsys ${median(sys).toFixed(3)}s\tcpu ${cpu.toFixed(3)}s\twall ${median(wall).toFixed(0)}ms\tn=${repeats}`
);
