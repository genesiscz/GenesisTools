import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import {
    describeResponsibleIdentity,
    genesisAppBundlePath,
    genesisAppDir,
    isRunningUnderGenesisApp,
} from "./genesis-app";
import { MacOS } from "./MacOS";

/**
 * Full Disk Access has no system prompt: the user adds the app to a list by hand. This is the
 * closest thing macOS allows — a dialog that says what the current command wanted, what the one
 * switch unlocks, and the steps to grant it, then opens the pane and reveals the bundle.
 * Throttled per hour so a retry loop cannot stack dialogs.
 */
const STAMP_FILE = "fda-prompted-at";
const THROTTLE_MS = 60 * 60 * 1000;

export type FullDiskAccessPromptResult = "opened" | "dismissed" | "throttled" | "no-ui";

export type FullDiskAccessFeature = "mail" | "messages" | "voice-memos";

interface FeatureCapability {
    id: FullDiskAccessFeature;
    label: string;
    /** What the user gains, phrased as the thing they can do afterwards. */
    gain: string;
}

/** Everything behind the single Full Disk Access switch, so the dialog can say what it buys. */
export const FULL_DISK_ACCESS_FEATURES: readonly FeatureCapability[] = [
    { id: "mail", label: "Mail", gain: "search your mail, save attachments" },
    { id: "messages", label: "Messages", gain: "read and search your iMessage and SMS history" },
    { id: "voice-memos", label: "Voice Memos", gain: "list, play, export and transcribe recordings" },
];

export interface FullDiskAccessContext {
    /** What this command wanted, as a verb phrase: "read your Messages history". */
    reason: string;
    /** Which capability asked, so the dialog marks it in the list. */
    feature?: FullDiskAccessFeature;
}

export function fullDiskAccessSubject(): string {
    if (isRunningUnderGenesisApp()) {
        return "GenesisTools in ~/Applications";
    }

    return describeResponsibleIdentity();
}

/**
 * The dialog body. Pure, so the wording is testable without showing anything.
 *
 * Shape: what just got blocked → what the one switch unlocks, with the current command marked →
 * numbered steps, because there is no prompt to click through.
 */
export function buildFullDiskAccessMessage(context: FullDiskAccessContext): string {
    const capabilities = FULL_DISK_ACCESS_FEATURES.map((capability) => {
        const current = capability.id === context.feature;
        return `  ${current ? "▸" : "•"} ${capability.label} — ${capability.gain}${current ? "   ← what you just ran" : ""}`;
    }).join("\n");

    const steps = isRunningUnderGenesisApp()
        ? [
              "1. Click Open Settings below.",
              "2. Finder selects GenesisTools. Drag it into the list, or click + and pick it.",
              "3. Switch it on, then run your command again.",
          ]
        : [
              "1. Click Open Settings below.",
              `2. Add ${fullDiskAccessSubject()} to the list.`,
              "3. Switch it on, then run your command again.",
          ];

    return [
        `GenesisTools could not ${context.reason}.`,
        "",
        "Apple keeps these three behind one switch. Turn it on once and all of them work, from any terminal and from background services:",
        "",
        capabilities,
        "",
        "Nothing else changes: GenesisTools still only reads what a command you run asks for.",
        "",
        "macOS never prompts for this switch, so it takes three steps:",
        "",
        steps.map((step) => `  ${step}`).join("\n"),
    ].join("\n");
}

/** Terminal version of the same explanation, for the error a command throws after the dialog. */
export function fullDiskAccessInstructions(context: FullDiskAccessContext): string {
    const others = FULL_DISK_ACCESS_FEATURES.filter((capability) => capability.id !== context.feature).map(
        (capability) => capability.label
    );

    return [
        `Full Disk Access is required to ${context.reason}.`,
        `Add ${fullDiskAccessSubject()} in System Settings > Privacy & Security > Full Disk Access and switch it on. ${others.join(" and ")} start working too, from any terminal and from background services.`,
        isRunningUnderGenesisApp()
            ? "There is no prompt for this one. `tools macos permissions open --pane full-disk-access` opens the list and reveals the app in Finder."
            : "Run `tools macos permissions build` first, so GenesisTools holds the grant instead of whichever terminal ran the command.",
    ].join("\n");
}

function recentlyPrompted(dir: string): boolean {
    const stamp = join(dir, STAMP_FILE);

    if (!existsSync(stamp)) {
        return false;
    }

    const at = Number(readFileSync(stamp, "utf8"));
    return Number.isFinite(at) && Date.now() - at < THROTTLE_MS;
}

function markPrompted(dir: string): void {
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, STAMP_FILE), String(Date.now()));
    } catch (error) {
        logger.debug({ error, dir }, "full-disk-access: could not write prompt stamp");
    }
}

/**
 * Show the dialog, open the pane and reveal the bundle. Returns what happened; never throws.
 * `force` skips the hourly throttle (used by `tools macos permissions open`).
 */
export function requestFullDiskAccess(
    options: FullDiskAccessContext & { force?: boolean; stampDir?: string }
): FullDiskAccessPromptResult {
    if (process.platform !== "darwin") {
        return "no-ui";
    }

    const stampDir = options.stampDir ?? genesisAppDir();

    if (!options.force && recentlyPrompted(stampDir)) {
        logger.debug("full-disk-access: prompt throttled");
        return "throttled";
    }

    markPrompted(stampDir);
    const body = buildFullDiskAccessMessage(options);
    const script = `display dialog ${appleScriptString(body)} with title "GenesisTools" buttons {"Not now", "Open Settings"} default button "Open Settings" with icon caution`;
    const proc = Bun.spawnSync(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const answer = new TextDecoder().decode(proc.stdout);
    logger.debug({ exitCode: proc.exitCode, answer: answer.trim() }, "full-disk-access: dialog answered");

    if (proc.exitCode !== 0 || !answer.includes("Open Settings")) {
        return "dismissed";
    }

    MacOS.settings.openFullDiskAccess();

    // Only the responsible identity belongs in the list; revealing the bundle under a terminal
    // would point the user at an app that is not the one being denied.
    if (isRunningUnderGenesisApp() && existsSync(genesisAppBundlePath())) {
        Bun.spawnSync(["open", "-R", genesisAppBundlePath()]);
    }

    return "opened";
}

function appleScriptString(text: string): string {
    return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}
