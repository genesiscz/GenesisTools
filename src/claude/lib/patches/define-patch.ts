import type { Program, Span } from "oxc-parser";

interface PatchMetadata {
    readonly id: string;
    readonly description: string;
    readonly versions?: readonly string[];
    /** Stable text used to find candidate modules. Defaults to the entrypoint. */
    readonly moduleHint?: string;
}

interface LiteralPatch extends PatchMetadata {
    readonly find: string;
    readonly replace: string;
}

export interface AstPatchMatch extends Span {
    readonly replacement: string;
}

interface AstPatch extends PatchMetadata {
    readonly ast: (program: Program, source: string) => readonly AstPatchMatch[];
}

export type ClaudeCodePatch = LiteralPatch | AstPatch;

export function definePatch(patch: ClaudeCodePatch): ClaudeCodePatch {
    if ("ast" in patch) {
        return patch;
    }

    if (!patch.find || !patch.replace || patch.find === patch.replace) {
        throw new Error(`Patch ${patch.id} needs distinct, nonempty strings`);
    }

    if (Buffer.byteLength(patch.find) !== Buffer.byteLength(patch.replace)) {
        throw new Error(`Patch ${patch.id} must preserve the match's UTF-8 byte length`);
    }

    return patch;
}
