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

/** A forced input cmux still refused: no guard explains it, so it is an error, not a refusal. */
export class SurfaceInputError extends Error {}

/**
 * The one cmux writer for a surface's input: paste the text (never typed, so a backslash, `\n` or a quote arrives as
 * written), then press each key in order. Without `force`, cmux's own checks apply: a paste or typed text refuses
 * while an agent prompt holds a draft or a dialog is open (`draft-present`), a key refuses into an open dialog
 * (`dialog-open`). With `force` (the open dialog is the target), a refusal throws `SurfaceInputError`. A call that
 * times out may have landed, so nothing after it is pressed.
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
    const steps: { args: string[]; label: string; refusal: SurfaceWriteRefusal }[] = [];

    if (input.text !== undefined) {
        steps.push({
            args: ["paste", ...input.where, ...(input.submit ? ["--submit"] : []), ...force, "--", input.text],
            label: `paste (${input.text.length} characters)`,
            refusal: "draft-present",
        });
    }

    for (const key of input.keys ?? []) {
        steps.push(
            typeof key === "string"
                ? {
                      args: ["send-key", ...input.where, ...force, key],
                      label: `send-key ${key}`,
                      refusal: "dialog-open",
                  }
                : {
                      args: ["send", ...input.where, ...force, "--", key.text],
                      label: `send (${key.text.length} characters)`,
                      refusal: "draft-present",
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
            const detail = `cmux ${step.label} refused (${result.code}): ${result.stderr.trim() || "no detail"}`;

            if (input.force) {
                throw new SurfaceInputError(detail);
            }

            return {
                ok: false,
                reason: step.refusal,
                detail:
                    step.refusal === "draft-present"
                        ? `${detail}. cmux refuses while the prompt holds a draft or a question or permission dialog is open.`
                        : `${detail}. cmux refuses a key while a dialog is open.`,
                mayHaveLanded: index > 0,
            };
        }
    }

    return { ok: true };
}
