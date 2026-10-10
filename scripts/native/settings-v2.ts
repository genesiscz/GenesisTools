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
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

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

interface AxRow {
    role: string;
    id: string;
    title: string;
    value: string;
    enabled: boolean;
}

interface SwitchState {
    key: string;
    id: string;
    title: string;
    value: string;
}

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

function ax(args: string[]): { ok: boolean; out: string } {
    const result = Bun.spawnSync([AX as string, ...args], { stdout: "pipe", stderr: "pipe" });
    return { ok: result.exitCode === 0, out: (result.stdout.toString() + result.stderr.toString()).trim() };
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

function readSwitches(pid: number): SwitchState[] {
    const { out } = ax(["json", String(pid)]);
    const rows = out
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line): unknown => SafeJSON.parse(line, { strict: true }))
        .filter(isAxRow);
    return rows
        .filter((row) => row.role === "AXCheckBox" && row.enabled && (row.id || row.title))
        .map((row) => ({ key: row.id || row.title, id: row.id, title: row.title, value: row.value }))
        .filter((row) => !SKIP.has(row.key));
}

function press(pid: number, state: SwitchState): boolean {
    const result = state.id
        ? ax(["press", String(pid), state.id])
        : ax(["press-titled", String(pid), "AXCheckBox", state.title]);
    return result.ok;
}

async function openPage(page: string): Promise<{ pid: number; child: Bun.Subprocess; switches: SwitchState[] }> {
    const child = Bun.spawn([APP, "--clicky", "--page", page, "--headless"], { stdout: "ignore", stderr: "ignore" });
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let last: SwitchState[] = [];
    let stableRounds = 0;

    // Ready when two reads in a row agree: the stored values arrive a moment after the window draws.
    while (Date.now() < deadline) {
        await Bun.sleep(Math.min(700, Math.max(0, deadline - Date.now())));
        const now = readSwitches(child.pid);
        const same = now.length > 0 && SafeJSON.stringify(now) === SafeJSON.stringify(last);
        stableRounds = same ? stableRounds + 1 : 0;
        last = now;
        if (stableRounds >= 2) {
            break;
        }
    }

    return { pid: child.pid, child, switches: last };
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

for (const page of PAGES) {
    const first = await openPage(page);
    if (first.switches.length === 0) {
        await closePage(first.child);
        console.log(`${page}: no switches`);
        continue;
    }

    const pageResults: SwitchResult[] = [];
    for (const entry of first.switches) {
        const pressed = press(first.pid, entry);
        await Bun.sleep(SETTLE_MS);
        const now = switchValue(readSwitches(first.pid), entry.key);
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
        press(second.pid, state);
        await Bun.sleep(SETTLE_MS);
    }

    await closePage(second.child);

    const third = await openPage(page);
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

const lines = [
    leftFlipped.length > 0
        ? `⚠️ LEFT FLIPPED (set back by hand): ${leftFlipped.join("; ")}`
        : "Every switch was restored to its value before the run.",
    "",
    ...results.map(
        (result) =>
            `- ${result.flippedInUi && result.persisted && result.restored ? "✅" : "❌"} ${result.page} › ${result.key}: ` +
            `was ${result.before}; flips in the window ${result.flippedInUi ? "yes" : "NO"}, ` +
            `persists in a new process ${result.persisted ? "yes" : "NO"}, restored ${result.restored ? "yes" : "NO"}` +
            (result.note ? ` (${result.note})` : "")
    ),
];

console.log(lines[0]);
if (OUT) {
    writeFileSync(OUT, `${lines.join("\n")}\n`);
}

if (leftFlipped.length > 0) {
    process.exitCode = 1;
}
