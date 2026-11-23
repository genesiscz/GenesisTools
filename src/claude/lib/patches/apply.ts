import { parseSync } from "oxc-parser";
import type { AstPatchMatch, ClaudeCodePatch } from "./define-patch";

function count(source: string, anchor: string): number {
    let matches = 0;

    for (let at = source.indexOf(anchor); at !== -1; at = source.indexOf(anchor, at + 1)) {
        matches++;
    }

    return matches;
}

type Inspection =
    | { state: "applicable"; edit: AstPatchMatch }
    | { state: "applied" }
    | { state: "incompatible"; reason: string };

export function inspectPatch(source: string, patch: ClaudeCodePatch, version?: string): Inspection {
    if (patch.versions?.length) {
        const supported = patch.versions.join(" or ");

        if (!version) {
            return {
                state: "incompatible",
                reason: `Claude Code version could not be read from the entrypoint; expected ${supported}`,
            };
        }

        if (!patch.versions.some((range) => Bun.semver.satisfies(version, range))) {
            return { state: "incompatible", reason: `Claude Code ${version} does not match ${supported}` };
        }
    }

    if ("ast" in patch) {
        const parsed = parseSync("bundle.mjs", source);

        if (parsed.errors[0]) {
            return { state: "incompatible", reason: `JavaScript parse failed: ${parsed.errors[0].message}` };
        }

        const matches = patch.ast(parsed.program);
        const [edit] = matches;

        if (!edit || matches.length !== 1) {
            return {
                state: "incompatible",
                reason: `Expected one AST match in the selected module, found ${matches.length}`,
            };
        }

        if (
            !Number.isInteger(edit.start) ||
            !Number.isInteger(edit.end) ||
            edit.start < 0 ||
            edit.end > source.length ||
            edit.start >= edit.end
        ) {
            return { state: "incompatible", reason: "AST matcher returned an invalid source span" };
        }

        const original = source.slice(edit.start, edit.end);

        if (original === edit.replacement) {
            return { state: "applied" };
        }

        const padding = Buffer.byteLength(original) - Buffer.byteLength(edit.replacement);
        return padding < 0
            ? { state: "incompatible", reason: `Replacement exceeds the original span by ${-padding} UTF-8 bytes` }
            : { state: "applicable", edit: { ...edit, replacement: edit.replacement + " ".repeat(padding) } };
    }

    const original = count(source, patch.find);
    const replacement = count(source, patch.replace);

    if (original === 1 && replacement === 0) {
        const start = source.indexOf(patch.find);
        return { state: "applicable", edit: { start, end: start + patch.find.length, replacement: patch.replace } };
    }

    if (original === 0 && replacement === 1) {
        return { state: "applied" };
    }

    return {
        state: "incompatible",
        reason: `Selected module has ${original} original and ${replacement} patched literal matches; expected one total`,
    };
}

export function patchStatus(source: string, patch: ClaudeCodePatch, version?: string): Inspection["state"] {
    return inspectPatch(source, patch, version).state;
}

export function applyPatches(source: string, patches: readonly ClaudeCodePatch[], version?: string): string {
    let patched = source;

    for (const patch of patches) {
        const result = inspectPatch(patched, patch, version);

        if (result.state === "incompatible") {
            throw new Error(`Patch ${patch.id}: ${result.reason}`);
        }

        if (result.state === "applicable") {
            const { start, end, replacement } = result.edit;
            patched = patched.slice(0, start) + replacement + patched.slice(end);
        }
    }

    for (const patch of patches) {
        const result = inspectPatch(patched, patch, version);

        if (result.state !== "applied") {
            const reason = result.state === "incompatible" ? result.reason : "Original match is still present";
            throw new Error(`Patch ${patch.id} could not be verified after editing: ${reason}`);
        }
    }

    return patched;
}
