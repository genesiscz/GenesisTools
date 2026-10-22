import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TimeWindow } from "./window";

/** The processes GenesisTools runs as: the app's faces, the Genesis apps, and bun under every `tools` command. */
const OURS = /^(GenesisTools|Genesis|Genesis Markdown|GenesisTools Preview|bun)[-_ ].*\.ips$/;

export interface CrashReport {
    path: string;
    process: string;
    at: string;
}

export function crashReportsDir(home = homedir()): string {
    return join(home, "Library", "Logs", "DiagnosticReports");
}

/** macOS crash and hang reports of GenesisTools processes written inside the window, newest first. */
export function crashReports(window: TimeWindow, dir = crashReportsDir()): CrashReport[] {
    if (!existsSync(dir)) {
        return [];
    }

    return readdirSync(dir)
        .filter((name) => OURS.test(name))
        .flatMap((name): CrashReport[] => {
            const path = join(dir, name);
            const mtime = statSync(path).mtime;
            if (mtime < window.from || mtime > window.to) {
                return [];
            }

            return [{ path, process: name.replace(/[-_ ]\d{4}-\d{2}-\d{2}.*$/, ""), at: mtime.toISOString() }];
        })
        .sort((a, b) => b.at.localeCompare(a.at));
}
