import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { Analyzer } from "@app/doctor/lib/analyzer";
import { run } from "@app/doctor/lib/run";
import type { AnalyzerCategory, AnalyzerContext, Finding } from "@app/doctor/lib/types";
import { logger } from "@genesiscz/utils/logger";
import { ancestry, readExecutablePath } from "@genesiscz/utils/process/processes";

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
    // Developer Tools depends on this process's host, so machine-wide cached results are unsafe.
    readonly cacheTtlMs = 0;

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
    const host = hostAppBundle(ancestorExecutables(process.pid));
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
    const allowed = bundleId ? developerToolStatus(readDeveloperToolClients(), bundleId) : null;
    if (allowed === null) {
        return null;
    }
    return {
        id: "sec-developer-tools",
        analyzerId,
        title: `Developer Tools for ${name}: ${allowed ? "on" : "off"}`,
        detail: developerToolsDetail(name, allowed),
        severity: allowed ? "safe" : "cautious",
        actions: [],
        metadata: { check: "Developer Tools", passing: allowed, app: host, bundleId },
    };
}

export function developerToolsDetail(name: string, allowed: boolean): string {
    const tradeoff = "This reduces macOS protection; grant Developer Tools access only to a host you trust.";
    return allowed
        ? `${name} is on the Developer Tools list: programs it starts skip the per-launch Gatekeeper scan ` +
              `(a new entry counts once ${name} restarts). ${tradeoff}`
        : `macOS scans every new program ${name} starts before it runs, so builds and tests can wait on syspolicyd. ` +
              `${tradeoff} If you trust ${name}, add it in System Settings > Privacy & Security > Developer Tools, ` +
              `then restart ${name}.`;
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

interface DeveloperToolClient {
    client: string;
    auth_value: number;
}

/** A grant proves access; a missing grant proves denial only if every database was readable. */
export function developerToolStatus(reads: Array<DeveloperToolClient[] | null>, bundleId: string): boolean | null {
    if (reads.some((rows) => rows !== null && isDeveloperToolAllowed(rows, bundleId))) {
        return true;
    }

    return reads.length === 0 || reads.some((rows) => rows === null) ? null : false;
}

/**
 * The Developer Tools rows from both TCC databases (System Settings writes them to the system one).
 * Each unreadable database remains null so a partial read cannot turn an unknown grant into a denial.
 */
function readDeveloperToolClients(): Array<DeveloperToolClient[] | null> {
    const paths = [
        "/Library/Application Support/com.apple.TCC/TCC.db",
        join(homedir(), "Library/Application Support/com.apple.TCC/TCC.db"),
    ];
    const reads: Array<DeveloperToolClient[] | null> = [];
    for (const path of paths) {
        try {
            const db = new Database(path, { readonly: true });
            try {
                const found = db
                    .query<{ client: string; auth_value: number }, []>(
                        "SELECT client, auth_value FROM access WHERE service = 'kTCCServiceDeveloperTool'"
                    )
                    .all();
                reads.push(found);
            } finally {
                db.close();
            }
        } catch (error) {
            logger.debug({ error, path }, "could not read Developer Tools grants");
            reads.push(null);
        }
    }

    return reads;
}

/** `pid` and its ancestors below launchd, nearest first, each as its executable path (its kernel name when unreadable). */
function ancestorExecutables(pid: number): string[] {
    return ancestry(pid, 12)
        .filter((entry) => entry.pid > 1)
        .map((entry) => readExecutablePath(entry.pid) ?? entry.name);
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
