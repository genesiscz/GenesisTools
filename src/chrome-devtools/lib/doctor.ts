/**
 * `doctor` — READ-ONLY diagnosis. It reports and prints fix commands; the
 * mutating counterpart is lib/cleanup.ts. (Repo rule: a diagnostic must never
 * mutate — see .claude/rules/code.md "Side Effects".)
 */

import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { artifactPath } from "./platform.ts";
import { connectBrowser } from "./recorder.ts";
import { browsersWithEmptyDebugFlag } from "./resolve-attach.ts";
import { listPossiblyHeldPopups } from "./resume.ts";
import { CAPTURE_CAP_BYTES } from "./segments.ts";
import { collectStatus, type StatusReport } from "./status.ts";

const { log } = logger.scoped("chrome-devtools:doctor");

export interface HeldPopups {
    port: number;
    urls: string[];
}

export interface Finding {
    severity: "err" | "warn" | "info";
    id: string;
    title: string;
    detail: string;
    fix?: string;
}

export function findingsFromStatus(
    report: StatusReport,
    emptyDebugFlag: string[],
    heldPopups: HeldPopups[] = []
): Finding[] {
    const findings: Finding[] = [];

    for (const p of report.ports) {
        if (p.pidState.status === "dead") {
            findings.push({
                severity: "warn",
                id: `stale-pidfile-${p.port}`,
                title: `port ${p.port}: stale recorder pidfile`,
                detail: `pid ${p.pidState.pid} is gone; the pidfile survived a crash or a reboot.`,
                fix: toolCommand("chrome-devtools cleanup", "--stale", String(p.port)),
            });
        }

        if (p.pidState.status === "foreign") {
            findings.push({
                severity: "err",
                id: `recycled-pid-${p.port}`,
                title: `port ${p.port}: pidfile points at a DIFFERENT program`,
                detail: `pid ${p.pidState.pid} now runs "${p.pidState.command}". Never kill it; clear the pidfile.`,
                fix: toolCommand("chrome-devtools cleanup", "--stale", String(p.port)),
            });
        }

        if (p.pidState.status === "live" && p.sample?.cpuPercent != null && p.sample.cpuPercent > 25) {
            findings.push({
                severity: "warn",
                id: `hot-recorder-${p.port}`,
                title: `port ${p.port}: recorder is hot (${p.sample.cpuPercent}% CPU)`,
                detail: `Scope it down with --match, or stop it. Channels: ${p.meta?.channels.join(",") ?? "?"}.`,
                fix: `${toolCommand("chrome-devtools")} record --port ${p.port} --stop`,
            });
        }

        if (p.pidState.status !== "live" && p.segments.count > 0) {
            findings.push({
                severity: "info",
                id: `leftover-buffer-${p.port}`,
                title: `port ${p.port}: leftover capture buffer (${p.segments.count} segment(s))`,
                detail: "No recorder is running; the buffer is still dumpable.",
                fix: `${toolCommand("chrome-devtools har", "--port", String(p.port), "--from-buffer", "-o", artifactPath(`cdp-${p.port}.har`))}   # or: cleanup --dir ${p.port}`,
            });
        }

        if (p.segments.bytes > CAPTURE_CAP_BYTES) {
            findings.push({
                severity: "warn",
                id: `over-cap-${p.port}`,
                title: `port ${p.port}: capture buffer over the ${Math.round(CAPTURE_CAP_BYTES / 1e6)} MB cap`,
                detail: `${Math.round(p.segments.bytes / 1e6)} MB on disk; the recorder prunes at its next rotation.`,
            });
        }
    }

    for (const orphan of report.orphans) {
        const old = orphan.command.includes("skills/chrome-devtools/scripts");
        findings.push({
            severity: "err",
            id: `orphan-${orphan.pid}`,
            title: `orphan ${old ? "OLD-skill arm" : "recorder-shaped"} process (pid ${orphan.pid})`,
            detail: `${orphan.sample?.cpuPercent != null ? `${orphan.sample.cpuPercent}% CPU, up ${orphan.sample.elapsed}. ` : ""}No pidfile owns it: ${orphan.command.slice(0, 120)}`,
            fix: toolCommand("chrome-devtools cleanup", "--kill", String(orphan.pid)),
        });
    }

    if (report.legacyFiles.length > 0) {
        findings.push({
            severity: "info",
            id: "legacy-arm-files",
            title: `${report.legacyFiles.length} legacy /tmp/cdp-arm-* file(s) from the old skill`,
            detail: report.legacyFiles.join(", "),
            fix: toolCommand("chrome-devtools cleanup", "--legacy"),
        });
    }

    for (const id of emptyDebugFlag) {
        findings.push({
            severity: "warn",
            id: `empty-debug-flag-${id}`,
            title: `${id}: running with an EMPTY --remote-debugging-port= flag`,
            detail: "The flag has no value, so nothing listens. Restart the browser with a real port.",
            fix: toolCommand("chrome-devtools restart", "--browser", id, "--port", "9222"),
        });
    }

    for (const held of heldPopups) {
        if (held.urls.length === 0) {
            continue;
        }

        findings.push({
            severity: "warn",
            id: `held-popup-${held.port}`,
            title: `port ${held.port}: ${held.urls.length} possibly held popup(s)`,
            detail: 'A page with an empty URL and an opener: a debugger client may hold it, and its opener then shows "Debugger paused in another tab".',
            fix: toolCommand("chrome-devtools resume", "--port", String(held.port)),
        });
    }

    return findings;
}

/** Read-only: Target.getTargets on each live endpoint; a port that does not answer is skipped. */
async function findHeldPopups(report: StatusReport): Promise<HeldPopups[]> {
    const live = report.ports.filter((p) => p.endpoint !== null);

    return Promise.all(
        live.map(async ({ port }): Promise<HeldPopups> => {
            try {
                const signal = AbortSignal.timeout(1500);
                const conn = await connectBrowser(port, { signal });
                try {
                    return { port, urls: (await listPossiblyHeldPopups(conn, signal)).map((t) => t.url) };
                } finally {
                    conn.close();
                }
            } catch (err) {
                log.debug({ err, port }, "held-popup check skipped");
                return { port, urls: [] };
            }
        })
    );
}

export async function diagnose(): Promise<Finding[]> {
    const report = await collectStatus();

    return findingsFromStatus(report, browsersWithEmptyDebugFlag(), await findHeldPopups(report));
}
