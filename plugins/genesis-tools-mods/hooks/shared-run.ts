// One command's answer, shared by every session on this Mac for a while. On 2026-10-27, 26 sessions each asked
// `gh pr view` for the same PRs every 2 minutes (3050 runs that day, about 1.1 s each): the first session to ask
// now writes the answer to `<agents>/mods-state/shared-runs/<hash>.json`, and the others read the file until it is
// `ttlMs` old. A half-written or foreign file reads as a miss, so the worst case is the old cost.
import { agentsDir, type Host, isRecord } from "./shared";

export interface SharedRunResult {
    exitCode: number;
    stdout: string;
}

/** FNV-1a, 32 bits: a file name for the key. The file holds the key itself, so a collision reads as a miss. */
function hashOf(text: string): string {
    let hash = 0x811c9dc5;

    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }

    return hash.toString(16).padStart(8, "0");
}

/**
 * `argv` run in `cwd`, or the answer another session (or this one) got for the same command and folder within
 * `ttlMs`. Undefined when the command could not start or timed out; such an answer is not shared.
 */
export async function sharedRun(
    host: Host,
    ask: { argv: readonly string[]; cwd: string; ttlMs: number; timeoutMs: number }
): Promise<SharedRunResult | undefined> {
    const dir = await agentsDir(host);
    const key = `${ask.cwd}\n${ask.argv.join("\u0000")}`;
    const path = dir ? `${dir}/mods-state/shared-runs/${hashOf(key)}.json` : undefined;

    if (path) {
        const text = await host.read(path).catch(() => undefined);

        try {
            const held: unknown = text ? JSON.parse(text) : undefined;

            if (
                isRecord(held) &&
                held.key === key &&
                typeof held.at === "number" &&
                Date.now() - held.at < ask.ttlMs &&
                typeof held.exitCode === "number" &&
                typeof held.stdout === "string"
            ) {
                return { exitCode: held.exitCode, stdout: held.stdout };
            }
        } catch {
            // A file another session is writing: run the command.
        }
    }

    const done = await host.run(ask.argv, { cwd: ask.cwd, timeoutMs: ask.timeoutMs }).catch(() => undefined);

    if (!done) {
        return undefined;
    }

    if (path) {
        const record = { key, at: Date.now(), exitCode: done.exitCode, stdout: done.stdout };
        await host.write(path, JSON.stringify(record)).catch(() => undefined);
    }

    return { exitCode: done.exitCode, stdout: done.stdout };
}
