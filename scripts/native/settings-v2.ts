#!/usr/bin/env bun
/**
 * Flips every switch on every Settings page of the installed GenesisTools.app and proves each change reached storage:
 * the page runs in an invisible, never-key window (`GenesisTools --clicky --page <id> --headless`), a switch is pressed
 * through accessibility, a FRESH process reads the page again, and the switch is then restored and read back once more.
 * Nothing takes the user's focus or moves the pointer.
 *
 *   swiftc -O scripts/native/ax.swift -o <scratch>/ax
 *   bun scripts/native/settings-v2.ts --ax <scratch>/ax [--pages widgets.general,focus.general] [--out <report.md>]
 *
 * Skipped on purpose: "Show the widget" (hides the panels) and the Clicky main switch (starts key sounds). A switch
 * that a failed restore leaves flipped is named in the report's first line, so it can be set back by hand.
 *
 * A page is read only when it has drawn, shows no sign of loading and has stopped moving (`settings-v2-ready.ts`). One
 * that is not ready by `READY_TIMEOUT_MS` is reported as NOT READ and fails the run, never as a page with no switches.
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { type AxRow, type PageRead, readPage, type SwitchState, waitUntilReady } from "./settings-v2-ready";

const APP = join(homedir(), "Applications", "GenesisTools.app", "Contents", "MacOS", "GenesisTools");
const ALL_PAGES = [
    "general",
    "clicky.sound",
    "clicky.sleep",
    "clicky.notifications",
    "clicky.stats",
    "clicky.performance",
    "clicky.visualizer",
    "widgets.general",
    "widgets.sessions",
    "widgets.providers",
    "widgets.modules",
    "dictation.flow",
    "dictation.transforms",
    "dictation.voice",
    "focus.general",
    "about",
];
const SKIP = new Set(["widget.showWidget", "clicky.enabled"]);
const READY_TIMEOUT_MS = 12_000;
const SETTLE_MS = 900;

interface SwitchResult {
    page: string;
    key: string;
    before: string;
    flippedInUi: boolean;
    persisted: boolean;
    restored: boolean;
    note?: string;
}

function argument(flag: string): string | undefined {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

const AX = argument("--ax");
if (!AX) {
    console.error(
        "usage: bun scripts/native/settings-v2.ts --ax <compiled scripts/native/ax.swift> [--pages a,b] [--out file]"
    );
    process.exit(2);
}

const PAGES = argument("--pages")?.split(",") ?? ALL_PAGES;
const OUT = argument("--out");

/** A Settings process that stops answering makes each attribute read wait; past this the walk counts as failed. */
const AX_TIMEOUT_MS = 20_000;

function ax(args: string[]): { ok: boolean; out: string } {
    // spawnSync blocks the event loop, so no other deadline in this script can fire while it runs.
    const result = Bun.spawnSync([AX as string, ...args], { stdout: "pipe", stderr: "pipe", timeout: AX_TIMEOUT_MS });
    const out = (result.stdout.toString() + result.stderr.toString()).trim();
    // A killed walk has no exit code, so it reads as a failed read; say why in the report.
    const stopped = result.signalCode
        ? `ax ${args[0]} stopped after ${AX_TIMEOUT_MS / 1000} s (${result.signalCode})`
        : "";
    return { ok: result.exitCode === 0, out: [out, stopped].filter(Boolean).join("\n") };
}

function isAxRow(value: unknown): value is AxRow {
    if (!value || typeof value !== "object") {
        return false;
    }

    const row: Partial<Record<keyof AxRow, unknown>> = value;
    return (
        typeof row.role === "string" &&
        typeof row.id === "string" &&
        typeof row.title === "string" &&
        typeof row.value === "string" &&
        typeof row.enabled === "boolean"
    );
}

function readSwitches(pid: number): PageRead {
    const { ok, out } = ax(["json", String(pid)]);
    if (!ok) {
        return {
            switches: [],
            drawn: false,
            pending: false,
            outline: "",
            error: out || "ax json failed with no output",
        };
    }

    const rows = out
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line): unknown => SafeJSON.parse(line, { strict: true }))
        .filter(isAxRow);
    return readPage(rows, SKIP);
}

function press(pid: number, state: SwitchState): boolean {
    const result = state.id
        ? ax(["press", String(pid), state.id])
        : ax(["press-titled", String(pid), "AXCheckBox", state.title]);
    return result.ok;
}

interface OpenPage {
    pid: number;
    child: Bun.Subprocess;
    switches: SwitchState[];
    /** Why the page was not ready to read in time; a page that drew, settled and has no switches has none. */
    failure?: string;
}

async function openPage(page: string): Promise<OpenPage> {
    const child = Bun.spawn([APP, "--clicky", "--page", page, "--headless"], { stdout: "ignore", stderr: "ignore" });
    const { page: read, failure } = await waitUntilReady({
        read: () => readSwitches(child.pid),
        sleep: (ms) => Bun.sleep(ms),
        now: () => Date.now(),
        timeoutMs: READY_TIMEOUT_MS,
    });
    return { pid: child.pid, child, switches: read.switches, failure };
}

async function closePage(child: Bun.Subprocess): Promise<void> {
    child.kill();
    await Promise.race([child.exited, Bun.sleep(3000)]);
}

function switchValue(switches: SwitchState[], key: string): string | undefined {
    return switches.find((entry) => entry.key === key)?.value;
}

const results: SwitchResult[] = [];
const leftFlipped: string[] = [];
/** Pages that were never read; each one fails the run, since nothing on it was tested. */
const unread: string[] = [];

/** A page opened to check or restore its switches was not ready, so what this run flipped there is not confirmed back. */
function notConfirmedBack(page: string, opening: string, failure: string, pageResults: SwitchResult[]): void {
    unread.push(`${page} (${opening}: ${failure})`);
    console.log(`${page}: NOT READ at ${opening}: ${failure}`);
    for (const result of pageResults.filter((entry) => entry.flippedInUi)) {
        leftFlipped.push(
            `${page} › ${result.key} (was ${result.before}; ${opening} was not ready, so it is not confirmed back)`
        );
    }
}

for (const page of PAGES) {
    const first = await openPage(page);
    if (first.failure) {
        await closePage(first.child);
        unread.push(`${page} (${first.failure})`);
        console.log(`${page}: NOT READ: ${first.failure}`);
        continue;
    }

    if (first.switches.length === 0) {
        await closePage(first.child);
        console.log(`${page}: no switches`);
        continue;
    }

    const pageResults: SwitchResult[] = [];
    for (const entry of first.switches) {
        const pressed = press(first.pid, entry);
        await Bun.sleep(SETTLE_MS);
        const now = switchValue(readSwitches(first.pid).switches, entry.key);
        pageResults.push({
            page,
            key: entry.key,
            before: entry.value,
            flippedInUi: pressed && now !== undefined && now !== entry.value,
            persisted: false,
            restored: false,
            note: pressed ? undefined : "press failed",
        });
    }

    await closePage(first.child);

    const second = await openPage(page);
    if (second.failure) {
        await closePage(second.child);
        notConfirmedBack(page, "the second open", second.failure, pageResults);
        results.push(...pageResults);
        continue;
    }

    const toRestore: SwitchState[] = [];
    for (const result of pageResults) {
        const now = switchValue(second.switches, result.key);
        result.persisted = result.flippedInUi && now !== undefined && now !== result.before;
        const state = second.switches.find((entry) => entry.key === result.key);
        if (state && now !== result.before) {
            toRestore.push(state);
        }
    }

    for (const state of toRestore) {
        if (!press(second.pid, state)) {
            console.log(`${page}: restoring ${state.key} failed to press`);
        }
        await Bun.sleep(SETTLE_MS);
    }

    await closePage(second.child);

    const third = await openPage(page);
    if (third.failure) {
        await closePage(third.child);
        notConfirmedBack(page, "the third open", third.failure, pageResults);
        results.push(...pageResults);
        continue;
    }

    for (const result of pageResults) {
        const now = switchValue(third.switches, result.key);
        result.restored = now === result.before;
        if (!result.restored) {
            leftFlipped.push(`${page} › ${result.key} (was ${result.before}, now ${now ?? "missing"})`);
        }
    }

    await closePage(third.child);
    results.push(...pageResults);
    const good = pageResults.filter((result) => result.flippedInUi && result.persisted && result.restored).length;
    console.log(`${page}: ${good}/${pageResults.length} switches flip, persist and restore`);
}

const passed = (result: SwitchResult) => result.flippedInUi && result.persisted && result.restored;
const failedSwitches = results.filter((result) => !passed(result)).length;
const lines = [
    leftFlipped.length > 0
        ? `⚠️ LEFT FLIPPED (set back by hand): ${leftFlipped.join("; ")}`
        : "Every switch was restored to its value before the run.",
    unread.length > 0
        ? `❌ NOT READ (nothing on these pages was tested): ${unread.join("; ")}`
        : "Every page was read.",
    `${results.length - failedSwitches}/${results.length} switches flip, persist and restore.`,
    "",
    ...results.map(
        (result) =>
            `- ${result.flippedInUi && result.persisted && result.restored ? "✅" : "❌"} ${result.page} › ${result.key}: ` +
            `was ${result.before}; flips in the window ${result.flippedInUi ? "yes" : "NO"}, ` +
            `persists in a new process ${result.persisted ? "yes" : "NO"}, restored ${result.restored ? "yes" : "NO"}` +
            (result.note ? ` (${result.note})` : "")
    ),
];

console.log(lines.slice(0, 3).join("\n"));
if (OUT) {
    writeFileSync(OUT, `${lines.join("\n")}\n`);
}

// A switch that did not flip, persist or restore, and a page that could not be read, each fail the run.
if (leftFlipped.length > 0 || unread.length > 0 || failedSwitches > 0) {
    process.exitCode = 1;
}
