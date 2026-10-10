import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { GENESIS_APP_BUNDLE_ID, genesisAppBundlePath, genesisAppDir } from "@genesiscz/utils/macos/genesis-app";
import { inspectPidFile } from "@genesiscz/utils/process/pidfile";
import { toolDataDir } from "@genesiscz/utils/storage/root";

/**
 * Whether this Mac has the native GenesisTools inbox (the widget), and whether it is on screen.
 *
 * - `none`: no native app that can run the widget. Agents hear nothing about the inbox.
 * - `installed`: the widget can run here but is not running. Agents may post, and must ALSO ask in chat.
 * - `running`: the widget is running, so a post reaches the user.
 *
 * The widget and Clicky are in staging (src/macos/GenesisTools/Sources/App/NativePreview.swift): they run in the
 * Preview bundle (`scripts/build-widget-preview.ts`), and in the normal app only on a machine whose owner set the
 * `GenesisToolsStagingFaces` defaults key (`bun scripts/native/staging.ts on`). A normal install has neither.
 */
export type NativeInboxState = "none" | "installed" | "running";

export const NATIVE_INBOX_STATES: readonly NativeInboxState[] = ["none", "installed", "running"];

/** The defaults key `scripts/native/staging.ts` writes; NativeStaging.defaultsKey in Swift. */
export const STAGING_FACES_DEFAULTS_KEY = "GenesisToolsStagingFaces";

export const PREVIEW_APP_NAME = "GenesisTools Preview.app";

export interface NativeInboxSignals {
    platform: boolean;
    previewBundle: boolean;
    appBundle: boolean;
    stagingFaces: boolean;
    widgetRunning: boolean;
}

/** The one mapping from signals to a state; the plugin hook's copy is pinned to it by a test. */
export function inboxStateFromSignals(signals: NativeInboxSignals): NativeInboxState {
    const installed = signals.platform && (signals.previewBundle || (signals.appBundle && signals.stagingFaces));

    if (!installed) {
        return "none";
    }

    return signals.widgetRunning ? "running" : "installed";
}

export function previewBundlePath(): string {
    return join(env.tools.getHome(), "Applications", PREVIEW_APP_NAME);
}

/**
 * The `worker.lock` of every widget data root: the normal app's (`hub/widget`) and the Preview bundle's isolated
 * root (`GenesisToolsWidgetStateRoot`, `scripts/build-widget-preview.ts`). The widget keeps `tools hub widget watch`
 * running for as long as it is open, and that process holds this lock (src/hub/lib/widget/watch.ts).
 */
export function widgetLockPaths(): string[] {
    return [toolDataDir("hub", "widget", "worker.lock"), toolDataDir("widget-preview", "data", "worker.lock")];
}

/**
 * `widget`, then later `watch`, as whole words: the normal app runs `hub/index.ts widget watch`, the Preview bundle
 * `hub/index.ts widget --state-root <its data root> watch` (WidgetModel.widgetArgs).
 */
export const WIDGET_WATCH_COMMAND = /(?:^|\s)widget\s(?:.*\s)?watch(?:\s|$)/;

/** The command a widget lock must name: the `tools hub widget watch` process the widget keeps open. */
export function isWidgetWatchCommand(command: string | null | undefined): boolean {
    return typeof command === "string" && WIDGET_WATCH_COMMAND.test(command);
}

/**
 * A widget lock holds a pid record (`{ pid, command, startedAt }`, src/utils/process/pidfile.ts). It counts only when
 * the pidfile module confirms that pid is still the process that wrote it (command line and start time, so a
 * recycled pid never reads as a running widget) and that process is the widget watcher.
 */
export function isLiveWidgetLock(path: string): boolean {
    const state = inspectPidFile(path);
    return state.status === "live" && isWidgetWatchCommand(state.record.command);
}

function readStagingMarker(): boolean {
    const result = Bun.spawnSync(["defaults", "read", GENESIS_APP_BUNDLE_ID, STAGING_FACES_DEFAULTS_KEY], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 2000,
    });
    // Exit 1 with "does not exist" is the normal case on a machine that never turned staging on.
    return result.exitCode === 0 && result.stdout.toString().trim() === "1";
}

export interface NativeInboxDeps {
    platform?: string;
    exists?: (path: string) => boolean;
    readStagingMarker?: () => boolean;
    liveWidgetLock?: (path: string) => boolean;
}

function readTextOrNull(path: string): string | null {
    try {
        return readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            logger.debug({ error, path }, "native-inbox: unreadable file");
        }

        return null;
    }
}

export function readNativeInboxSignals(deps: NativeInboxDeps = {}): NativeInboxSignals {
    const platform = (deps.platform ?? process.platform) === "darwin";
    const exists = deps.exists ?? existsSync;
    const liveWidgetLock = deps.liveWidgetLock ?? isLiveWidgetLock;
    const previewBundle = platform && exists(previewBundlePath());
    const appBundle = platform && exists(genesisAppBundlePath());
    // One `defaults` process, only where the normal app exists. Read even beside a Preview bundle, so the hooks' state
    // file lists every bundle that makes this Mac a native inbox and survives either one being removed.
    const stagingFaces = platform && appBundle && (deps.readStagingMarker ?? readStagingMarker)();
    const widgetRunning = platform && widgetLockPaths().some((path) => exists(path) && liveWidgetLock(path));

    return { platform, previewBundle, appBundle, stagingFaces, widgetRunning };
}

/**
 * `~/.genesis-tools/app/native-inbox.json`: what plugin hooks read, because a plugin file that runs cannot import
 * this module. It holds the install half (`installed`, the bundles that make it so) and where the widget locks are;
 * a reader decides `running` itself from those locks, so a stale file never claims a widget that has quit.
 * Written only when the content changes, and never created for `none`: a Mac without the app has no file.
 */
export function nativeInboxStateFile(): string {
    return join(genesisAppDir(), "native-inbox.json");
}

export interface NativeInboxStateRecord {
    version: 1;
    installed: boolean;
    bundles: string[];
    widgetLocks: string[];
}

export function nativeInboxRecord(signals: NativeInboxSignals): NativeInboxStateRecord {
    const installed = inboxStateFromSignals(signals) !== "none";
    const bundles = [
        ...(signals.previewBundle ? [previewBundlePath()] : []),
        ...(signals.appBundle && signals.stagingFaces ? [genesisAppBundlePath()] : []),
    ];

    return { version: 1, installed, bundles: installed ? bundles : [], widgetLocks: widgetLockPaths() };
}

export function writeNativeInboxStateFile(record: NativeInboxStateRecord, path = nativeInboxStateFile()): boolean {
    const text = `${SafeJSON.stringify(record, null, 2)}\n`;
    const current = readTextOrNull(path);

    if (current === text || (current === null && !record.installed)) {
        return false;
    }

    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text);
        logger.debug({ path, installed: record.installed }, "native-inbox: state file written");
        return true;
    } catch (error) {
        logger.warn({ error, path }, "native-inbox: could not write the state file");
        return false;
    }
}

const MEMO_MS = 15_000;
let memo: { at: number; state: NativeInboxState } | null = null;

/**
 * The native inbox state of this Mac, remembered for 15 s so a resident server asking per request costs nothing.
 * `refresh` skips the memory. Every computation also refreshes the plugin hooks' state file.
 */
export function nativeInboxState(opts: { refresh?: boolean; deps?: NativeInboxDeps } = {}): NativeInboxState {
    const now = Date.now();

    if (!opts.refresh && !opts.deps && memo && now - memo.at < MEMO_MS) {
        return memo.state;
    }

    const signals = readNativeInboxSignals(opts.deps);
    const state = inboxStateFromSignals(signals);
    logger.debug({ signals, state }, "native-inbox: state resolved");

    if (!opts.deps) {
        writeNativeInboxStateFile(nativeInboxRecord(signals));
        memo = { at: now, state };
    }

    return state;
}
