import { logger } from "@genesiscz/utils/logger";

interface ProcessInfo {
    ppid: number;
    command: string;
}

/**
 * The command line of the nearest `claude` ancestor of this process.
 *
 * A SessionStart hook is a grandchild of claude (claude → sh → the hook), so the
 * launch flags — `--model` above all — are only reachable by walking up the parent
 * chain. Every failure returns null: a missing model is a cosmetic gap in the picker,
 * never a reason to fail the hook and slow down a session start.
 */
export async function claudeAncestorCommand(startPid = process.ppid, maxHops = 6): Promise<string | null> {
    let pid = startPid;

    for (let hop = 0; hop < maxHops && pid > 1; hop += 1) {
        const info = await psInfo(pid);

        if (!info) {
            return null;
        }

        if (/(^|\/|\s)claude(\s|$)/.test(info.command)) {
            logger.debug({ pid, hop, command: info.command.slice(0, 200) }, "[claude-cmux] found the claude ancestor");
            return info.command;
        }

        pid = info.ppid;
    }

    return null;
}

async function psInfo(pid: number): Promise<ProcessInfo | null> {
    const proc = Bun.spawn(["ps", "-o", "ppid=,command=", "-p", String(pid)], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (code !== 0) {
        logger.debug({ pid, code, stderr: stderr.trim() }, "[claude-cmux] ps lookup failed");
        return null;
    }

    const match = /^\s*(\d+)\s+(.*)$/.exec(stdout.trim());

    if (!match) {
        return null;
    }

    return { ppid: Number(match[1]), command: match[2] };
}
