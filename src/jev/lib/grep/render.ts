import type { OwnedProject, TestCommand } from "@genesiscz/utils/repo-context";
import { type FileEvidence, type RetrievalResult, toJson } from "./types";

/** 0 means unlimited, matching upstream `DEFAULT_MAX_SOURCE_BYTES`. */
export const DEFAULT_MAX_SOURCE_BYTES = 0;
export const PACKET_TERMINATOR = "End context.";

/**
 * Code points JSON leaves raw but a terminal or an agent must not see raw: DEL and the C1 controls,
 * the line and paragraph separators with the bidi embedding marks, and the bidi isolates. Written as
 * numbers because a literal separator inside a regex literal ends the line.
 */
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
    [0x7f, 0x9f],
    [0x2028, 0x202e],
    [0x2066, 0x2069],
];

function unsafeCode(code: number): boolean {
    return UNSAFE_RANGES.some(([low, high]) => code >= low && code <= high);
}

/** JSON-quote a path and also escape the code points above, which JSON leaves raw. */
export function quote(value: string): string {
    let quoted = "";
    for (const character of toJson(value)) {
        const code = character.charCodeAt(0);
        quoted += unsafeCode(code) ? `\\u${code.toString(16).padStart(4, "0")}` : character;
    }

    return quoted;
}

function shellArgument(value: string): string {
    return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** A control byte or a bidi mark cannot be pasted safely into a shell line. */
function unsafeForShell(value: string): boolean {
    return [...value].some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || unsafeCode(code);
    });
}

/** Never executed. A path with control characters prints as a JSON argv instead of a shell line. */
function testLine(command: TestCommand): string {
    const where = command.cwd === "." ? "" : ` in ${quote(command.cwd)}`;
    if (command.argv.some(unsafeForShell) || unsafeForShell(command.cwd)) {
        return `Suggested test arguments (not executed${where}): [${command.argv.map(quote).join(", ")}]`;
    }

    return `Suggested test entry point (not executed${where}): ${command.argv.map(shellArgument).join(" ")}`;
}

function projectLine(project: OwnedProject): string {
    const runner =
        project.testRunner === "package-script"
            ? `package script "test"`
            : (project.testRunner ?? "no test runner found");
    return `Project ${quote(project.manifest)}: ${project.ecosystem}, ${project.packageManager}, tests via ${runner}; owns ${project.targets.length} returned file(s).`;
}

/** The packet's file order: priority (else score), then score, then path. */
export function packetOrder(files: readonly FileEvidence[]): FileEvidence[] {
    return [...files].sort(
        (a, b) => (b.priority ?? b.score) - (a.priority ?? a.score) || b.score - a.score || a.path.localeCompare(b.path)
    );
}

/**
 * Order bytes, decide nothing. The file list comes before any source body, so an agent that sees
 * only a prefix still has every path. `End context.` is how a complete packet is recognized.
 */
export function renderResult(result: RetrievalResult, maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES): string {
    let remaining = maxSourceBytes || Number.POSITIVE_INFINITY;
    const files = packetOrder(result.files).map((file) => {
        let omitted = file.sourceOmitted;
        const excerpts = (file.presentationExcerpts ?? file.excerpts).filter(({ source }) => {
            const bytes = Buffer.byteLength(source);
            if (bytes > remaining) {
                omitted = true;
                return false;
            }

            remaining -= bytes;
            return true;
        });
        return { file, excerpts, omitted };
    });
    const context = result.repositoryContext;
    const omittedCount = files.filter(({ omitted }) => omitted).length;
    const lines = [
        `Jev grep: ${files.length} relevant files${result.status !== "complete" ? "; discovery incomplete" : ""}.`,
        "Symbols use name@start-end. Roles are estimates; locations-only files remain reading leads.",
        `Instruction files (root and returned-file ancestors): ${context.instructionFiles.length ? context.instructionFiles.map(quote).join(", ") : "none found"}${context.instructionLookupIncomplete ? "; lookup incomplete" : ""}.`,
        ...context.projects.map(projectLine),
        ...(context.failedGatherers.length
            ? [`Repository context incomplete: ${context.failedGatherers.map(quote).join(", ")}.`]
            : []),
        ...(result.status === "interrupted" ? ["Interrupted."] : []),
        ...(omittedCount ? [`Source omitted: ${omittedCount} file(s).`] : []),
        ...(result.warnings ?? []).map(({ kind, count }) => `Warning: ${quote(kind)}: ${count}`),
        ...result.issues.map(({ kind, count }) => `Issue: ${quote(kind)}: ${count}`),
        ...(result.providerFailure ? [`Provider error: ${quote(result.providerFailure)}`] : []),
        ...context.testCommands.map(testLine),
        ...files.map(
            ({ file, excerpts, omitted }) =>
                `- ${quote(file.path)} — ${file.roles.join(", ") || "relevant; role uncertain"}; ${excerpts.length ? "source below" : omitted ? "source omitted" : "locations only"}`
        ),
        "End file list. Declaration locations follow source.",
    ];
    for (const { file, excerpts } of files) {
        for (const { range, source, partial, sourceByteStart, sourceByteEnd } of excerpts) {
            const byteInterval =
                sourceByteStart === undefined ? "" : `; UTF-8 bytes [${sourceByteStart}, ${sourceByteEnd})`;
            const sliced = partial || sourceByteStart !== undefined;
            const sourceLines = source.split("\n");
            if (sliced && sourceLines.length > range.endLine - range.startLine + 1 && sourceLines.at(-1) === "") {
                sourceLines.pop();
            }

            lines.push(
                "",
                `Source block ${quote(file.path)} lines ${range.startLine}-${range.endLine}${sliced ? ` (partial excerpt${byteInterval})` : ""}:`
            );
            // The fence outgrows any backtick run in the body; the body itself is never escaped.
            let fenceLength = 3;
            for (const match of source.matchAll(/`+/g)) {
                fenceLength = Math.max(fenceLength, match[0].length + 1);
            }

            const fence = "`".repeat(fenceLength);
            lines.push(fence, ...sourceLines, fence);
        }
    }

    lines.push("", "Declaration locations:");
    for (const { file, omitted } of files) {
        lines.push(
            `- ${quote(file.path)}`,
            ...[...file.leads]
                .sort((a, b) => a.range.startLine - b.range.startLine)
                .map((lead) => `  ${lead.name}@${lead.range.startLine}-${lead.range.endLine}`),
            ...(file.callLeads ?? []).map(
                (call) =>
                    `  Possible local call ${call.caller} -> ${call.name}: lines ${call.range.startLine}-${call.range.endLine}${call.unknownEarlierBases.length ? `; earlier base(s) ${call.unknownEarlierBases.map(quote).join(", ")} not inspected` : ""}; runtime dispatch not verified.`
            ),
            ...(omitted ? ["  Some source omitted; locations remain available."] : [])
        );
    }

    return `${lines.join("\n")}\n\n${PACKET_TERMINATOR}\n`;
}
