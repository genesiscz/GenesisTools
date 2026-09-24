import { connect } from "node:net";
import { commandWords, spawnToolDetached } from "@genesiscz/utils/cli";
import { registryEntryForPort } from "@genesiscz/utils/ui/dashboards";

export interface EnsureTarget {
    name: string;
    launch: string | null;
}

export interface EnsureDeps {
    lookup: (port: number) => EnsureTarget | null;
    listening: (port: number) => Promise<boolean>;
    spawn: (launch: string) => void;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
}

export type EnsureResult = { ok: true; name: string; started: boolean } | { ok: false; code: 1 | 2; message: string };

export async function ensurePort(port: number, deps: EnsureDeps, timeoutMs = 20_000): Promise<EnsureResult> {
    const target = deps.lookup(port);

    if (!target) {
        return { ok: false, code: 2, message: `port ${port} is not registered` };
    }

    if (await deps.listening(port)) {
        return { ok: true, name: target.name, started: false };
    }

    if (!target.launch) {
        return { ok: false, code: 2, message: `${target.name} has no launch command` };
    }

    deps.spawn(target.launch);
    const deadline = deps.now() + timeoutMs;

    while (deps.now() < deadline) {
        if (await deps.listening(port)) {
            return { ok: true, name: target.name, started: true };
        }

        const remaining = deadline - deps.now();
        await deps.sleep(Math.min(200, Math.max(100, remaining)));
    }

    return { ok: false, code: 1, message: `${target.name} did not listen on ${port} within ${timeoutMs}ms` };
}

export async function ensureRegisteredPort(port: number): Promise<EnsureResult> {
    return ensurePort(port, {
        lookup: (value) => {
            const entry = registryEntryForPort(value);
            return entry ? { name: entry.name, launch: entry.launch } : null;
        },
        listening: portIsOpen,
        spawn: (launch) => {
            const [program, ...args] = commandWords(launch);

            // Registered launches are `tools <tool> ...`: the shared launcher resolves `tools`
            // worktree-safely and routes it through GenesisTools.app, as `tools` on a terminal does.
            if (program === "tools") {
                spawnToolDetached(args);
                return;
            }

            if (!program) {
                throw new Error(`empty launch command for port ${port}`);
            }

            const child = Bun.spawn([program, ...args], {
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
                detached: true,
            });
            child.unref();
        },
        sleep: (ms) => Bun.sleep(ms),
        now: () => Date.now(),
    });
}

/** `localhost` resolves to ::1 first on macOS, and a dev server such as Vite may listen only there. */
export async function portIsOpen(port: number): Promise<boolean> {
    return (await portIsOpenOn("127.0.0.1", port)) || (await portIsOpenOn("::1", port));
}

function portIsOpenOn(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host, port, timeout: 200 });
        const finish = (open: boolean) => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(open);
        };
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));
    });
}
