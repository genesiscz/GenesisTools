/**
 * CPU time of the two `tools question` calls every Claude session's mods run, in fresh processes, before and after
 * (2026-10-27). It writes only caches: the inbox cursor snapshots, and the transcript-rows index in a scratch
 * GENESIS_TOOLS_HOME so the cold arm stays cold.
 *
 *   bun scripts/benchmarks/question/question-calls.ts --before <old checkout> --runs 7 \
 *       --session <id> [--session <id> ...] --transcript <path>
 *
 * Arms, interleaved per run (ABAB, reversed on odd runs):
 * - inbox-before / inbox-after: `inbox --session <id> --json --all-items` with no cursor (a full answer).
 * - inbox-since: the same with `--since` the cursor of a full answer just before (nothing changed).
 * - rows-grep: the plugin's old search, `grep` of the whole transcript plus the line-count check.
 * - rows-cold: `transcript-rows` with an empty index (the first call for a transcript).
 * - rows-warm: `transcript-rows` with the index at the transcript's end (the call every later poll makes).
 * The CPU of a child includes the processes it waited for (macOS adds them at exit).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.flatMap((arg, i) => (arg === name && argv[i + 1] ? [argv[i + 1]] : []));
const before = flag("--before")[0];
const runs = Number(flag("--runs")[0] ?? "7");
const sessions = flag("--session");
const transcript = flag("--transcript")[0];
const after = join(import.meta.dirname, "..", "..", "..");

if (!before || sessions.length === 0 || !transcript) {
    console.error("usage: question-calls.ts --before <checkout> --session <id> --transcript <path> [--runs 7]");
    process.exit(2);
}

interface Sample {
    cpuMs: number;
    bytes: number;
}

async function run(cmd: string[], env: Record<string, string> = {}): Promise<Sample & { stdout: string }> {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    if (proc.exitCode !== 0) {
        throw new Error(
            `${cmd.join(" ")} exited ${proc.exitCode}: ${(await new Response(proc.stderr).text()).slice(-300)}`
        );
    }

    const usage = proc.resourceUsage();
    return { cpuMs: usage ? Number(usage.cpuTime.total) / 1000 : Number.NaN, bytes: stdout.length, stdout };
}

const inbox = (tree: string, session: string, extra: string[] = []) => [
    "bun",
    join(tree, "src/question/index.ts"),
    "inbox",
    "--session",
    session,
    "--json",
    "--all-items",
    ...extra,
];
const grep = [
    "/bin/sh",
    "-c",
    'grep -F -e "DECISION" -e "mcp__genesis-tools__" -e "tools question" "$1" | grep -F \'"type":"assistant"\'; tail -c +"$2" "$1" | head -c 1 | wc -l',
    "sh",
    transcript,
    String(Bun.file(transcript).size),
];
const rows = ["bun", join(after, "src/question/index.ts"), "transcript-rows", "--transcript", transcript, "--json"];
const warmHome = mkdtempSync(join(tmpdir(), "question-calls-warm-"));
await run(rows, { GENESIS_TOOLS_HOME: warmHome });

const samples = new Map<string, Sample[]>();
const add = (arm: string, sample: Sample) => samples.set(arm, [...(samples.get(arm) ?? []), sample]);

for (let r = 0; r < runs; r++) {
    for (const session of r % 2 ? [...sessions].reverse() : sessions) {
        const order = r % 2 ? ["after", "before"] : ["before", "after"];

        for (const arm of order) {
            add(`inbox-${arm} ${session.slice(0, 8)}`, await run(inbox(arm === "after" ? after : before, session)));
        }

        const full = await run(inbox(after, session));
        const answer: unknown = SafeJSON.parse(full.stdout, { strict: true });
        const cursor = typeof answer === "object" && answer !== null && "cursor" in answer ? String(answer.cursor) : "";
        add(`inbox-since ${session.slice(0, 8)}`, await run(inbox(after, session, ["--since", cursor])));
    }

    add("rows-grep", await run(grep));
    add("rows-cold", await run(rows, { GENESIS_TOOLS_HOME: mkdtempSync(join(tmpdir(), "question-calls-cold-")) }));
    add("rows-warm", await run(rows, { GENESIS_TOOLS_HOME: warmHome }));
}

const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

console.log(`bun ${Bun.version}, ${runs} runs, transcript ${(Bun.file(transcript).size / 1e6).toFixed(0)} MB`);

for (const [arm, list] of samples) {
    const cpu = list.map((sample) => sample.cpuMs);
    console.log(
        `${arm.padEnd(26)} median ${median(cpu).toFixed(0).padStart(5)} ms CPU  [${cpu.map((v) => v.toFixed(0)).join(" ")}]  ${list[0]?.bytes ?? 0} B`
    );
}
