import { type ChildProcess, spawn } from "node:child_process";
import { SafeJSON } from "@genesiscz/utils/json";
import { AsyncQueue } from "../async-queue";
import { type Manager, type Operation, type OperationID, type Spec, UnsupportedOperationError } from "../operation";
import { TYPE_SHELL, TYPE_VALUE, VERSION_VALUE } from "./driver";

/**
 * A test-local stand-in for Go's `operation.NewLocalOperationManager`, for the twins that run
 * real operations (`stop_integration_test.go`). It honours the manager contract the coordinator
 * depends on, with the two operation types those tests use:
 *
 * - `value` (`operation.NewValueSpec`): ready → completed at once (`AdvanceValue`).
 * - `shell` (`operation.NewShellSpec`): the command runs under `sh -c` in its own process group,
 *   the state update carries `ProcessGroupID` while it runs (Go's `ShellState.ProcessGroupID`),
 *   exit completes it, and a cancel kills the whole group and reports `canceled`.
 *
 * The primitive actor runtime, output files, chunked reads and remote jobs of the Go manager
 * are not ported (UPSTREAM.md): this is the observable contract, not the runtime.
 */

export interface ShellInput {
    Command: string;
    Shell: string;
    Directory: string;
}

export interface ShellState {
    Input: ShellInput;
    BaseDirectory: string;
    ProcessGroupID?: number;
    PendingExitCode?: number | null;
    Result?: { Out: string; Err: string; OutSize: number; ErrSize: number; ExitCode: number };
}

export const VERSION_SHELL = 1;

/** Go `operation.NewShellSpec(input, baseDirectory, maxOutputLength)`. */
export function newShellSpec(input: ShellInput, baseDirectory: string, maxOutputLength: number): Spec {
    if (maxOutputLength <= 0) {
        throw new Error("max output length is out of range");
    }

    const state: ShellState = { Input: input, BaseDirectory: baseDirectory };
    return {
        MaxOutputLength: maxOutputLength,
        Type: TYPE_SHELL,
        Version: VERSION_SHELL,
        State: SafeJSON.stringify(state),
    };
}

export function decodeShellState(operation: Operation): ShellState {
    if (!operation.State) {
        throw new Error(`shell operation "${operation.ID}" has no state`);
    }

    return SafeJSON.parse(operation.State, { strict: true }) as ShellState;
}

interface RunningShell {
    operation: Operation;
    state: ShellState;
    child: ChildProcess;
    canceled: boolean;
}

export class LocalOperationManager implements Manager {
    readonly updateQueue = new AsyncQueue<Operation>();
    private readonly started = new Set<OperationID>();
    private readonly shells = new Map<OperationID, RunningShell>();

    updates(): AsyncQueue<Operation> {
        return this.updateQueue;
    }

    add(operation: Operation): void {
        if (this.started.has(operation.ID)) {
            return;
        }

        this.started.add(operation.ID);

        switch (operation.Type) {
            case TYPE_VALUE:
                if (operation.Version !== VERSION_VALUE) {
                    throw new UnsupportedOperationError(
                        `value operation "${operation.ID}" version ${operation.Version}`
                    );
                }

                this.updateQueue.push({ ...operation, Status: "completed" });
                return;
            case TYPE_SHELL:
                this.startShell(operation);
                return;
            default:
                throw new UnsupportedOperationError(`operation "${operation.ID}" type "${operation.Type}"`);
        }
    }

    private startShell(operation: Operation): void {
        const state = decodeShellState(operation);
        const child = spawn(state.Input.Shell || "/bin/sh", ["-c", state.Input.Command], {
            cwd: state.Input.Directory || state.BaseDirectory || undefined,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: process.env,
        });
        const running: RunningShell = { operation, state, child, canceled: false };
        this.shells.set(operation.ID, running);
        let out = "";
        let err = "";
        child.stdout?.on("data", (chunk: Buffer) => {
            out += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            err += chunk.toString();
        });

        state.ProcessGroupID = child.pid ?? 0;
        this.updateQueue.push({ ...operation, Status: "awaiting", State: SafeJSON.stringify(state) });

        child.on("exit", (code) => {
            this.shells.delete(operation.ID);
            state.ProcessGroupID = 0;

            if (running.canceled) {
                this.updateQueue.push({ ...operation, Status: "canceled", State: SafeJSON.stringify(state) });
                return;
            }

            const exitCode = code ?? -1;
            state.PendingExitCode = exitCode;
            state.Result = { Out: out, Err: err, OutSize: out.length, ErrSize: err.length, ExitCode: exitCode };
            this.updateQueue.push({ ...operation, Status: "completed", State: SafeJSON.stringify(state) });
        });
    }

    cancel(id: OperationID, _reason: string): void {
        const running = this.shells.get(id);

        if (!running) {
            return;
        }

        running.canceled = true;
        const pgid = running.child.pid;

        if (pgid) {
            try {
                // The group leader is `child.pid` of a process this manager spawned with `detached: true`
                // and still holds in `shells` (the exit handler removes it), so it cannot have been reused.
                // pid-verified: own spawned child, still held, not yet exited
                process.kill(-pgid, "SIGKILL");
            } catch {
                running.child.kill("SIGKILL");
            }
        }
    }

    /** Kill anything still running, for a test's cleanup. */
    dispose(): void {
        for (const id of this.shells.keys()) {
            this.cancel(id, "dispose");
        }
    }
}
