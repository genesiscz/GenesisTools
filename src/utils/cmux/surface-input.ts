import { type CmuxRunResult, runCmux } from "@genesiscz/utils/cmux/lib/cli";

/**
 * One input after a surface's text: a named key through `cmux send-key` (`enter`, `escape`), or characters typed
 * through `cmux send` (`{ text: "2" }`, a dialog's option number).
 */
export type SurfaceKeyPress = string | { text: string };

/** Why cmux took none (or not all) of an input: its own draft or dialog check, or no answer in time. */
export type SurfaceWriteRefusal = "draft-present" | "dialog-open" | "timeout";

export type SurfaceWrite =
    | { ok: true }
    | {
          ok: false;
          reason: SurfaceWriteRefusal;
          detail: string;
          /** An earlier press went in, or the call that timed out may have landed: the pane is not as it was. */
          mayHaveLanded: boolean;
      };

/**
 * An input cmux failed for a reason its own draft and dialog guard does not name (a missing surface, a socket error,
 * an unknown flag), or a forced input it still refused: an error, not a refusal.
 */
export class SurfaceInputError extends Error {
    constructor(
        message: string,
        /** An earlier press went in before the failing step: the pane is not as it was. */
        readonly mayHaveLanded = false
    ) {
        super(message);
    }
}

/**
 * The guard refusal cmux names on stderr (`ensureAgentPromptIsFree` in cmux's CLI): "... is waiting on a question or
 * dialog, so nothing was sent" and "the agent prompt in ... holds text someone is typing, so nothing was sent". Any
 * other failure is an operational error, never a claim about the person's draft or an open dialog.
 */
export function surfaceGuardRefusal(stderr: string): "draft-present" | "dialog-open" | undefined {
    if (/waiting on a question or dialog/i.test(stderr)) {
        return "dialog-open";
    }

    if (/holds text someone is typing/i.test(stderr)) {
        return "draft-present";
    }

    return undefined;
}

/**
 * The one cmux writer for a surface's input: paste the text (never typed, so a backslash, `\n` or a quote arrives as
 * written), then press each key in order. Without `force`, cmux's own checks apply: a paste or typed text refuses
 * while an agent prompt holds a draft (`draft-present`) or a dialog is open (`dialog-open`), a key refuses into an
 * open dialog. Only a refusal cmux names as its guard is returned as one; any other failure, and any failure with
 * `force` (the open dialog is the target), throws `SurfaceInputError`. A call that times out may have landed, so
 * nothing after it is pressed.
 */
export async function writeSurfaceInput(input: {
    /** The surface on a cmux command line: `["--surface", <uuid>]`, or `surfaceTargetArgs(…)`. */
    where: readonly string[];
    text?: string;
    /** After the paste, press the agent's submit key (`cmux paste --submit`), in the same call. */
    submit?: boolean;
    keys?: readonly SurfaceKeyPress[];
    force?: boolean;
    run?: (args: string[]) => Promise<CmuxRunResult>;
}): Promise<SurfaceWrite> {
    const run = input.run ?? ((args: string[]) => runCmux(args));
    const force = input.force ? ["--force"] : [];
    const steps: { args: string[]; label: string }[] = [];

    if (input.text !== undefined) {
        steps.push({
            args: ["paste", ...input.where, ...(input.submit ? ["--submit"] : []), ...force, "--", input.text],
            label: `paste (${input.text.length} characters)`,
        });
    }

    for (const key of input.keys ?? []) {
        steps.push(
            typeof key === "string"
                ? { args: ["send-key", ...input.where, ...force, key], label: `send-key ${key}` }
                : {
                      args: ["send", ...input.where, ...force, "--", key.text],
                      label: `send (${key.text.length} characters)`,
                  }
        );
    }

    for (const [index, step] of steps.entries()) {
        const result = await run(step.args);

        if (result.timedOut) {
            return {
                ok: false,
                reason: "timeout",
                detail: `cmux ${step.label} timed out: ${result.stderr.trim() || "no answer"}`,
                mayHaveLanded: true,
            };
        }

        if (result.code !== 0) {
            const stderr = result.stderr.trim();
            const refusal = input.force ? undefined : surfaceGuardRefusal(stderr);

            if (!refusal) {
                const landed = index > 0 ? " An earlier press went in." : "";
                throw new SurfaceInputError(
                    `cmux ${step.label} failed (${result.code}): ${stderr || "no detail"}.${landed}`,
                    index > 0
                );
            }

            return {
                ok: false,
                reason: refusal,
                detail: `cmux ${step.label} refused (${result.code}): ${stderr}`,
                mayHaveLanded: index > 0,
            };
        }
    }

    return { ok: true };
}
