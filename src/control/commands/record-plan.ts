import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger, out } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";
import pc from "picocolors";
import { ensureBinary, RECORD_DIR, RECORD_SESSION, recordSource } from "../lib/runner";

const COMMANDS_LOG = join(RECORD_DIR, "commands.jsonl");
const ACTIVITY_LOG = join(RECORD_DIR, "activity.jsonl");

const KEYCODE_NAMES: Record<number, string> = {
    36: "return",
    48: "tab",
    49: "space",
    51: "delete",
    53: "escape",
    123: "left",
    124: "right",
    125: "down",
    126: "up",
};

// US-layout virtual keycodes for hotkey synthesis — layout-independent, so a
// Czech-layout cmd+1 (char "+") still replays as "cmd,1" via Swift's KEY_MAP.
// biome-ignore format: keep the keycode table dense
const COMBO_KEYCODE_NAMES: Record<number, string> = {
    ...KEYCODE_NAMES,
    0: "a", 1: "s", 2: "d", 3: "f", 4: "h", 5: "g", 6: "z", 7: "x", 8: "c",
    9: "v", 11: "b", 12: "q", 13: "w", 14: "e", 15: "r", 16: "y", 17: "t",
    18: "1", 19: "2", 20: "3", 21: "4", 22: "6", 23: "5", 25: "9", 26: "7",
    28: "8", 29: "0", 31: "o", 32: "u", 34: "i", 35: "p", 37: "l", 38: "j",
    40: "k", 45: "n", 46: "m",
};

interface SessionState {
    mode: "commands" | "activity" | "all";
    startedAt: number;
    activityPid?: number;
    src?: string;
}

interface RecEvent {
    type: string;
    ts: number;
    x?: number;
    y?: number;
    right?: boolean;
    element?: {
        axId?: string;
        role?: string;
        title?: string;
        desc?: string;
        subrole?: string;
        app?: string;
        pid?: number;
    };
    keycode?: number;
    char?: string;
    mods?: string[];
    app?: string;
    dy?: number;
    dx?: number;
}

interface TimedStep {
    ts: number;
    step: Record<string, unknown>;
}

function readSession(): SessionState | null {
    if (!existsSync(RECORD_SESSION)) {
        return null;
    }
    try {
        return SafeJSON.parse(readFileSync(RECORD_SESSION, "utf-8")) as SessionState;
    } catch {
        return null;
    }
}

function readJsonl<T>(path: string): T[] {
    if (!existsSync(path)) {
        return [];
    }
    const items: T[] = [];
    for (const line of readFileSync(path, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        try {
            items.push(SafeJSON.parse(trimmed) as T);
        } catch {
            // skip partial trailing line
        }
    }
    return items;
}

interface CommandLine {
    ts: number;
    ok?: boolean;
    src?: string;
    args: string[];
}

// Flags whose values are numbers — keep plan JSON typed for hand-editing/diffing.
const NUMERIC_KEYS = new Set(["amount", "timeout", "interval", "hold", "delay", "duration", "depth"]);

/** tools-control invocations (commands.jsonl argv) -> plan steps. */
function commandsToSteps(lines: CommandLine[], ownSrc?: string): TimedStep[] {
    const steps: TimedStep[] = [];
    for (const line of lines) {
        if (line.ok === false) {
            continue;
        }
        const argv = line.args;
        const cmd = argv[0];
        if (!cmd) {
            continue;
        }
        const step: Record<string, unknown> = { do: cmd };
        let i = 1;
        while (i < argv.length) {
            const a = argv[i] ?? "";
            if (!a.startsWith("--")) {
                i++;
                continue;
            }
            const key = a.slice(2);
            if (key === "pretty" || key === "json") {
                i++;
                continue;
            }
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith("--")) {
                step[key] = NUMERIC_KEYS.has(key) && !Number.isNaN(Number(next)) ? Number(next) : next;
                i += 2;
            } else {
                step[key] = true;
                i++;
            }
        }
        // Mark commands that came from a different terminal/session than the one
        // that started the recording ("_"-prefixed keys are ignored by run).
        if (ownSrc && line.src && line.src !== ownSrc) {
            step._foreign = line.src;
        }
        steps.push({ ts: line.ts, step });
    }
    return steps;
}

/** Raw user activity (activity.jsonl events) -> plan steps, with coalescing. */
function activityToSteps(events: RecEvent[], epochBase: number): TimedStep[] {
    const steps: TimedStep[] = [];
    let textBuf = "";
    let textApp: string | undefined;
    let textTs = 0;
    let lastKeyTs = -10_000;
    let scrollAcc = 0;
    let scrollApp: string | undefined;
    let scrollTs = 0;
    let lastScrollTs = -10_000;

    const flushText = (withReturn = false): void => {
        if (!textBuf && !withReturn) {
            return;
        }
        if (textBuf) {
            const step: Record<string, unknown> = { do: "type", text: textBuf };
            if (textApp) {
                step.app = textApp;
            }
            if (withReturn) {
                step.return = true;
            }
            steps.push({ ts: epochBase + textTs, step });
        } else if (withReturn) {
            steps.push({ ts: epochBase + textTs, step: { do: "hotkey", keys: "return", app: textApp } });
        }
        textBuf = "";
    };
    const flushScroll = (): void => {
        if (scrollAcc === 0) {
            return;
        }
        const step: Record<string, unknown> = {
            do: "scroll",
            direction: scrollAcc < 0 ? "down" : "up",
            amount: Math.min(Math.abs(scrollAcc), 50),
        };
        if (scrollApp) {
            step.app = scrollApp;
        }
        steps.push({ ts: epochBase + scrollTs, step });
        scrollAcc = 0;
    };

    for (const e of events) {
        if (e.type === "meta") {
            continue;
        }
        if (e.type === "click") {
            flushText();
            flushScroll();
            const el = e.element ?? {};
            const step: Record<string, unknown> = { do: "click" };
            if (el.axId) {
                step.id = el.axId;
            } else if (el.desc) {
                step.desc = el.desc;
                if (el.role) {
                    step.role = el.role;
                }
            } else if (el.title) {
                step.title = el.title;
                if (el.role) {
                    step.role = el.role;
                }
            } else {
                step.coords = `${e.x},${e.y}`;
            }
            if (el.app) {
                step.app = el.app;
            }
            if (e.right) {
                step.right = true;
            }
            steps.push({ ts: epochBase + e.ts, step });
            continue;
        }
        if (e.type === "scroll") {
            flushText();
            const dy = e.dy ?? 0;
            if (dy !== 0) {
                if (e.ts - lastScrollTs > 1200 || Math.sign(dy) !== Math.sign(scrollAcc || dy)) {
                    flushScroll();
                    scrollTs = e.ts;
                    scrollApp = e.app;
                }
                scrollAcc += dy;
                lastScrollTs = e.ts;
            }
            continue;
        }
        if (e.type !== "key") {
            continue;
        }
        const mods = e.mods ?? [];
        const hasCombo = mods.some((m) => m === "cmd" || m === "ctrl" || m === "alt");
        const keycode = e.keycode ?? -1;
        const named = KEYCODE_NAMES[keycode];
        if (hasCombo) {
            flushText();
            flushScroll();
            const keyName =
                COMBO_KEYCODE_NAMES[keycode] ?? (e.char && e.char >= " " ? e.char.toLowerCase() : undefined);
            if (keyName) {
                steps.push({
                    ts: epochBase + e.ts,
                    step: { do: "hotkey", keys: [...mods.filter((m) => m !== "shift"), keyName].join(","), app: e.app },
                });
            }
            continue;
        }
        if (keycode === 36) {
            textTs = textBuf ? textTs : e.ts;
            textApp = textApp ?? e.app;
            flushText(true);
            continue;
        }
        if (keycode === 51) {
            if (textBuf) {
                textBuf = textBuf.slice(0, -1);
            } else {
                steps.push({ ts: epochBase + e.ts, step: { do: "hotkey", keys: "delete", app: e.app } });
            }
            continue;
        }
        if (named) {
            flushText();
            flushScroll();
            steps.push({ ts: epochBase + e.ts, step: { do: "hotkey", keys: named, app: e.app } });
            continue;
        }
        if (e.char && e.char >= " ") {
            if (e.ts - lastKeyTs > 1500) {
                flushText();
                textTs = e.ts;
                textApp = e.app;
            }
            textBuf += e.char;
            lastKeyTs = e.ts;
        }
    }
    flushText();
    flushScroll();
    return steps;
}

const DEDUPE_EQUIV: Record<string, string[]> = {
    click: ["click", "press"],
    type: ["type", "set"],
    hotkey: ["hotkey"],
    scroll: ["scroll"],
};

/**
 * Mode "all": our own synthetic CGEvents get re-captured by the tap, so drop
 * activity steps that mirror a recorded command within +-1500ms.
 */
function dedupeMerged(commandSteps: TimedStep[], activitySteps: TimedStep[]): TimedStep[] {
    const kept = activitySteps.filter((a) => {
        const equiv = DEDUPE_EQUIV[String(a.step.do)] ?? [String(a.step.do)];
        return !commandSteps.some((c) => equiv.includes(String(c.step.do)) && Math.abs(c.ts - a.ts) < 1500);
    });
    return [...commandSteps, ...kept].sort((x, y) => x.ts - y.ts);
}

function synthesizePlan(
    session: SessionState,
    forcedApp?: string,
    excludeForeign = false
): { plan: Record<string, unknown>; foreignCount: number } {
    let commandSteps =
        session.mode !== "activity" ? commandsToSteps(readJsonl<CommandLine>(COMMANDS_LOG), session.src) : [];
    const foreignCount = commandSteps.filter((t) => t.step._foreign).length;
    if (excludeForeign) {
        commandSteps = commandSteps.filter((t) => !t.step._foreign);
    }
    const activitySteps =
        session.mode !== "commands" ? activityToSteps(readJsonl<RecEvent>(ACTIVITY_LOG), session.startedAt) : [];

    const merged =
        session.mode === "all"
            ? dedupeMerged(commandSteps, activitySteps)
            : [...commandSteps, ...activitySteps].sort((x, y) => x.ts - y.ts);

    const appCounts = new Map<string, number>();
    for (const t of merged) {
        const a = t.step.app;
        if (typeof a === "string" && a) {
            appCounts.set(a, (appCounts.get(a) ?? 0) + 1);
        }
    }
    const planApp = forcedApp ?? [...appCounts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];

    const steps = merged.map((t) => {
        const s = { ...t.step };
        if (s.app === planApp) {
            delete s.app;
        }
        return s;
    });

    const plan: Record<string, unknown> = {};
    if (planApp) {
        plan.app = planApp;
    }
    plan.steps = steps;
    return { plan, foreignCount: excludeForeign ? 0 : foreignCount };
}

function stopActivityRecorder(session: SessionState): void {
    if (!session.activityPid) {
        return;
    }
    try {
        process.kill(session.activityPid, "SIGTERM");
    } catch {
        // already gone
    }
}

export function registerRecordPlanCommand(program: Command): void {
    program
        .command("record-plan [action]")
        .description(`Record a plan instead of writing one — capture what happens, emit runnable plan JSON.

  Modes (--record):
    commands  log every subsequent \`tools control\` action command (press/click/
              set/type/hotkey/scroll/...) from ANY terminal until stop
    activity  record the USER's real clicks/keys/scrolls via a CGEvent tap,
              clicks resolved to AX elements (id/desc/role) for replayability
    all       both, deduped (default)

  Usage:
    control record-plan start --record all      # begin recording
    ...do things (run commands / drive the UI)...
    control record-plan stop --out plan.json    # synthesize + write the plan
    control record-plan status                  # what's being recorded

  One-shot: \`control record-plan --record activity --duration 20 --out plan.json\`
  records for 20s then emits the plan (no start/stop needed).

  Synthesis coalesces keystrokes into type steps (return -> "return":true),
  modifier combos into hotkey steps, wheel bursts into scroll steps; clicks
  prefer id > desc > title > raw coords. Review the plan before running it.`)
        .option("--record <mode>", "commands | activity | all", "all")
        .option("--duration <s>", "one-shot: record activity for N seconds, then emit the plan")
        .option("--out <path>", "write plan JSON to this file (default: stdout)")
        .option("--app <name>", "force the plan-level app instead of the most frequent")
        .option(
            "--exclude-foreign",
            "stop: drop commands recorded from OTHER terminals/sessions instead of marking them _foreign"
        )
        .option("--json", "machine output for start/status/stop metadata")
        .action((action: string | undefined, opts) => {
            const mode = String(opts.record) as SessionState["mode"];
            if (!["commands", "activity", "all"].includes(mode)) {
                logger.error(`--record must be commands|activity|all, got: ${mode}`);
                process.exit(1);
            }

            const doStart = (): SessionState => {
                const existing = readSession();
                if (existing) {
                    logger.error(
                        `recording already active (mode=${existing.mode}, started ${Math.round((Date.now() - existing.startedAt) / 1000)}s ago) — run: control record-plan stop`
                    );
                    process.exit(1);
                }
                mkdirSync(RECORD_DIR, { recursive: true });
                for (const f of [COMMANDS_LOG, ACTIVITY_LOG]) {
                    if (existsSync(f)) {
                        unlinkSync(f);
                    }
                }
                const session: SessionState = { mode, startedAt: Date.now(), src: recordSource() };
                if (mode !== "commands") {
                    const bin = ensureBinary();
                    const recArgs = ["record", "--out", ACTIVITY_LOG];
                    if (opts.duration) {
                        recArgs.push("--duration", String(opts.duration));
                    }
                    const child = spawn(bin, recArgs, { detached: true, stdio: "ignore" });
                    child.unref();
                    session.activityPid = child.pid;
                }
                writeFileSync(RECORD_SESSION, SafeJSON.stringify(session));
                return session;
            };

            const doStop = (): void => {
                const session = readSession();
                if (!session) {
                    logger.error("no active recording — run: control record-plan start");
                    process.exit(1);
                }
                stopActivityRecorder(session);
                Bun.sleepSync(150);
                const { plan, foreignCount } = synthesizePlan(session, opts.app, !!opts.excludeForeign);
                unlinkSync(RECORD_SESSION);
                const planJson = SafeJSON.stringify(plan, null, 2);
                const stepCount = (plan.steps as unknown[]).length;
                if (opts.out) {
                    writeFileSync(opts.out, `${planJson}\n`);
                    out.println(
                        `${pc.green("plan written")} ${pc.cyan(opts.out)} — ${stepCount} steps (mode=${session.mode})`
                    );
                    out.println(pc.dim(`review it, then: tools control run ${opts.out}`));
                } else {
                    out.println(planJson);
                }
                if (foreignCount > 0) {
                    logger.warn(
                        `${foreignCount} of ${stepCount} steps came from a DIFFERENT terminal/session (marked "_foreign") — delete them from the plan before replay (next time: stop --exclude-foreign drops them)`
                    );
                }
                if (stepCount === 0) {
                    logger.warn(
                        session.mode === "activity"
                            ? "0 steps captured — no user input seen (tap needs Accessibility + Input Monitoring)"
                            : "0 steps captured — no action commands ran while recording"
                    );
                }
            };

            if (action === "start") {
                const session = doStart();
                if (opts.json) {
                    out.println(SafeJSON.stringify({ ok: true, ...session }));
                    return;
                }
                out.println(
                    `${pc.green("recording")} mode=${session.mode}${session.activityPid ? ` (activity pid ${session.activityPid})` : ""}`
                );
                out.println(pc.dim("stop + emit plan: tools control record-plan stop --out plan.json"));
                return;
            }
            if (action === "stop") {
                doStop();
                return;
            }
            if (action === "status") {
                const session = readSession();
                if (!session) {
                    out.println(opts.json ? SafeJSON.stringify({ ok: true, recording: false }) : "not recording");
                    return;
                }
                const commandLines = readJsonl<CommandLine>(COMMANDS_LOG);
                const commands = commandLines.length;
                const foreign = session.src ? commandLines.filter((l) => l.src && l.src !== session.src).length : 0;
                const activity = readJsonl(ACTIVITY_LOG).length;
                const info = {
                    ok: true,
                    recording: true,
                    mode: session.mode,
                    elapsedS: Math.round((Date.now() - session.startedAt) / 1000),
                    commandsLogged: commands,
                    foreignCommands: foreign,
                    activityEvents: activity,
                    commands: commandLines.map((l) => ({
                        args: l.args,
                        ...(l.src && session.src && l.src !== session.src ? { foreign: true } : {}),
                    })),
                };
                if (opts.json) {
                    out.println(SafeJSON.stringify(info));
                    return;
                }
                out.println(
                    `recording mode=${info.mode} elapsed=${info.elapsedS}s commands=${commands} activityEvents=${activity}`
                );
                const tail = commandLines.slice(-5);
                if (tail.length) {
                    out.println(pc.dim("  last commands:"));
                    for (const l of tail) {
                        const mark = l.src && session.src && l.src !== session.src ? pc.yellow(" [foreign]") : "";
                        out.println(pc.dim(`    ${l.args.join(" ")}${mark}`));
                    }
                }
                if (foreign > 0) {
                    logger.warn(`${foreign} of ${commands} buffered commands came from a different terminal/session`);
                }
                return;
            }
            if (!action && opts.duration) {
                doStart();
                const secs = Number(opts.duration);
                out.println(`${pc.green("recording")} for ${secs}s (mode=${mode}) — go do the thing...`);
                Bun.sleepSync(secs * 1000 + 300);
                doStop();
                return;
            }
            logger.error(
                "usage: record-plan start|stop|status, or one-shot: record-plan --record activity --duration 20"
            );
            process.exit(1);
        });
}
