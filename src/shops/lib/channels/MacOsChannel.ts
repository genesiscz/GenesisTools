import { existsSync } from "node:fs";
import logger from "@app/logger";
import type { DispatchResult, NotificationChannel, NotificationPayload } from "./types";

const log = logger.child({ component: "MacOsChannel" });

interface SpawnHandle {
    exited: Promise<number | null>;
}

export interface MacOsChannelOptions {
    terminalNotifierPath?: string | null;
    osascriptPath?: string | null;
    spawn?: (cmd: string[]) => SpawnHandle;
}

const DEFAULT_TERMINAL_NOTIFIER_PATHS = ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"];

const DEFAULT_OSASCRIPT_PATH = "/usr/bin/osascript";

function defaultSpawn(cmd: string[]): SpawnHandle {
    const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
    return { exited: proc.exited };
}

function probePath(candidates: string[]): string | null {
    for (const p of candidates) {
        if (existsSync(p)) {
            return p;
        }
    }

    return null;
}

function escapeAS(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export class MacOsChannel implements NotificationChannel {
    readonly name = "macos" as const;
    private readonly terminalNotifierPath: string | null;
    private readonly osascriptPath: string | null;
    private readonly spawn: (cmd: string[]) => SpawnHandle;

    constructor(opts: MacOsChannelOptions = {}) {
        this.terminalNotifierPath =
            opts.terminalNotifierPath !== undefined
                ? opts.terminalNotifierPath
                : probePath(DEFAULT_TERMINAL_NOTIFIER_PATHS);
        this.osascriptPath =
            opts.osascriptPath !== undefined
                ? opts.osascriptPath
                : existsSync(DEFAULT_OSASCRIPT_PATH)
                  ? DEFAULT_OSASCRIPT_PATH
                  : null;
        this.spawn = opts.spawn ?? defaultSpawn;
        if (!this.available()) {
            log.warn(
                "MacOsChannel disabled: neither terminal-notifier nor osascript found. Install terminal-notifier via 'brew install terminal-notifier' for native banners."
            );
        }
    }

    available(): boolean {
        return this.terminalNotifierPath !== null || this.osascriptPath !== null;
    }

    async dispatch(payload: NotificationPayload): Promise<DispatchResult> {
        if (!this.available()) {
            return { channel: "macos", delivered: false };
        }

        const url = payload.buyUrl ?? `http://localhost:3072${payload.detailUrl}`;
        const cmd = this.terminalNotifierPath
            ? [
                  this.terminalNotifierPath,
                  "-title",
                  payload.title,
                  "-message",
                  payload.body,
                  "-open",
                  url,
                  "-group",
                  `shops-${payload.notification.master_product_id}`,
              ]
            : [
                  // biome-ignore lint/style/noNonNullAssertion: available() guarantees one of the two paths is non-null
                  this.osascriptPath!,
                  "-e",
                  `display notification "${escapeAS(payload.body)}" with title "${escapeAS(payload.title)}"`,
              ];

        try {
            const handle = this.spawn(cmd);
            const code = await handle.exited;
            if (code === 0) {
                return { channel: "macos", delivered: true };
            }

            return { channel: "macos", delivered: false, error: `exit ${code ?? "null"}` };
        } catch (err) {
            return {
                channel: "macos",
                delivered: false,
                error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
            };
        }
    }
}
