import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { colorizeUnifiedDiff, renderUnifiedDiff } from "@genesiscz/utils/diff";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { parseSync, type Span, Visitor } from "oxc-parser";
import type { ManagedEdit } from "./managed-patches";

const MAX_CONTEXT_BYTES = 24_000;

function enclosingCode(source: string, edit: Span): Span | undefined {
    const parsed = parseSync("bundle.mjs", source);

    if (parsed.errors.length) {
        return undefined;
    }

    let enclosing: Span | undefined;
    const consider = (node: Span) => {
        if (
            node.start <= edit.start &&
            node.end >= edit.end &&
            node.end - node.start <= MAX_CONTEXT_BYTES &&
            (!enclosing || node.end - node.start < enclosing.end - enclosing.start)
        ) {
            enclosing = node;
        }
    };

    new Visitor({
        FunctionDeclaration: consider,
        FunctionExpression: consider,
        ArrowFunctionExpression: consider,
        IfStatement: consider,
    }).visit(parsed.program);

    return enclosing;
}

function formatSnippet(source: string): string | undefined {
    try {
        const binary = fileURLToPath(new URL("./bin/biome", import.meta.resolve("@biomejs/biome/package.json")));
        const result = spawnSync(
            process.execPath,
            [binary, "format", "--stdin-file-path=patch-preview.js", "--line-width=88", "--indent-style=space"],
            {
                // The caller's project may disable formatting. Preview uses
                // GenesisTools' configuration regardless of the launch directory.
                cwd: fileURLToPath(new URL("../../../../../", import.meta.url)),
                input: Buffer.from(source),
                timeout: 5_000,
                maxBuffer: 8 * 1024 * 1024,
                stdio: ["pipe", "pipe", "pipe"],
            }
        );
        if (result.status === 0) {
            return result.stdout.toString();
        }

        logger.debug({ error: result.error, status: result.status }, "patch preview formatter failed");
        return undefined;
    } catch (error) {
        logger.debug({ error }, "patch preview formatter unavailable");
        return undefined;
    }
}

export function renderPatchPreview({ patch, source, edit, module, applied }: ManagedEdit): string {
    const label = `${module} · ${patch.id}`;
    const header = `${applied ? "Revert" : "Apply"} ${patch.id} · ${patch.description}`;
    const original = source.slice(edit.start, edit.end);
    const enclosing = enclosingCode(source, edit);
    const moduleSpan = { start: 0, end: source.length };

    for (const span of enclosing ? [enclosing, moduleSpan] : [moduleSpan]) {
        const prefix = source.slice(span.start, edit.start);
        const suffix = source.slice(edit.end, span.end);
        const originalCode = formatSnippet(prefix + original + suffix);
        const patchedCode = formatSnippet(prefix + edit.replacement + suffix);

        if (originalCode && patchedCode && originalCode !== patchedCode) {
            const diff = renderUnifiedDiff({
                before: applied ? patchedCode : originalCode,
                after: applied ? originalCode : patchedCode,
                label,
                context: 6,
            });
            return `${header}\n${colorizeUnifiedDiff(diff)}`;
        }
    }

    const before = applied ? edit.replacement : original;
    const after = applied ? original : edit.replacement;
    const show = (value: string) => {
        const visible = value.trimEnd();
        const trailing = value.length - visible.length;
        const quoted = SafeJSON.stringify(visible, { strict: true });
        return trailing ? `${quoted} (+${trailing} trailing whitespace characters)` : quoted;
    };
    return `${header}\n${colorizeUnifiedDiff(`@@ ${label} · source offsets ${edit.start}–${edit.end} @@\n- ${show(before)}\n+ ${show(after)}`)}`;
}

export function renderRecoveryPreview(module: string, before: Buffer, after: Uint8Array): string {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

    try {
        const oldSource = decoder.decode(before);
        const newSource = decoder.decode(after);
        const originalCode = formatSnippet(oldSource);
        const patchedCode = formatSnippet(newSource);
        const diff = renderUnifiedDiff({
            before: originalCode ?? oldSource,
            after: patchedCode ?? newSource,
            label: module,
            context: 6,
        });

        if ((!originalCode || !patchedCode) && diff.length > MAX_CONTEXT_BYTES) {
            throw new Error(
                "Recovery source diff exceeds the preview limit. Write a separate repack output for inspection."
            );
        }
        if (diff) {
            return colorizeUnifiedDiff(diff);
        }
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("Recovery source diff")) {
            throw error;
        }
        // The backup can restore embedded assets as well as JavaScript.
    }

    return `${module} · restore from backup and reapply selection (${before.byteLength} → ${after.byteLength} bytes)`;
}
