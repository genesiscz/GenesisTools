import { sendSurfaceText } from "@genesiscz/utils/cmux/lib/cli";
import { out } from "@genesiscz/utils/logger";

export async function queueReplayCommand(input: {
    surfaceRef: string;
    command: string;
    enter: boolean;
}): Promise<boolean> {
    if (!input.enter && [...input.command].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
        out.log.warn(
            `Skipped pretyping multiline/control input in ${input.surfaceRef}; use --enter to explicitly execute the saved command.`
        );
        return false;
    }

    await sendSurfaceText({ surfaceRef: input.surfaceRef, text: input.enter ? `${input.command}\n` : input.command });
    return true;
}
