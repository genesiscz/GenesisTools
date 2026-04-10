import { SafeJSON } from "@app/utils/json";
import { truncateText } from "@app/utils/string";
import { createTwoFilesPatch } from "diff";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ToolFormatOptions {
    primaryMaxChars: number;
    secondaryMaxChars?: number;
    detailLevel: "signature" | "summary" | "full";
}

// ─── Constants ─────────────────────────────────────────────────────────────

const PRIMARY_PARAMS: Record<string, string> = {
    Bash: "command",
    Read: "file_path",
    Edit: "file_path",
    Write: "file_path",
    MultiEdit: "file_path",
    Grep: "pattern",
    Glob: "pattern",
    Agent: "description",
    Skill: "skill",
    WebFetch: "url",
    WebSearch: "query",
    NotebookEdit: "notebook_path",
};

const DETAIL_ONLY_PARAMS = new Set([
    "old_string",
    "new_string",
    "content",
    "prompt",
    "replace_all",
    "dangerouslyDisableSandbox",
    "run_in_background",
]);

// ─── Helpers ───────────────────────────────────────────────────────────────

function formatValue(value: unknown, maxChars: number): string {
    if (typeof value === "string") {
        return truncateText(value, maxChars);
    }

    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }

    const json = SafeJSON.stringify(value) ?? "";
    return truncateText(json, maxChars);
}

function isNullish(value: unknown): boolean {
    return value === null || value === undefined || value === false;
}

// ─── Public API ────────────────────────────────────────────────────────────

export function formatToolSignature(name: string, input: Record<string, unknown>, options: ToolFormatOptions): string {
    const { primaryMaxChars, detailLevel } = options;
    const secondaryMaxChars = options.secondaryMaxChars ?? 60;

    const primaryKey = PRIMARY_PARAMS[name];
    const parts: string[] = [];

    if (primaryKey && input[primaryKey] !== undefined) {
        parts.push(formatValue(input[primaryKey], primaryMaxChars));
    }

    for (const [key, value] of Object.entries(input)) {
        if (key === primaryKey) {
            continue;
        }

        if (isNullish(value)) {
            continue;
        }

        if (detailLevel !== "full" && DETAIL_ONLY_PARAMS.has(key)) {
            continue;
        }

        parts.push(`${key}: ${formatValue(value, secondaryMaxChars)}`);
    }

    return `${name}(${parts.join(", ")})`;
}

export function formatToolDiff(name: string, input: Record<string, unknown>, maxChars: number): string[] | null {
    if (name === "Edit" || name === "MultiEdit") {
        const oldStr = input.old_string;
        const newStr = input.new_string;

        if (typeof oldStr !== "string" && typeof newStr !== "string") {
            return null;
        }

        const oldText = typeof oldStr === "string" ? oldStr : "";
        const newText = typeof newStr === "string" ? newStr : "";

        // Compute unified diff with 3 lines of context
        const patch = createTwoFilesPatch("old", "new", oldText, newText, "", "", { context: 3 });

        // Strip the two-line file header (--- old / +++ new)
        const patchLines = patch.split("\n");
        const bodyStart = patchLines.findIndex((l) => l.startsWith("@@"));
        const diffLines = bodyStart >= 0 ? patchLines.slice(bodyStart) : patchLines.slice(2);

        // Truncate if too long
        let totalChars = 0;
        const result: string[] = [];

        for (const line of diffLines) {
            totalChars += line.length;

            if (totalChars > maxChars) {
                result.push(`... (diff truncated at ${maxChars} chars)`);
                break;
            }

            result.push(line);
        }

        // Remove trailing empty line
        if (result.length > 0 && result[result.length - 1] === "") {
            result.pop();
        }

        return result.length > 0 ? result : null;
    }

    if (name === "Write") {
        const content = input.content;

        if (typeof content !== "string") {
            return null;
        }

        return [`+ ${truncateText(content, maxChars)}`];
    }

    return null;
}

export function formatToolResult(content: string, maxChars: number, options?: { isError?: boolean }): string {
    const truncated = truncateText(content, maxChars);

    if (options?.isError) {
        return `ERROR: ${truncated}`;
    }

    return truncated;
}
