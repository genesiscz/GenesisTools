#!/usr/bin/env bun
/**
 * What one Bash tool call costs in the diff hook (pre phase plus post phase), A/B in one run. Written for the
 * `git status` change of 2026-10-12: the hooks run one status per root in each phase, and the status was the largest
 * part of the call.
 *
 * Two ways to choose the arms:
 *
 *   --before <checkout>  two checkouts, the old code against this one, both on the default config.
 *   --modes              one arm per status mode and driver on this checkout: `git`, `narrow-git`,
 *                        `snapshot:watchman`, `snapshot:parcel`. Each arm is its own sandbox `hooks.json` (the
 *                        mode active for both command shapes). The sandbox runs its own GenesisTools service and a
 *                        private Watchman daemon, both stopped at the end, and one warm-up call per snapshot arm
 *                        opens and seeds the root before anything is measured.
 *
 * One call is `hook-pre.ts`, the command's effect, then `hook-diff-post.ts`, each a fresh bun
 * process fed a payload, as the harness runs them. CPU is the two processes' rusage, which includes
 * the git and tar processes they waited for. With `--modes`, `serviceCpuMs` and `watcherCpuMs` are the CPU the
 * service and the Watchman daemon spent during that call (read before and after it). Two command shapes per arm:
 *
 *   edit  a runner command that edits the file it names and a file it does not name
 *   read  a read-only command (`rg`) that changes nothing
 *
 * The git spawns per call are counted in-process (`withSpawnCounter`), once per arm and shape:
 * counts are deterministic. `renderedFiles` and `printed` are check values: every arm must render the same files.
 *
 * The target repository is a shared clone of this checkout (every tracked file) with 5 edited files
 * and one untracked directory, the shape of a working session. The arm order rotates per run.
 *
 * Isolation: TMPDIR and GENESIS_TOOLS_HOME point at a scratch directory for this process and its
 * children, so no real capture, ledger, change log, decision log, service or watch is read or written.
 *
 * ```
 * bun scripts/benchmarks/hooks/status-ab.ts --before <checkout of the old code> [--runs 9] [--baseline | --compare] [--json]
 * bun scripts/benchmarks/hooks/status-ab.ts --modes [--runs 15] [--json]
 * ```
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DEFAULT_HOOKS_CONFIG } from "@app/agents/lib/hooks/config";
import type { capturePre, captureStart } from "@app/agents/lib/hooks/diff/capture";
import type { postRoots, runDiffPost } from "@app/agents/lib/hooks/diff/run";
import type { prepareStatus } from "@app/agents/lib/hooks/diff/status/prepare";
import { type BaselineMetrics, withSpawnCounter } from "@app/benchmark/lib";
import { env } from "@genesiscz/utils/env";
import type { WatchDriverId } from "@genesiscz/utils/fs/watch-driver/registry";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { readProcessUsages } from "@genesiscz/utils/process/processes";
import { genesisToolsDirIn } from "@genesiscz/utils/storage/root";
import { finishBench, parseBenchArgs } from "../fs/shared";
import { type PrivateWatchman, startPrivateWatchman } from "./private-watchman";

const args = parseBenchArgs(process.argv);
const MODES = process.argv.includes("--modes");
const beforeIndex = process.argv.indexOf("--before");

if (!MODES && (beforeIndex < 0 || !process.argv[beforeIndex + 1])) {
    out.println(
        "--before <checkout> or --modes is required: a checkout of the code to compare against, or one arm per status mode"
    );
    process.exit(1);
}

const HERE = resolve(import.meta.dir, "..", "..", "..");
const SHAPES = ["edit", "read"] as const;
type Shape = (typeof SHAPES)[number];

/** One arm: the checkout its hooks run from, and the `diff` part of its sandbox `hooks.json`. */
interface ArmSpec {
    dir: string;
    diff: Record<string, unknown>;
    /** The snapshot driver this arm's mode asks the service for; absent for an arm with no service. */
    driver?: WatchDriverId;
}

const BASE_DIFF = { highlight: "none" };
const NO_PARITY_SAMPLE = 1_000_000_000;

function modeArm(mode: string, driver?: WatchDriverId): ArmSpec {
    return {
        dir: HERE,
        diff: {
            ...BASE_DIFF,
            status: {
                active: { read: mode, write: mode },
                // With a mode other than `git` active, a sampled call also reads the git reference for parity
                // (`prepareStatus`), which is a full status. No call is sampled here, so an arm costs its mode only.
                shadow: { every: NO_PARITY_SAMPLE },
                ...(driver ? { modes: { snapshot: { driver } } } : {}),
            },
        },
        ...(driver ? { driver } : {}),
    };
}

const ARMS: Record<string, ArmSpec> = MODES
    ? {
          git: modeArm("git"),
          "narrow-git": modeArm("narrow-git"),
          "snapshot:watchman": modeArm("snapshot", "watchman"),
          "snapshot:parcel": modeArm("snapshot", "parcel"),
      }
    : {
          before: { dir: resolve(process.argv[beforeIndex + 1] ?? ""), diff: BASE_DIFF },
          after: { dir: HERE, diff: BASE_DIFF },
      };
const ARM_IDS = Object.keys(ARMS);

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "gt-bench-status-")));

const HOOK_DEADLINE_MS = 60_000;

async function benchmark(): Promise<void> {
    const SANDBOX_TMP = join(SCRATCH, "tmp");
    const SANDBOX_HOME = join(SCRATCH, "home");
    const HOOKS_JSON = genesisToolsDirIn(SANDBOX_HOME, "agents", "hooks.json");

    // The sandbox is this whole process's environment on purpose: the hook modules imported below build their paths from
    // it at call time, and every hook child inherits it. A scoped override would reach neither.
    process.env.TMPDIR = SANDBOX_TMP;
    process.env.GENESIS_TOOLS_HOME = SANDBOX_HOME;
    mkdirSync(SANDBOX_TMP, { recursive: true });
    mkdirSync(genesisToolsDirIn(SANDBOX_HOME, "agents"), { recursive: true });

    function storedConfig(arm: string): Record<string, unknown> {
        return { shadow: false, diff: ARMS[arm]?.diff ?? BASE_DIFF };
    }

    let writtenFor: string | null = null;

    /** The sandbox `hooks.json` of an arm; each hook child reads it fresh. */
    function selectArm(arm: string): void {
        if (writtenFor === arm) {
            return;
        }

        writeFileSync(HOOKS_JSON, SafeJSON.stringify(storedConfig(arm)));
        writtenFor = arm;
    }

    selectArm(ARM_IDS[0] ?? "");

    function git(root: string, gitArgs: string[]): string {
        const run = spawnSync("git", ["-C", root, ...gitArgs], { encoding: "utf8" });

        if (run.status !== 0) {
            throw new Error(`git ${gitArgs.join(" ")} failed in ${root}: ${run.stderr}`);
        }

        return run.stdout;
    }

    const ROOT = join(SCRATCH, "repo");
    git(SCRATCH, ["clone", "-q", "--shared", HERE, ROOT]);

    const tracked = git(ROOT, ["ls-files"]).split("\n").filter(Boolean);
    const dirty = tracked
        .filter((file) => file.startsWith("src/agents/lib/hooks/") && file.endsWith(".ts"))
        .slice(0, 5);
    const TARGET = dirty[0] ?? "README.md";

    /**
     * Moves a file's mtime an hour back. The post phase admits a file changed since the command's start
     * in WHOLE seconds, so a file written by the previous call in the same second would count as this
     * call's change and make the arms do different work depending on the clock.
     */
    function age(name: string): void {
        const past = Date.now() / 1000 - 3600;

        utimesSync(join(ROOT, name), past, past);
    }

    for (const file of dirty) {
        appendFileSync(join(ROOT, file), "\n// bench: dirty before the session's command\n");
        age(file);
    }

    mkdirSync(join(ROOT, "notes-scratch"), { recursive: true });

    for (let index = 0; index < 3; index += 1) {
        writeFileSync(join(ROOT, "notes-scratch", `note-${index}.md`), `note ${index}\n`);
        age(`notes-scratch/note-${index}.md`);
    }

    const COMMANDS: Record<Shape, string> = { edit: `bun scripts/fmt.ts ${TARGET}`, read: `rg needle ${TARGET}` };
    const UNNAMED = "bench-unnamed.md";
    /**
     * ONE session for every arm. With one per arm, a file another arm's call wrote in the same second
     * reads as another session's change (the touches ledger), is not diffed, and the arms do different
     * work depending on the clock.
     */
    const SESSION = "bench";
    let callCounter = 0;

    function act(shape: Shape, label: string): void {
        if (shape === "read") {
            return;
        }

        appendFileSync(join(ROOT, TARGET), `// ${label}\n`);
        writeFileSync(join(ROOT, UNNAMED), `${label}\n`);
    }

    /** After the post phase: what this call changed is older than the next call's start, as in real use. */
    function settle(shape: Shape): void {
        if (shape === "edit") {
            age(TARGET);
            age(UNNAMED);
        }
    }

    /** The two daemons of `--modes`: the sandbox service and the private Watchman. */
    interface Daemons {
        service: ReturnType<typeof Bun.spawn>;
        watchman: PrivateWatchman | null;
    }

    /** CPU ms of each daemon so far, read from the kernel in one call; 0 for a daemon that is gone. */
    function daemonCpu(daemons: Daemons | null): { service: number; watcher: number } {
        if (!daemons) {
            return { service: 0, watcher: 0 };
        }

        const watchmanPid = daemons.watchman?.pid() ?? null;
        const pids = [daemons.service.pid, ...(watchmanPid ? [watchmanPid] : [])];
        const usages = readProcessUsages(pids);
        return {
            service: usages.get(daemons.service.pid)?.cpuTimeMs ?? 0,
            watcher: watchmanPid ? (usages.get(watchmanPid)?.cpuTimeMs ?? 0) : 0,
        };
    }

    function spawnHook(arm: string, entry: string, payload: Record<string, unknown>) {
        const started = performance.now();
        const run = Bun.spawnSync(["bun", join(ARMS[arm]?.dir ?? HERE, "src/agents/bin", entry)], {
            stdin: Buffer.from(SafeJSON.stringify(payload)),
            env: env.getProcessEnv(),
            timeout: HOOK_DEADLINE_MS,
        });

        if (run.signalCode) {
            throw new Error(`${arm} ${entry} ended by signal ${run.signalCode} (deadline ${HOOK_DEADLINE_MS} ms)`);
        }

        if (run.exitCode !== 0) {
            throw new Error(`${arm} ${entry} exited ${run.exitCode}: ${run.stderr.toString()}`);
        }

        return {
            wallMs: performance.now() - started,
            cpuMs: Number(run.resourceUsage.cpuTime.total) / 1000,
            printed: run.stdout.length > 0,
        };
    }

    /** One tool call end to end: the pre hook, the command's effect, the post hook. */
    function endToEnd(arm: string, shape: Shape, daemons: Daemons | null) {
        callCounter += 1;
        selectArm(arm);

        const base = {
            tool_name: "Bash",
            cwd: ROOT,
            session_id: SESSION,
            tool_use_id: `bench-${arm.replace(/[^a-z0-9-]/gi, "-")}-${callCounter}`,
            tool_input: { command: COMMANDS[shape] },
        };
        const cpuBefore = daemonCpu(daemons);
        const pre = spawnHook(arm, "hook-pre.ts", { ...base, hook_event_name: "PreToolUse" });

        act(shape, `${arm} ${callCounter}`);

        const post = spawnHook(arm, "hook-diff-post.ts", {
            ...base,
            hook_event_name: "PostToolUse",
            tool_response: { stdout: "" },
        });
        const cpuAfter = daemonCpu(daemons);

        settle(shape);

        return {
            cpuMs: pre.cpuMs + post.cpuMs,
            wallMs: pre.wallMs + post.wallMs,
            printed: post.printed,
            serviceCpuMs: Math.max(0, cpuAfter.service - cpuBefore.service),
            watcherCpuMs: Math.max(0, cpuAfter.watcher - cpuBefore.watcher),
        };
    }

    type Post = typeof runDiffPost;
    type Payload = Parameters<typeof capturePre>[0];
    type HookConfig = typeof DEFAULT_HOOKS_CONFIG;
    type LegacyPost = (payload: Payload, config: HookConfig) => ReturnType<Post>;

    interface HookModules {
        capturePre: typeof capturePre;
        captureStart: typeof captureStart | undefined;
        runDiffPost: Post;
        postRoots: typeof postRoots | undefined;
        prepareStatus: typeof prepareStatus | undefined;
        config: HookConfig;
    }

    async function loadArm(arm: string): Promise<HookModules> {
        const dir = ARMS[arm]?.dir ?? HERE;
        const capture = await import(join(dir, "src/agents/lib/hooks/diff/capture.ts"));
        const run = await import(join(dir, "src/agents/lib/hooks/diff/run.ts"));
        const config = await import(join(dir, "src/agents/lib/hooks/config.ts"));

        if (!MODES) {
            const base: HookConfig = config.DEFAULT_HOOKS_CONFIG;
            const runPost: Post | LegacyPost = run.runDiffPost;
            // The October baseline took positional payload and config, both before the first default parameter.
            const post: Post =
                runPost.length >= 2
                    ? ({ payload, config }) => (runPost as LegacyPost)(payload, config)
                    : (runPost as Post);

            return {
                capturePre: capture.capturePre,
                captureStart: undefined,
                runDiffPost: post,
                postRoots: undefined,
                prepareStatus: undefined,
                config: { ...base, diff: { ...base.diff, highlight: "none" } },
            };
        }

        const prepare = await import(join(dir, "src/agents/lib/hooks/diff/status/prepare.ts"));

        return {
            capturePre: capture.capturePre,
            captureStart: capture.captureStart,
            runDiffPost: run.runDiffPost,
            postRoots: run.postRoots,
            prepareStatus: prepare.prepareStatus,
            config: config.mergeStoredConfig(storedConfig(arm)),
        };
    }

    /**
     * git processes one call starts in the hooks, all of them and the `git status` ones. Deterministic, so N = 1. With
     * `--modes` it runs the entry points' order (captureStart, prepareStatus, capturePre; postRoots, prepareStatus,
     * runDiffPost), so a snapshot arm's status reads happen in the service and are not counted here.
     */
    async function countSpawns(arm: string, shape: Shape) {
        const hooks = await loadArm(arm);

        callCounter += 1;

        const payload = {
            event: "PreToolUse",
            tool: "Bash",
            cwd: ROOT,
            sessionId: SESSION,
            toolUseId: `bench-count-${callCounter}`,
            command: COMMANDS[shape],
            model: "",
            harness: "claude",
            caller: "claude",
            nativeDiffFiles: [],
            raw: {},
        } satisfies Payload;
        const call = {
            harness: payload.harness,
            sessionId: SESSION,
            toolUseId: payload.toolUseId,
            command: payload.command,
            dir: ROOT,
        };
        const counted = await withSpawnCounter(async () => {
            const { captureStart, postRoots, prepareStatus } = hooks;

            if (!captureStart || !postRoots || !prepareStatus) {
                hooks.capturePre(payload, hooks.config.diff);
                act(shape, `count ${arm} ${callCounter}`);
                return hooks.runDiffPost({ payload, config: hooks.config });
            }

            const statusConfig = hooks.config.diff.status;
            const start = captureStart(payload, hooks.config.diff);
            const need = start.readOnly ? "deletions" : "all";
            const preStatus = await prepareStatus({
                phase: "pre",
                roots: start.roots,
                need,
                call,
                config: statusConfig,
            });
            hooks.capturePre(payload, hooks.config.diff, { start, status: preStatus });
            act(shape, `count ${arm} ${callCounter}`);
            const roots = postRoots(payload)?.roots ?? [];
            const postStatus = await prepareStatus({ phase: "post", roots, need: "all", call, config: statusConfig });
            return hooks.runDiffPost({ payload, config: hooks.config, status: postStatus });
        });

        settle(shape);

        const gitSpawns = counted.spawns.filter((spawn) => spawn.cmd[0] === "git");

        return {
            git: gitSpawns.length,
            status: gitSpawns.filter((spawn) => spawn.cmd.includes("status")).length,
            files: counted.result.files.length,
            // The repository path is the same for every arm; dropping it keeps the list readable.
            commands: gitSpawns.map((spawn) => spawn.cmd.slice(1).join(" ").replaceAll(ROOT, "<repo>")),
        };
    }

    const WARM_DEADLINE_MS = 60_000;

    /**
     * Starts the sandbox service from this checkout (the hooks' own start request would run the `tools` on PATH, the
     * main checkout) with the private Watchman, then asks each snapshot driver for the root until it answers `ok`: the
     * first ask opens and seeds it in the background.
     */
    async function startDaemons(): Promise<Daemons> {
        const watchman = startPrivateWatchman(SCRATCH);
        const service = Bun.spawn(["bun", join(HERE, "src/genesis-tools/index.ts"), "serve"], {
            env: { ...env.getProcessEnv(), ...(watchman ? { WATCHMAN_SOCK: watchman.sock } : {}) },
            stdout: "ignore",
            stderr: Bun.file(join(SCRATCH, "service.stderr.log")),
        });
        const { callWorktreeSnapshot } = await import("@genesiscz/utils/genesis-tools/worktree/thin-client");
        const deadline = Date.now() + WARM_DEADLINE_MS;

        for (const arm of ARM_IDS) {
            const driver = ARMS[arm]?.driver;

            if (!driver) {
                continue;
            }

            let last = "not asked";

            while (Date.now() < deadline) {
                const answer = await callWorktreeSnapshot(
                    { root: ROOT, driver, fenceMs: 2_000 },
                    { deadlineMs: 5_000 }
                );

                if (answer.ok && answer.result.state === "ok") {
                    last = "ok";
                    break;
                }

                last = answer.ok ? (answer.result.state === "ok" ? "ok" : answer.result.reason) : answer.reason;
                await Bun.sleep(Math.min(250, Math.max(0, deadline - Date.now())));
            }

            // One ask on the hooks' own default bounds tells whether the measured calls can be answered by the service.
            const probe = await callWorktreeSnapshot({ root: ROOT, driver, fenceMs: 500 }, { deadlineMs: 700 });
            const probed = probe.ok ? (probe.result.state === "ok" ? "ok" : probe.result.reason) : probe.reason;
            out.println(`warm-up ${arm}: ${last}; one ask at 500/700 ms: ${probed} in ${probe.wallMs.toFixed(0)} ms`);
        }

        return { service, watchman };
    }

    async function stopDaemons(daemons: Daemons | null): Promise<void> {
        if (!daemons) {
            return;
        }

        daemons.service.kill("SIGTERM");
        await Promise.race([daemons.service.exited, Bun.sleep(5_000)]);

        if (daemons.service.exitCode === null) {
            daemons.service.kill("SIGKILL");
        }

        daemons.watchman?.stop();
    }

    const daemons = MODES ? await startDaemons() : null;
    const counts: BaselineMetrics = {};
    const commands: Record<string, string[]> = {};
    const runs: BaselineMetrics[] = [];
    let uptimeBefore = "";
    let uptimeAfter = "";

    try {
        for (const arm of ARM_IDS) {
            for (const shape of SHAPES) {
                const counted = await countSpawns(arm, shape);

                counts[`${arm}.${shape}.gitSpawns`] = counted.git;
                counts[`${arm}.${shape}.statusSpawns`] = counted.status;
                counts[`${arm}.${shape}.renderedFiles`] = counted.files;
                commands[`${arm}.${shape}`] = counted.commands;
            }
        }

        for (let warm = 0; warm < args.warmup; warm += 1) {
            for (const arm of ARM_IDS) {
                for (const shape of SHAPES) {
                    endToEnd(arm, shape, daemons);
                }
            }
        }

        uptimeBefore = spawnSync("uptime", { encoding: "utf8" }).stdout.trim();

        for (let run = 0; run < args.runs; run += 1) {
            // The order rotates per run, so no arm always runs right after the same one.
            const order = ARM_IDS.map((_, index) => ARM_IDS[(index + run) % ARM_IDS.length] ?? "");
            const metrics: BaselineMetrics = { ...counts };

            for (const arm of order) {
                for (const shape of SHAPES) {
                    const call = endToEnd(arm, shape, daemons);

                    metrics[`${arm}.${shape}.cpuMs`] = Number(call.cpuMs.toFixed(1));
                    metrics[`${arm}.${shape}.wallMs`] = Number(call.wallMs.toFixed(1));
                    metrics[`${arm}.${shape}.printed`] = call.printed ? 1 : 0;

                    if (MODES) {
                        metrics[`${arm}.${shape}.serviceCpuMs`] = Number(call.serviceCpuMs.toFixed(1));
                        metrics[`${arm}.${shape}.watcherCpuMs`] = Number(call.watcherCpuMs.toFixed(1));
                    }
                }
            }

            runs.push(metrics);
        }

        uptimeAfter = spawnSync("uptime", { encoding: "utf8" }).stdout.trim();
    } finally {
        await stopDaemons(daemons);
    }

    await finishBench({
        name: MODES ? "hooks-status-modes" : "hooks-status-ab",
        title: MODES
            ? "Bash diff hook, one tool call (pre + post), one arm per status mode and driver"
            : "Bash diff hook, one tool call (pre + post), before vs after",
        args,
        runs,
        // `printed` and `renderedFiles` are check values: a drop means an arm did less work, not better work.
        lowerIsBetter: Object.keys(runs[0] ?? {}).filter(
            (metric) => !metric.endsWith(".printed") && !metric.endsWith(".renderedFiles")
        ),
        floor: Object.fromEntries(
            Object.keys(runs[0] ?? {})
                .filter((metric) => metric.endsWith("Ms"))
                .map((metric) => [metric, 5])
        ),
        notes: `${MODES ? "modes" : `before ${ARMS.before?.dir}`} | ${tracked.length} tracked files, ${dirty.length} dirty, 1 untracked directory | ${uptimeBefore} -> ${uptimeAfter}`,
        context: {
            scratch: SCRATCH,
            arms: Object.fromEntries(ARM_IDS.map((arm) => [arm, ARMS[arm]?.dir])),
            trackedFiles: tracked.length,
            commands,
        },
    });

    if (MODES) {
        const unequal = SHAPES.filter(
            (shape) => new Set(ARM_IDS.map((arm) => counts[`${arm}.${shape}.renderedFiles`])).size > 1
        );
        out.println(
            unequal.length === 0
                ? "renderedFiles: equal across arms"
                : `renderedFiles DIFFER across arms for ${unequal.join(", ")}: an arm did different work`
        );
    }

    out.println(`uptime before: ${uptimeBefore}`);
    out.println(`uptime after:  ${uptimeAfter}`);
}

try {
    await benchmark();
} finally {
    rmSync(SCRATCH, { recursive: true, force: true });
}
