/**
 * Find live worker-turn processes by their session marker (the uuid a backend
 * puts on its child's command line as --session-id / --resume). Look-first
 * process control: callers list before they kill, and kill exact pids only —
 * never a pattern.
 */
import { basename } from "node:path";

export interface RunningTurn {
    pid: number;
    command: string;
}

/**
 * Split one `ps -axo pid=,command=` line into its pid, its executable and the
 * argument tokens after it. Returns undefined for a line that is not a process
 * (a blank line, or a wrapped continuation).
 */
function parsePsLine(line: string): { pid: number; executable: string; args: string[] } | undefined {
    const trimmed = line.trim();

    if (!trimmed) {
        return undefined;
    }

    const [pidToken, executable, ...args] = trimmed.split(/\s+/);
    const pid = Number.parseInt(pidToken ?? "", 10);

    if (!Number.isFinite(pid) || !executable) {
        return undefined;
    }

    return { pid, executable, args };
}

/**
 * Decide whether one `ps` line is a worker turn for this session.
 *
 * Two separate questions, and both used to be answered against the WHOLE line.
 * `tail -f ~/.grok/sessions/<cwd>/<uuid>/chat_history.jsonl` then looked exactly
 * like a grok worker (the path carries both "grok" and the uuid), and callers
 * SIGTERM whatever this returns.
 *   1. Is the EXECUTABLE the agent binary? Not merely some path it mentions.
 *   2. Is the marker an ARGUMENT? Not a fragment inside a file path.
 */
export function matchRunningTurnLine(
    line: string,
    sessionMarker: string,
    binaryPattern: RegExp
): RunningTurn | undefined {
    const parsed = parsePsLine(line);

    if (!parsed || !binaryPattern.test(basename(parsed.executable))) {
        return undefined;
    }

    const carriesMarker = parsed.args.some(
        (arg) => arg === sessionMarker || arg.endsWith(`=${sessionMarker}`) || arg.endsWith(`:${sessionMarker}`)
    );

    return carriesMarker ? { pid: parsed.pid, command: line.trim() } : undefined;
}

export async function runningTurnPids(sessionMarker: string, binaryPattern: RegExp): Promise<RunningTurn[]> {
    if (sessionMarker.trim().length < 8) {
        // A short marker matches unrelated processes; refusing is safer than a
        // fuzzy kill list.
        return [];
    }

    const proc = Bun.spawn({ cmd: ["ps", "-axo", "pid=,command="], stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;

    const matches: RunningTurn[] = [];
    for (const line of text.split("\n")) {
        const match = matchRunningTurnLine(line, sessionMarker, binaryPattern);

        if (match && match.pid !== process.pid) {
            matches.push(match);
        }
    }

    return matches;
}
