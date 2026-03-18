import { spawn as nodeSpawn } from "node:child_process";
import { resolve } from "node:path";
import { formatDuration, parseDuration } from "@app/utils/format";
import { withCancel } from "@app/utils/prompts/clack/helpers";
import { Storage } from "@app/utils/storage/storage";
import { formatTable } from "@app/utils/table";
import * as p from "@clack/prompts";
import { Command } from "commander";
import pc from "picocolors";

// ============================================
// Types
// ============================================

interface TimerEntry {
    id: string;
    pid: number;
    title: string;
    durationMs: number;
    endTime: number;
    notify: boolean;
    say: boolean;
    repeat: number;
    currentCycle: number;
}

interface ActiveTimers {
    timers: TimerEntry[];
}

type CompletionAction = "notify" | "say";

const MAX_TIMEOUT_MS = 2_147_483_647;

interface TimerOptions {
    durationMs: number;
    title: string;
    notify: boolean;
    say: boolean;
    repeat: number;
}

interface TimerCliFlags {
    notify?: boolean;
    say?: boolean;
    bg?: boolean;
    repeat?: number;
}

// ============================================
// Storage
// ============================================

const storage = new Storage("timer");

async function getActiveTimers(): Promise<ActiveTimers> {
    await storage.ensureDirs();
    const data = await storage.getConfig<ActiveTimers>();
    return data ?? { timers: [] };
}

async function saveActiveTimers(data: ActiveTimers): Promise<void> {
    await storage.setConfig(data);
}

async function addActiveTimer(entry: TimerEntry): Promise<void> {
    await storage.withConfigLock(async () => {
        const data = await getActiveTimers();
        data.timers.push(entry);
        await saveActiveTimers(data);
    });
}

async function removeActiveTimer(id: string): Promise<void> {
    await storage.withConfigLock(async () => {
        const data = await getActiveTimers();
        data.timers = data.timers.filter((t) => t.id !== id);
        await saveActiveTimers(data);
    });
}

export function generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ============================================
// Countdown display
// ============================================

export function formatCountdown(remainingMs: number): string {
    if (remainingMs <= 0) {
        return "00:00";
    }

    const totalSeconds = Math.ceil(remainingMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }

    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

async function runForegroundTimer(opts: TimerOptions): Promise<void> {
    const { durationMs, title, notify, say, repeat } = opts;

    for (let cycle = 1; cycle <= repeat; cycle++) {
        if (repeat > 1) {
            console.log(pc.cyan(`\nCycle ${cycle}/${repeat}`));
        }

        const endTime = Date.now() + durationMs;

        process.stdout.write(pc.dim(`  ${title}  `) + pc.bold(formatCountdown(durationMs)));

        const interval = setInterval(() => {
            const remaining = endTime - Date.now();

            if (remaining <= 0) {
                clearInterval(interval);
                return;
            }

            process.stdout.write(`\r${pc.dim(`  ${title}  `)}${pc.bold(formatCountdown(remaining))}`);
        }, 250);

        await new Promise<void>((resolve) => {
            const check = setInterval(() => {
                if (Date.now() >= endTime) {
                    clearInterval(check);
                    clearInterval(interval);
                    resolve();
                }
            }, 250);
        });

        process.stdout.write(`\r${pc.dim(`  ${title}  `)}${pc.green(pc.bold("Done!"))}\n`);

        await fireCompletionActions({ title, notify, say, cycle, totalCycles: repeat });

        if (cycle < repeat) {
            console.log(pc.dim("  Starting next cycle..."));
        }
    }
}

async function fireCompletionActions(opts: {
    title: string;
    notify: boolean;
    say: boolean;
    cycle: number;
    totalCycles: number;
}): Promise<void> {
    const { title, notify, say, cycle, totalCycles } = opts;
    const cycleLabel = totalCycles > 1 ? ` (${cycle}/${totalCycles})` : "";
    const message = `Timer done: ${title}${cycleLabel}`;
    const toolsDir = resolve(import.meta.dir, "..");

    const promises: Promise<void>[] = [];

    if (notify) {
        promises.push(spawnTools(toolsDir, ["notify", message, "-t", "Timer"]));
    }

    if (say) {
        promises.push(spawnTools(toolsDir, ["say", message, "--wait"]));
    }

    await Promise.allSettled(promises);
}

async function spawnTools(toolsDir: string, args: string[]): Promise<void> {
    const toolsPath = resolve(toolsDir, "..", "tools");
    const proc = Bun.spawn(["bun", "run", toolsPath, ...args], {
        stdio: ["ignore", "ignore", "ignore"],
    });
    await proc.exited;
}

// ============================================
// Background timer
// ============================================

async function startBackgroundTimer(opts: TimerOptions): Promise<void> {
    const { durationMs, title, notify, say, repeat } = opts;
    const id = generateId();
    const scriptPath = resolve(import.meta.dir, "index.ts");

    const child = nodeSpawn(
        "bun",
        ["run", scriptPath, "__bg-run__", String(durationMs), title, id, String(notify), String(say), String(repeat)],
        {
            stdio: "ignore",
            detached: true,
        }
    );

    child.unref();

    const pid = child.pid;

    if (!pid) {
        console.log(pc.red("Failed to start background timer process."));
        process.exit(1);
    }

    const entry: TimerEntry = {
        id,
        pid,
        title,
        durationMs,
        endTime: Date.now() + durationMs,
        notify,
        say,
        repeat,
        currentCycle: 1,
    };

    await addActiveTimer(entry);

    console.log(pc.green(`Timer started in background`));
    console.log(pc.dim(`  ID: ${id}  PID: ${pid}`));
    console.log(pc.dim(`  Duration: ${formatDuration(durationMs)}  Title: ${title}`));
}

async function handleBackgroundRun(args: string[]): Promise<void> {
    const durationMs = Number(args[0]);
    const title = args[1];
    const id = args[2];
    const notify = args[3] === "true";
    const say = args[4] === "true";
    const repeat = Number(args[5]);

    try {
        for (let cycle = 1; cycle <= repeat; cycle++) {
            await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
            await fireCompletionActions({ title, notify, say, cycle, totalCycles: repeat });

            if (cycle < repeat) {
                await storage.withConfigLock(async () => {
                    const data = await getActiveTimers();
                    const entry = data.timers.find((t) => t.id === id);

                    if (entry) {
                        entry.currentCycle = cycle + 1;
                        entry.endTime = Date.now() + durationMs;
                        await saveActiveTimers(data);
                    }
                });
            }
        }
    } finally {
        await removeActiveTimer(id);
    }
}

// ============================================
// List / Cancel
// ============================================

export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function listTimers(): Promise<void> {
    const data = await getActiveTimers();
    let changed = false;

    const alive = data.timers.filter((t) => {
        if (!isProcessAlive(t.pid)) {
            changed = true;
            return false;
        }
        return true;
    });

    if (changed) {
        await storage.withConfigLock(async () => {
            const freshData = await getActiveTimers();
            freshData.timers = freshData.timers.filter((t) => isProcessAlive(t.pid));
            await saveActiveTimers(freshData);
        });
    }

    if (alive.length === 0) {
        console.log(pc.dim("No active timers."));
        return;
    }

    const now = Date.now();
    const rows = alive.map((t) => {
        const remaining = Math.max(0, t.endTime - now);
        const actions: string[] = [];

        if (t.notify) {
            actions.push("notify");
        }

        if (t.say) {
            actions.push("say");
        }

        const repeatLabel = t.repeat > 1 ? `${t.currentCycle}/${t.repeat}` : "-";

        return [t.id, t.title, formatCountdown(remaining), repeatLabel, actions.join(", ") || "-", String(t.pid)];
    });

    console.log(formatTable(rows, ["ID", "Title", "Remaining", "Cycle", "Actions", "PID"]));
}

async function cancelTimer(idOrIndex?: string): Promise<void> {
    const data = await getActiveTimers();
    const alive = data.timers.filter((t) => isProcessAlive(t.pid));

    if (alive.length === 0) {
        console.log(pc.dim("No active timers to cancel."));
        return;
    }

    let target: TimerEntry | undefined;

    if (idOrIndex) {
        target = alive.find((t) => t.id === idOrIndex);

        if (!target) {
            const idx = Number(idOrIndex);

            if (!Number.isNaN(idx) && idx >= 1 && idx <= alive.length) {
                target = alive[idx - 1];
            }
        }

        if (!target) {
            console.log(pc.red(`Timer not found: ${idOrIndex}`));
            return;
        }
    } else if (alive.length === 1) {
        target = alive[0];
    } else {
        const now = Date.now();
        const selected = await p.select({
            message: "Which timer to cancel?",
            options: alive.map((t) => ({
                value: t.id,
                label: `${t.title} — ${formatCountdown(Math.max(0, t.endTime - now))} remaining`,
            })),
        });

        if (p.isCancel(selected)) {
            p.cancel("Cancelled");
            return;
        }

        target = alive.find((t) => t.id === selected);
    }

    if (!target) {
        return;
    }

    try {
        process.kill(target.pid, "SIGTERM");
    } catch {
        // Process may have already exited
    }

    await removeActiveTimer(target.id);
    console.log(pc.green(`Cancelled timer: ${target.title} (${target.id})`));
}

// ============================================
// Interactive flow
// ============================================

async function interactiveFlow(initialDuration?: string): Promise<void> {
    p.intro(pc.bgCyan(pc.black(" tools timer ")));

    let durationMs = 0;

    if (initialDuration) {
        durationMs = parseDuration(initialDuration);
    }

    if (durationMs <= 0) {
        const durationInput = await withCancel(
            p.text({
                message: "Duration",
                placeholder: "25m, 1h30m, 90s",
                validate(value) {
                    if (!value) {
                        return "Duration is required";
                    }

                    const ms = parseDuration(value);

                    if (ms <= 0) {
                        return "Invalid duration. Use formats like: 25m, 1h30m, 90s";
                    }
                },
            })
        );

        durationMs = parseDuration(durationInput);
    }

    const title = await withCancel(
        p.text({
            message: "What are you working on?",
            placeholder: "Focus session",
            defaultValue: "Focus session",
        })
    );

    const actions = await withCancel(
        p.multiselect({
            message: `On completion ${pc.dim("(space to toggle)")}`,
            options: [
                { value: "notify" as CompletionAction, label: "Desktop notification", hint: "tools notify" },
                { value: "say" as CompletionAction, label: "Speak aloud", hint: "tools say" },
            ],
            required: false,
        })
    );

    const selectedActions = actions as CompletionAction[];
    const doNotify = selectedActions.includes("notify");
    const doSay = selectedActions.includes("say");

    const mode = await withCancel(
        p.select({
            message: "Run in",
            options: [
                { value: "fg" as const, label: "Foreground", hint: "live countdown in terminal" },
                { value: "bg" as const, label: "Background", hint: "detached process" },
            ],
        })
    );

    const repeatInput = await withCancel(
        p.text({
            message: "Repeat cycles (Pomodoro)",
            placeholder: "1",
            defaultValue: "1",
            validate(value) {
                const n = Number(value);

                if (Number.isNaN(n) || n < 1 || !Number.isInteger(n)) {
                    return "Must be a positive integer";
                }
            },
        })
    );

    const repeat = Number(repeatInput);

    p.outro(
        pc.dim(
            `${formatDuration(durationMs)} - ${title}` +
                (repeat > 1 ? ` x${repeat}` : "") +
                (doNotify ? " [notify]" : "") +
                (doSay ? " [say]" : "")
        )
    );

    const timerOpts: TimerOptions = { durationMs, title, notify: doNotify, say: doSay, repeat };

    if (mode === "bg") {
        await startBackgroundTimer(timerOpts);
    } else {
        await runForegroundTimer(timerOpts);
    }
}

// ============================================
// CLI
// ============================================

const program = new Command();

program
    .name("timer")
    .description("Focus timer with countdown, notifications, and Pomodoro support")
    .argument("[duration]", "Duration: 25m, 1h30m, 90s, or plain number (minutes)")
    .argument("[title]", "Timer title/label")
    .option("--notify", "Send desktop notification on completion")
    .option("--say", "Speak aloud on completion")
    .option("--bg", "Run in background (detached process)")
    .option("--repeat <n>", "Number of cycles (Pomodoro)", (v) => parseInt(v, 10))
    .action(async (duration: string | undefined, title: string | undefined, options: TimerCliFlags) => {
        const durationMs = duration ? parseDuration(duration) : 0;

        if (durationMs <= 0 && duration && duration !== "list" && duration !== "cancel") {
            console.log(pc.red(`Invalid duration: ${duration}`));
            console.log(pc.dim("Use formats like: 25m, 1h30m, 90s, or a number (minutes)"));
            process.exit(1);
        }

        if (durationMs > MAX_TIMEOUT_MS) {
            console.log(pc.red(`Duration too large (max ~24.8 days)`));
            process.exit(1);
        }

        const hasAllArgs = durationMs > 0 && title;
        const hasAnyFlag = options.notify || options.say || options.bg;

        if (!hasAllArgs || (!hasAnyFlag && !title)) {
            await interactiveFlow(duration);
            return;
        }

        const repeat = options.repeat ?? 1;

        if (!Number.isInteger(repeat) || repeat < 1) {
            console.log(pc.red(`Invalid repeat value: ${options.repeat} (must be a positive integer)`));
            process.exit(1);
        }

        const timerOpts: TimerOptions = {
            durationMs,
            title,
            notify: options.notify ?? false,
            say: options.say ?? false,
            repeat,
        };

        if (options.bg) {
            await startBackgroundTimer(timerOpts);
        } else {
            await runForegroundTimer(timerOpts);
        }
    });

program.command("list").description("Show active background timers").action(listTimers);

program
    .command("cancel")
    .description("Cancel a background timer")
    .argument("[id]", "Timer ID or index number")
    .action(async (id?: string) => {
        await cancelTimer(id);
    });

async function main(): Promise<void> {
    if (process.argv[2] === "__bg-run__") {
        await handleBackgroundRun(process.argv.slice(3));
        return;
    }

    try {
        await program.parseAsync(process.argv);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(pc.red(message));
        process.exit(1);
    }
}

main();
