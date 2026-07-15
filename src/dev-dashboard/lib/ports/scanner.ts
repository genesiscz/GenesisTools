import { classifyPortBatch, enrichPortsMeta } from "@app/dev-dashboard/lib/ports/enrich";
import type { KillPortResult, PortInfo, PortsResult } from "@app/dev-dashboard/lib/ports/types";
import { logger } from "@app/logger";

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN` output into PortInfo[]. PURE + the unit-tested boundary.
 *
 * lsof columns are whitespace-separated and POSITIONAL except COMMAND (which lsof truncates to ~9
 * chars and may itself contain no spaces). We parse from the RIGHT: the NAME column always ends with
 * "(LISTEN)" preceded by "<addr>:<port>", and the TYPE column is "IPv4"/"IPv6". COMMAND is field[0],
 * PID is field[1].
 */
export function parseLsofListen(stdout: string): PortInfo[] {
    const out: PortInfo[] = [];
    const seen = new Set<string>();

    for (const raw of stdout.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("COMMAND")) {
            continue;
        }

        if (!line.includes("(LISTEN)")) {
            continue;
        }

        const fields = line.split(/\s+/);
        if (fields.length < 9) {
            logger.debug({ line }, "lsof: skipping short row");
            continue;
        }

        const command = fields[0];
        const pid = Number.parseInt(fields[1], 10);
        const typeField = fields.find((f) => f === "IPv4" || f === "IPv6");
        const nameField = fields[fields.length - 2]; // "<addr>:<port>" (last is "(LISTEN)")

        const colon = nameField.lastIndexOf(":");
        if (colon < 0 || Number.isNaN(pid) || !typeField) {
            logger.debug({ line }, "lsof: unparseable row");
            continue;
        }

        const address = nameField.slice(0, colon);
        const port = Number.parseInt(nameField.slice(colon + 1), 10);
        if (Number.isNaN(port)) {
            continue;
        }

        const proto: PortInfo["proto"] = typeField === "IPv6" ? "tcp6" : "tcp4";
        const key = `${pid}:${port}:${proto}`;
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        out.push({ port, pid, command, address, proto });
    }

    return out.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
}

/**
 * Fast list: lsof + batch process meta (argv/cwd/start/title/visibility). No HTTP probe.
 * Pair with `classifyListeningPorts` / SSE for progressive kind labels.
 */
export async function listListeningPorts(): Promise<PortsResult> {
    try {
        const proc = Bun.spawn(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"], { stdout: "pipe", stderr: "pipe" });
        await proc.exited;

        if (proc.exitCode !== 0 && proc.exitCode !== 1) {
            const stderr = await new Response(proc.stderr).text();
            logger.warn({ exitCode: proc.exitCode, stderr }, "lsof exited non-zero; treating as unavailable");
            return { lsofAvailable: false, ports: [], scannedAt: Date.now() };
        }

        const stdout = await new Response(proc.stdout).text();
        const raw = parseLsofListen(stdout);
        return { lsofAvailable: true, ports: await enrichPortsMeta(raw), scannedAt: Date.now() };
    } catch (err) {
        logger.debug({ err }, "lsof spawn failed; treating as unavailable");
        return { lsofAvailable: false, ports: [], scannedAt: Date.now() };
    }
}

/** HTTP-classify pending ports from a prior list. Returns only updated rows. */
export async function classifyListeningPorts(ports: PortInfo[]): Promise<PortInfo[]> {
    return classifyPortBatch(ports);
}

/**
 * Confirm the live process at `pid` still matches what we listed before signalling — PIDs are reused,
 * so without this we could kill an unrelated process (same discipline as ttyd manager's
 * processMatchesSession). Returns the live command string, or null when no such process exists.
 */
function liveCommand(pid: number): string | null {
    const res = Bun.spawnSync(["/bin/ps", "-p", String(pid), "-o", "command="], {
        stdio: ["ignore", "pipe", "ignore"],
    });
    if (res.exitCode !== 0) {
        return null;
    }

    return res.stdout.toString().trim();
}

export function killPort(pid: number, expectedCommand?: string): KillPortResult {
    if (!Number.isInteger(pid) || pid <= 1) {
        return { ok: false, killed: false, reason: "invalid pid" };
    }

    const cmd = liveCommand(pid);
    if (cmd === null) {
        return { ok: true, killed: false, reason: "pid not found" };
    }

    // lsof truncates COMMAND (e.g. "ControlCe"); require the listed token to be a substring of the
    // live command so we don't signal a recycled, unrelated PID.
    if (expectedCommand && !cmd.toLowerCase().includes(expectedCommand.toLowerCase().slice(0, 8))) {
        logger.warn({ pid, expectedCommand, cmd }, "port-killer: live command mismatch; refusing to kill");
        return { ok: false, killed: false, reason: "command mismatch" };
    }

    try {
        process.kill(pid, "SIGTERM");
        logger.info({ pid, cmd }, "port-killer: SIGTERM delivered");
        return { ok: true, killed: true };
    } catch (err) {
        logger.debug({ err, pid }, "port-killer: process.kill failed");
        return { ok: true, killed: false, reason: "already gone" };
    }
}
