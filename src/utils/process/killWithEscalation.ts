export interface KillableProcess {
    kill(signal?: NodeJS.Signals | number): void;
    readonly killed?: boolean;
    exited?: Promise<number | null | void>;
    on?(event: "exit", listener: () => void): void;
    exitCode?: number | null;
}

async function waitForExit(child: KillableProcess): Promise<void> {
    if (child.exitCode !== null && child.exitCode !== undefined) {
        return;
    }

    if (child.exited) {
        await child.exited;
        return;
    }

    await new Promise<void>((resolve) => {
        child.on?.("exit", () => resolve());
    });
}

/** SIGTERM, then SIGKILL after grace if the child is still alive. Returns true once exit is confirmed. */
export async function killWithEscalation(
    child: KillableProcess,
    opts: { graceMs?: number } = {}
): Promise<boolean> {
    const graceMs = opts.graceMs ?? 5000;

    try {
        child.kill("SIGTERM");
    } catch {
        return true;
    }

    const exited = await Promise.race([
        waitForExit(child).then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
    ]);

    if (!exited) {
        try {
            child.kill("SIGKILL");
        } catch {
            return true;
        }

        await waitForExit(child);
    }

    return true;
}