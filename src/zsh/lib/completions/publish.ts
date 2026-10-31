import { unlinkSync } from "node:fs";
import { readRc, replaceRc } from "../shell-rc";
import { type CompletionsState, writeState } from "./state";

/**
 * Writes the new rc, then the state that records what it replaced. When the state cannot be saved the rc goes back:
 * without that record no uninstall could put the replaced hand blocks back. An rc that did not exist before is
 * removed again, but only while it still holds exactly what this run wrote, so another writer's file stays.
 */
export function publishInstall(input: {
    rcPath: string;
    rcBefore: string | undefined;
    after: string;
    state: CompletionsState;
    saveState?: (state: CompletionsState) => void;
}): void {
    const { rcPath, rcBefore, after } = input;
    replaceRc(rcPath, rcBefore, after);

    try {
        (input.saveState ?? writeState)(input.state);
    } catch (error) {
        if (rcBefore !== undefined) {
            replaceRc(rcPath, after, rcBefore);
        } else if (readRc(rcPath) === after) {
            unlinkSync(rcPath);
        }

        throw new Error(`Could not save the completions state, so ${rcPath} was put back as it was.`, {
            cause: error,
        });
    }
}
