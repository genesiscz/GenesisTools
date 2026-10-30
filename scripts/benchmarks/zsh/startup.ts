#!/usr/bin/env bun
/**
 * What `tools zsh completions` and the `tools zsh hook` line cost an interactive zsh start.
 *
 * Every arm is a COPY of the rc file in its own folder, passed to zsh through `ZDOTDIR`; the real rc is only read.
 * Each run is `/usr/bin/time -p zsh -i -c exit`. The arms are interleaved (A, B, C, … then again), each arm gets one
 * warm-up run first (it builds that folder's compinit dump), and the agent variables (`CLAUDECODE`, `CODEX_SHELL`,
 * …) are removed, so the rc takes the branches a terminal takes.
 *
 * Arms:
 *   off         the rc as it is
 *   on          the rc after `tools zsh completions --yes --replace-hand`: every CLI found is wired by the block
 *   block-only  the rc as it is plus a block that wires every CLI found (hand blocks kept): the block's own cost
 *   no-hook     the rc without its `eval "$(tools zsh hook …)"` line
 *   empty       an empty rc
 *   hook-alone  an rc holding only that hook line
 *   compinit    an rc holding only `autoload -Uz compinit && compinit -C`
 *   compinit+block  that plus the block wiring every CLI found: the block's cost without the rest of the rc's noise
 *
 *   bun scripts/benchmarks/zsh/startup.ts [--runs 10] [--rc ~/.zshrc] [--work <dir>]
 *
 * CPU (user + sys, from rusage) is the steadier metric; wall time and `time -p` real are printed beside it, and the
 * load average is printed with the numbers.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { detectProviders, generateCompletions } from "@app/zsh/lib/completions/generate";
import { COMPLETION_PROVIDERS } from "@app/zsh/lib/completions/providers";
import { findHandBlocks, isReplaceable, planCompletions, renderBlock } from "@app/zsh/lib/completions/rc-block";
import { emptyState } from "@app/zsh/lib/completions/state";
import { env } from "@genesiscz/utils/env";
import { out } from "@genesiscz/utils/logger";
import { formatTable } from "@genesiscz/utils/table";
import { Command } from "commander";

const AGENT_VARIABLES = ["CLAUDECODE", "CLAUDE_CODE", "CODEX_SHELL", "CLAUDE_CODE_ENTRYPOINT", "CODEX_SANDBOX"];
const RUN_TIMEOUT_MS = 30_000;
const COMPINIT = "autoload -Uz compinit && compinit -C";

interface Sample {
    /** `real` from `/usr/bin/time -p`: 10 ms resolution, the cross-check. */
    timeRealMs: number;
    /** Wall time around the spawn, sub-millisecond. */
    wallMs: number;
    /** User + sys CPU of `/usr/bin/time` and everything it waited for (rusage), microsecond resolution. */
    cpuMs: number;
    exitCode: number;
}

interface Arm {
    name: string;
    dir: string;
    samples: Sample[];
}

interface Spread {
    median: number;
    min: number;
    max: number;
}

function spread(values: number[]): Spread {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
    return { median, min: sorted[0] ?? 0, max: sorted.at(-1) ?? 0 };
}

/** True for the line that runs the hook at shell start, not an alias or a comment that mentions it. */
function isHookLine(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.includes("tools zsh hook") && !trimmed.startsWith("#") && !trimmed.startsWith("alias ");
}

function childEnv(zdotdir: string): Record<string, string> {
    const base = env.getProcessEnv();
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(base)) {
        if (value !== undefined && !AGENT_VARIABLES.includes(key)) {
            result[key] = value;
        }
    }

    result.ZDOTDIR = zdotdir;
    result.TERM = result.TERM ?? "xterm-256color";
    return result;
}

async function runOnce(dir: string): Promise<Sample> {
    const started = performance.now();
    const proc = Bun.spawn(["/usr/bin/time", "-p", "zsh", "-i", "-c", "exit"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        env: childEnv(dir),
        timeout: RUN_TIMEOUT_MS,
        killSignal: "SIGKILL",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    const wallMs = performance.now() - started;
    const real = stderr.match(/^real\s+([\d.]+)$/m);
    const usage = proc.resourceUsage();

    if (!real || !usage) {
        throw new Error(`no timing for ${dir}: ${stderr.slice(-300)}`);
    }

    return {
        timeRealMs: Number(real[1]) * 1000,
        wallMs,
        // bun 1.4 hands these out as bigint at runtime although its types say number.
        cpuMs: (Number(usage.cpuTime.user) + Number(usage.cpuTime.system)) / 1000,
        exitCode,
    };
}

function writeArm(work: string, name: string, rcText: string, zshenv: string | undefined): Arm {
    const dir = join(work, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".zshrc"), rcText);

    if (zshenv) {
        copyFileSync(zshenv, join(dir, ".zshenv"));
    }

    return { name, dir, samples: [] };
}

async function main(): Promise<void> {
    const program = new Command()
        .name("zsh-startup")
        .option("--runs <n>", "measured runs per arm", "10")
        .option("--rc <path>", "the rc file to copy", join(env.paths.getHome(), ".zshrc"))
        .option("--work <dir>", "folder for the arm copies (default: a new temp folder)")
        .parse();
    const opts = program.opts<{ runs: string; rc: string; work?: string }>();
    const runs = Number(opts.runs);

    if (!Number.isInteger(runs) || runs < 1) {
        throw new Error("--runs must be a positive integer");
    }

    const work = opts.work ?? mkdtempSync(join(tmpdir(), "gt-zsh-startup-"));
    mkdirSync(work, { recursive: true });
    const rcText = readFileSync(opts.rc, "utf8");
    const zshenvPath = join(env.paths.getHome(), ".zshenv");
    const zshenv = existsSync(zshenvPath) ? zshenvPath : undefined;
    const home = env.paths.getHome();
    const completionsDir = join(work, "completions");

    const found = detectProviders(COMPLETION_PROVIDERS).map((entry) => entry.provider);
    const generated = await generateCompletions({ providers: found, completionsDir, state: emptyState() });
    const providers = generated.filter((result) => result.installed && !result.error).map((result) => result.provider);
    const onPlan = planCompletions({
        rcText,
        selected: providers,
        replace: findHandBlocks(rcText, providers).filter(isReplaceable),
        completionsDir,
        home,
    });
    const blockOnly = `${rcText.replace(/\n*$/, "")}\n\n${renderBlock({ providers, completionsDir, home })}\n`;
    const hookLines = rcText.split("\n").filter(isHookLine);
    const noHook = rcText
        .split("\n")
        .filter((line) => !isHookLine(line))
        .join("\n");

    const arms = [
        writeArm(work, "off", rcText, zshenv),
        writeArm(work, "on", onPlan.after, zshenv),
        writeArm(work, "block-only", blockOnly, zshenv),
        writeArm(work, "no-hook", noHook, zshenv),
        writeArm(work, "empty", "", zshenv),
        writeArm(work, "hook-alone", `${hookLines.join("\n")}\n`, zshenv),
        writeArm(work, "compinit", `${COMPINIT}\n`, zshenv),
        writeArm(
            work,
            "compinit+block",
            `${COMPINIT}\n\n${renderBlock({ providers, completionsDir, home })}\n`,
            zshenv
        ),
    ];

    out.log.info(
        `Arms in ${work}; CLIs wired: ${providers.map((provider) => provider.cli).join(", ")}; hook line: ${hookLines.length > 0 ? hookLines.join(" | ") : "none"}`
    );

    for (const arm of arms) {
        await runOnce(arm.dir);
    }

    for (let round = 0; round < runs; round++) {
        const order = round % 2 === 0 ? arms : [...arms].reverse();

        for (const arm of order) {
            arm.samples.push(await runOnce(arm.dir));
        }
    }

    const rows = arms.map((arm) => {
        const wall = spread(arm.samples.map((sample) => sample.wallMs));
        const cpu = spread(arm.samples.map((sample) => sample.cpuMs));
        const timeReal = spread(arm.samples.map((sample) => sample.timeRealMs));
        const exits = [...new Set(arm.samples.map((sample) => sample.exitCode))].join(",");
        return { arm: arm.name, wall, cpu, timeReal, exits };
    });
    const byName = Object.fromEntries(rows.map((row) => [row.arm, row]));
    const delta = (a: string, b: string, key: "wall" | "cpu"): string =>
        ((byName[a]?.[key].median ?? 0) - (byName[b]?.[key].median ?? 0)).toFixed(1);
    const range = (value: Spread): string => `${value.min.toFixed(1)}-${value.max.toFixed(1)}`;

    out.println(
        formatTable(
            rows.map((row) => [
                row.arm,
                row.wall.median.toFixed(1),
                range(row.wall),
                row.cpu.median.toFixed(1),
                range(row.cpu),
                `${row.timeReal.median.toFixed(0)} (${row.timeReal.min.toFixed(0)}-${row.timeReal.max.toFixed(0)})`,
                row.exits,
            ]),
            ["ARM", "WALL MEDIAN ms", "WALL MIN-MAX", "CPU MEDIAN ms", "CPU MIN-MAX", "time -p REAL ms", "EXIT"]
        )
    );
    out.println(
        [
            `on - off:            wall ${delta("on", "off", "wall")} ms, cpu ${delta("on", "off", "cpu")} ms`,
            `block-only - off:    wall ${delta("block-only", "off", "wall")} ms, cpu ${delta("block-only", "off", "cpu")} ms`,
            `off - no-hook:       wall ${delta("off", "no-hook", "wall")} ms, cpu ${delta("off", "no-hook", "cpu")} ms (the hook line in the full rc)`,
            `hook-alone - empty:  wall ${delta("hook-alone", "empty", "wall")} ms, cpu ${delta("hook-alone", "empty", "cpu")} ms (the hook line alone)`,
            `compinit+block - compinit: wall ${delta("compinit+block", "compinit", "wall")} ms, cpu ${delta("compinit+block", "compinit", "cpu")} ms (the block alone)`,
            `n=${runs} per arm, interleaved; load average ${loadavg()
                .map((value) => value.toFixed(2))
                .join(" ")}`,
        ].join("\n")
    );
    out.result({ runs, work, loadavg: loadavg(), wired: providers.map((provider) => provider.cli), arms: rows });
}

main().catch((error) => {
    out.log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
