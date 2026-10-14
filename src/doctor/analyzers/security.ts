import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { Analyzer } from "@app/doctor/lib/analyzer";
import { run } from "@app/doctor/lib/run";
import type { AnalyzerCategory, AnalyzerContext, Finding } from "@app/doctor/lib/types";

interface SecurityCheck {
    cmd: string;
    args: string[];
    label: string;
    ok: (out: string) => boolean;
}

export class SecurityAnalyzer extends Analyzer {
    readonly id = "security";
    readonly name = "Security";
    readonly icon = "Q";
    readonly category: AnalyzerCategory = "security";
    readonly cacheTtlMs = 24 * 60 * 60 * 1000;

    protected async *run(_ctx: AnalyzerContext): AsyncIterable<Finding> {
        for (const check of securityChecks()) {
            const res = await run(check.cmd, check.args);
            const stdout = res.stdout ?? "";
            const stderr = res.stderr ?? "";
            const passing = res.status === 0 && check.ok(stdout);

            yield {
                id: `sec-${check.cmd}`,
                analyzerId: this.id,
                title: `${check.label}: ${passing ? "enabled" : "disabled"}`,
                detail: stdout.trim() || stderr.trim(),
                severity: passing ? "safe" : "cautious",
                actions: [],
                metadata: { check: check.label, passing },
            };
        }

        const devTools = await developerToolsFinding(this.id);
        if (devTools) {
            yield devTools;
        }
    }
}

/**
 * Whether the app that hosts this shell (cmux, Terminal, Ghostty, an editor) is on the Developer Tools list.
 * Off the list, macOS runs Gatekeeper and XProtect on every new program it starts before the program runs: about
 * 0.25 s for a tiny one, a full scan for a large one. Each build or test run makes new programs (adhoc, linker-signed,
 * with com.apple.provenance), and several at once on 2026-10-14 pinned syspolicyd at 100% and stalled every launch
 * until it was killed. Measured that day: a fresh binary's first launch took 260-400 ms under cmux (not listed) and
 * 22 ms under Terminal.app (listed).
 */
async function developerToolsFinding(analyzerId: string): Promise<Finding | null> {
    const host = hostAppBundle(await ancestorExecutables(process.pid));
    if (!host) {
        return null;
    }

    const name =
        host
            .split("/")
            .pop()
            ?.replace(/\.app$/, "") ?? host;
    const plist = await run("plutil", ["-extract", "CFBundleIdentifier", "raw", join(host, "Contents/Info.plist")]);
    const bundleId = plist.status === 0 ? plist.stdout.trim() : "";
    const listed = bundleId ? readDeveloperToolClients() : null;
    if (listed === null) {
        return null;
    }

    const allowed = isDeveloperToolAllowed(listed, bundleId);
    return {
        id: "sec-developer-tools",
        analyzerId,
        title: `Developer Tools for ${name}: ${allowed ? "on" : "off"}`,
        detail: allowed
            ? `${name} is on the Developer Tools list: programs it starts skip the per-launch Gatekeeper scan (a new entry counts once ${name} restarts).`
            : `macOS scans every new program ${name} starts before it runs, so each build or test run waits on syspolicyd, ` +
              "and several at once can pin it at 100%. Add the app in System Settings > Privacy & Security > " +
              `Developer Tools, then restart ${name}.`,
        severity: allowed ? "safe" : "cautious",
        actions: [],
        metadata: { check: "Developer Tools", passing: allowed, app: host, bundleId },
    };
}

/**
 * The outermost `.app` bundle up the process tree (`executables` runs from this process to the top): the app macOS
 * holds responsible for what the shell starts. An app executable run as a CLI inside the tree (the `tools` wrapper
 * runs through GenesisTools.app) does not take that over.
 */
export function hostAppBundle(executables: string[]): string | null {
    let outermost: string | null = null;
    for (const path of executables) {
        const match = path.match(/^(\/.+?\.app)\/Contents\/MacOS\//);
        if (match) {
            outermost = match[1];
        }
    }

    return outermost;
}

/** The bundle ids allowed in TCC's Developer Tools service (auth_value 2 is allowed). */
export function isDeveloperToolAllowed(rows: Array<{ client: string; auth_value: number }>, bundleId: string): boolean {
    return rows.some((row) => row.client === bundleId && row.auth_value === 2);
}

/**
 * The Developer Tools rows from both TCC databases (System Settings writes them to the system one). Null when
 * neither can be read (the host has no Full Disk Access): the check is skipped, not failed.
 */
function readDeveloperToolClients(): Array<{ client: string; auth_value: number }> | null {
    const paths = [
        "/Library/Application Support/com.apple.TCC/TCC.db",
        join(homedir(), "Library/Application Support/com.apple.TCC/TCC.db"),
    ];
    let rows: Array<{ client: string; auth_value: number }> | null = null;
    for (const path of paths) {
        try {
            const db = new Database(path, { readonly: true });
            try {
                const found = db
                    .query<{ client: string; auth_value: number }, []>(
                        "SELECT client, auth_value FROM access WHERE service = 'kTCCServiceDeveloperTool'"
                    )
                    .all();
                rows = [...(rows ?? []), ...found];
            } finally {
                db.close();
            }
        } catch {
            // Unreadable without Full Disk Access; the other database may still answer.
        }
    }

    return rows;
}

async function ancestorExecutables(pid: number): Promise<string[]> {
    const paths: string[] = [];
    let current = pid;
    for (let depth = 0; depth < 12 && current > 1; depth++) {
        const res = await run("ps", ["-o", "ppid=", "-o", "comm=", "-p", String(current)]);
        const match = res.stdout.trim().match(/^(\d+)\s+(.+)$/);
        if (res.status !== 0 || !match) {
            break;
        }

        paths.push(match[2]);
        current = Number(match[1]);
    }

    return paths;
}

export function isFileVaultEnabled(out: string): boolean {
    return /FileVault is On/i.test(out);
}

export function isGatekeeperEnabled(out: string): boolean {
    return /assessments enabled/i.test(out);
}

export function isSipEnabled(out: string): boolean {
    return /enabled/i.test(out);
}

function securityChecks(): SecurityCheck[] {
    return [
        {
            cmd: "fdesetup",
            args: ["status"],
            label: "FileVault",
            ok: isFileVaultEnabled,
        },
        {
            cmd: "spctl",
            args: ["--status"],
            label: "Gatekeeper",
            ok: isGatekeeperEnabled,
        },
        {
            cmd: "csrutil",
            args: ["status"],
            label: "SIP (System Integrity Protection)",
            ok: isSipEnabled,
        },
    ];
}
