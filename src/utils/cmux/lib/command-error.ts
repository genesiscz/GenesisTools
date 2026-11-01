import type { CmuxRunResult } from "@genesiscz/utils/cmux/lib/cli";

/**
 * cmux prints a refused command as `Error: <code>: <detail>`, seen 2026-11-01 in the day log as
 * `Error: invalid_params: Surface is not a terminal`.
 */
const CMUX_FAILURE_CODE = /^Error:\s*([a-z]+(?:_[a-z]+)*):/;

/**
 * A cmux command exited non-zero or timed out. The message prints the whole command line, so it holds any text the
 * command carried (a pasted message can say `invalid_params`). Branch on `cmuxCode`, which is read from cmux's own
 * answer on stderr only, never on the message.
 */
export class CmuxCommandError extends Error {
    /** cmux's failure code (`invalid_params`), or undefined when the call timed out or cmux printed none. */
    readonly cmuxCode: string | undefined;

    constructor(
        readonly args: readonly string[],
        readonly result: CmuxRunResult
    ) {
        super(`cmux ${args.join(" ")} failed (${result.code}): ${result.stderr.trim()}`);
        this.name = "CmuxCommandError";
        this.cmuxCode = result.timedOut ? undefined : CMUX_FAILURE_CODE.exec(result.stderr.trim())?.[1];
    }
}

/** cmux refused the command's parameters. It checks them before it acts on the surface, so the command did nothing. */
export function isCmuxInvalidParams(err: unknown): boolean {
    return err instanceof CmuxCommandError && err.cmuxCode === "invalid_params";
}
