import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { asCpuProfile, type CpuProfile } from "./cpuprofile";

const { log } = logger.scoped("ts-profile");

/** The longest one run is sampled across threads; `sample` stops by itself as soon as the process exits. */
const THREAD_SAMPLE_SECONDS = 600;

export interface ProfileRunOptions {
    /** The Bun binary to profile with. */
    bun: string;
    entry: string;
    args: string[];
    cwd: string;
    runs: number;
    intervalUs: number;
    outDir: string;
    /** Also sample every thread of the first run with `/usr/bin/sample` (macOS only). */
    threads: boolean;
}

export interface ProfileRun {
    exitCode: number;
    /** User plus system CPU of the whole process, every thread. */
    cpuMs: number;
    wallMs: number;
    profilePath: string;
    /** Null when the process wrote no profile (it crashed, or called `process.exit` before Bun could write it). */
    profile: CpuProfile | null;
    threadSamplePath?: string;
    stderrTail: string;
}

/**
 * Runs the entry `runs` times under `bun --cpu-prof`, one after another, and reads each profile back. The profiled
 * program's own output is discarded; its stderr tail is kept for the report when it fails.
 */
export async function runProfiled(options: ProfileRunOptions): Promise<ProfileRun[]> {
    mkdirSync(options.outDir, { recursive: true });
    const runs: ProfileRun[] = [];

    for (let index = 0; index < options.runs; index++) {
        const name = `run-${index + 1}.cpuprofile`;
        const profilePath = join(options.outDir, name);
        const argv = [
            options.bun,
            "--cpu-prof",
            `--cpu-prof-dir=${options.outDir}`,
            `--cpu-prof-name=${name}`,
            `--cpu-prof-interval=${options.intervalUs}`,
            "run",
            options.entry,
            ...options.args,
        ];
        log.debug({ argv, cwd: options.cwd }, "ts profile: starting a run");
        const started = performance.now();
        const child = Bun.spawn(argv, {
            cwd: options.cwd,
            env: env.getProcessEnv(),
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
        });
        const sampleThreads = options.threads && index === 0 && process.platform === "darwin";
        const threadSamplePath = sampleThreads ? join(options.outDir, "threads.txt") : undefined;
        const sampler = threadSamplePath
            ? Bun.spawn(
                  [
                      "/usr/bin/sample",
                      String(child.pid),
                      String(THREAD_SAMPLE_SECONDS),
                      "1",
                      "-mayDie",
                      "-file",
                      threadSamplePath,
                  ],
                  { stdout: "ignore", stderr: "ignore" }
              )
            : undefined;
        const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        const wallMs = performance.now() - started;
        await sampler?.exited;
        let profile: CpuProfile | null = null;

        try {
            profile = asCpuProfile(SafeJSON.parse(await Bun.file(profilePath).text(), { strict: true }));
        } catch (err) {
            log.warn({ err, profilePath }, "ts profile: the run wrote no readable profile");
        }

        runs.push({
            exitCode,
            cpuMs: Number(child.resourceUsage()?.cpuTime.total ?? 0) / 1000,
            wallMs,
            profilePath,
            profile,
            threadSamplePath,
            stderrTail: stderr.slice(-2000),
        });
    }

    return runs;
}
