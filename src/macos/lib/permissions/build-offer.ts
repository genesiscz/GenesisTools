import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { genesisAppLauncherPath } from "@genesiscz/utils/macos/genesis-app";
import { detectXcodeToolchain, genesisAppBuildHint, type XcodeToolchain } from "@genesiscz/utils/macos/xcode";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { buildApp } from "./app";

/**
 * Tools whose first command in an interactive terminal may offer to build GenesisTools.app
 * (#447/#445 round-2 D1). `macos` is gated only for the permission-touching subcommands; its
 * other subcommands (`swap`, `doctor`, …) never prompt. `macos control` runs the control tool, so
 * it is gated like `tools control`.
 */
const GATED_TOOLS = new Set(["control"]);
const GATED_MACOS_SUBCOMMANDS = new Set(["calendar", "reminders", "mail", "messages", "voice-memos", "control"]);
/**
 * `macos` subcommands that take only options, mapped to the options that make a run read-only. `macos
 * eslogger` starts a capture that needs Full Disk Access, even bare (it prompts for events); listing the
 * events, a dry run and replaying a recorded file never reach eslogger, so they never prompt. A Map, not
 * an object literal: `tools macos constructor` must not find Object.prototype.constructor here.
 */
const GATED_MACOS_OPTION_COMMANDS = new Map<string, ReadonlySet<string>>([
    ["eslogger", new Set(["--list-events", "--dry-run", "-d", "--input"])],
]);

/**
 * A help page or a read-only check never prompts and never writes the cooldown file: a diagnostic
 * must never mutate (CLAUDE.md). `hub` is not gated because it builds the app on its own, and
 * `macos permissions` is the command that manages the app. The read-only words count only as a
 * subcommand, never as an option value: `control see --app status` still drives the UI.
 */
const READ_ONLY_SUBCOMMANDS = new Set(["doctor", "audit", "status", "help"]);
/** Documentation flags, anywhere in the arguments: runTool prints the help or README and exits. */
const DOCUMENTATION_FLAGS = new Set(["--help", "-h", "--readme"]);

/** The subcommand words: the leading run of non-option arguments, after any global flag such as `-v`. */
function commandWords(scriptArgs: readonly string[]): string[] {
    let start = 0;

    while (start < scriptArgs.length && scriptArgs[start].startsWith("-")) {
        start++;
    }

    const words: string[] = [];

    for (const arg of scriptArgs.slice(start)) {
        if (arg.startsWith("-")) {
            break;
        }

        words.push(arg);
    }

    return words;
}

export function isGatedInvocation(scriptId: string, scriptArgs: readonly string[]): boolean {
    if (scriptArgs.some((arg) => DOCUMENTATION_FLAGS.has(arg))) {
        return false;
    }

    const [first, second] = commandWords(scriptArgs);

    if (GATED_TOOLS.has(scriptId)) {
        return first !== undefined && !READ_ONLY_SUBCOMMANDS.has(first);
    }

    const readOnlyOptions =
        scriptId === "macos" && first !== undefined ? GATED_MACOS_OPTION_COMMANDS.get(first) : undefined;

    if (readOnlyOptions) {
        return !scriptArgs.some((arg) => readOnlyOptions.has(arg.split("=")[0]));
    }

    return (
        scriptId === "macos" &&
        GATED_MACOS_SUBCOMMANDS.has(first ?? "") &&
        second !== undefined &&
        !READ_ONLY_SUBCOMMANDS.has(second)
    );
}

export const DECLINE_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

/** True once enough time has passed since `atMs` (the last "no", or the last Xcode notice) to speak again. */
export function shouldAsk(atMs: number | undefined, nowMs: number): boolean {
    return atMs === undefined || nowMs - atMs >= DECLINE_COOLDOWN_MS;
}

export interface BuildOfferDeps {
    isTty: () => boolean;
    noAppEnv: () => boolean;
    isAppBuilt: () => boolean;
    detectToolchain: () => XcodeToolchain;
    readDeclinedAt: () => number | undefined;
    writeDeclinedAt: (atMs: number) => void;
    readXcodeNoticeAt: () => number | undefined;
    writeXcodeNoticeAt: (atMs: number) => void;
    confirmBuild: () => Promise<boolean>;
    build: (onStep: (message: string) => void) => Promise<void>;
    log: (message: string) => void;
    now: () => number;
}

/**
 * D1: offer to build GenesisTools.app the first time a permission-gated tool runs in a
 * terminal. Never asks twice within {@link DECLINE_COOLDOWN_MS} of a "no", never asks without
 * full Xcode (prints the install hint instead of a build that would fail, at most once per
 * cooldown), never asks without a TTY or with GENESIS_TOOLS_NO_APP=1, and never asks once the
 * app is already built. The Xcode notice is not a "no": once Xcode is installed, it asks at once.
 */
export async function maybeOfferGenesisAppBuild(deps: BuildOfferDeps): Promise<void> {
    if (deps.noAppEnv() || !deps.isTty() || deps.isAppBuilt()) {
        return;
    }

    if (!shouldAsk(deps.readDeclinedAt(), deps.now())) {
        return;
    }

    const toolchain = deps.detectToolchain();

    if (toolchain.kind !== "xcode") {
        if (shouldAsk(deps.readXcodeNoticeAt(), deps.now())) {
            deps.log(genesisAppBuildHint(toolchain));
            deps.writeXcodeNoticeAt(deps.now());
        }

        return;
    }

    deps.log(
        "GenesisTools.app is a signed launcher that lets macOS privacy grants (Calendars, Reminders, Full Disk Access, ...) follow it instead of your terminal."
    );

    const confirmed = await deps.confirmBuild();

    if (!confirmed) {
        deps.writeDeclinedAt(deps.now());
        return;
    }

    try {
        await deps.build((message) => deps.log(message));
    } catch (error) {
        logger.warn({ error }, "build-offer: GenesisTools.app build failed");
        deps.log(
            `Could not build GenesisTools.app: ${error instanceof Error ? error.message : String(error)}. Tools keep running under the terminal's own permissions.`
        );
    }
}

function declineStatePath(): string {
    return join(toolDataDir("app-build-offer"), "state.json");
}

/**
 * The offer's memory: when the user last said no, and when the missing-Xcode notice was last
 * shown. Two keys, because only the first is a decision; the second must not outlive an install.
 */
export interface OfferState {
    declinedAtMs?: number;
    xcodeNoticeAtMs?: number;
}

function timestamp(value: unknown): number | undefined {
    return typeof value === "number" ? value : undefined;
}

/** Exported for {@link createRealBuildOfferDeps} and its tests; takes an explicit path so a test never touches the real HOME. */
export function readOfferStateFrom(path: string): OfferState {
    if (!existsSync(path)) {
        return {};
    }

    try {
        const state: unknown = SafeJSON.parse(readFileSync(path, "utf8"));

        if (state === null || typeof state !== "object") {
            return {};
        }

        const read: OfferState = {};
        const declinedAtMs = "declinedAtMs" in state ? timestamp(state.declinedAtMs) : undefined;
        const xcodeNoticeAtMs = "xcodeNoticeAtMs" in state ? timestamp(state.xcodeNoticeAtMs) : undefined;

        if (declinedAtMs !== undefined) {
            read.declinedAtMs = declinedAtMs;
        }

        if (xcodeNoticeAtMs !== undefined) {
            read.xcodeNoticeAtMs = xcodeNoticeAtMs;
        }

        return read;
    } catch (error) {
        logger.debug({ error, path }, "build-offer: offer state unreadable");
        return {};
    }
}

/** Merges `patch` into the state file, so writing one key keeps the other. */
export function writeOfferStateTo(path: string, patch: OfferState): void {
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${SafeJSON.stringify({ ...readOfferStateFrom(path), ...patch })}\n`);
    } catch (error) {
        logger.debug({ error, path }, "build-offer: could not persist offer state");
    }
}

/** Wires {@link maybeOfferGenesisAppBuild} to the real environment. Untested glue; the decision logic above is. */
export function createRealBuildOfferDeps(): BuildOfferDeps {
    const path = declineStatePath();

    return {
        // Both ends: `tools control see … | jq` keeps a terminal on stdin while stdout is data.
        isTty: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
        noAppEnv: () => env.tools.isAppLauncherDisabled(),
        isAppBuilt: () => existsSync(genesisAppLauncherPath()),
        detectToolchain: () => detectXcodeToolchain(),
        readDeclinedAt: () => readOfferStateFrom(path).declinedAtMs,
        writeDeclinedAt: (atMs) => writeOfferStateTo(path, { declinedAtMs: atMs }),
        readXcodeNoticeAt: () => readOfferStateFrom(path).xcodeNoticeAtMs,
        writeXcodeNoticeAt: (atMs) => writeOfferStateTo(path, { xcodeNoticeAtMs: atMs }),
        confirmBuild: async () => {
            const p = await import("@clack/prompts");
            const answer = await p.confirm({
                message: "Build and install GenesisTools.app now?",
                initialValue: true,
                output: process.stderr,
            });
            return answer === true;
        },
        build: async (onStep) => {
            await buildApp({ onStep });
        },
        log: (message) => {
            process.stderr.write(`\n  ${message}\n`);
        },
        now: () => Date.now(),
    };
}
