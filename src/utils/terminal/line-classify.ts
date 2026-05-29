export type TerminalLineKind =
    | "plain"
    | "prompt"
    | "success"
    | "warning"
    | "error"
    | "diff-add"
    | "diff-remove"
    | "activity"
    | "muted";

export interface TerminalPreviewLine {
    text: string;
    kind: TerminalLineKind;
}

const ERROR_PATTERN = /\b(error|failed|failure|fatal|exception|ts\d{4})\b|^[\s│]*[×✖]/i;
const WARNING_PATTERN = /\b(warn|warning|blocked|deprecated)\b|^[\s│]*⚠/i;
const SUCCESS_PATTERN = /\b(pass|passed|success|complete|completed|done|ok: true)\b|^[\s│]*✓/i;
const PROMPT_PATTERN = /^\s*(❯|➜|›|\$|>)\s+/;
const ACTIVITY_PATTERN = /^\s*(•|⏺|✻|※|∴|⎿|◯|◼|◻|✢)/;
const MUTED_PATTERN = /^\s*(─{3,}|…|\|?\s*\d+\s+(pass|fail|error)s?\b)/i;

function classifyLine(line: string): TerminalLineKind {
    const trimmed = line.trimStart();

    if (/^\+(?!\+\+)/.test(trimmed)) {
        return "diff-add";
    }

    if (/^-(?!--)/.test(trimmed)) {
        return "diff-remove";
    }

    if (ERROR_PATTERN.test(line)) {
        return "error";
    }

    if (WARNING_PATTERN.test(line)) {
        return "warning";
    }

    if (SUCCESS_PATTERN.test(line)) {
        return "success";
    }

    if (PROMPT_PATTERN.test(line)) {
        return "prompt";
    }

    if (ACTIVITY_PATTERN.test(line)) {
        return "activity";
    }

    if (MUTED_PATTERN.test(line)) {
        return "muted";
    }

    return "plain";
}

export function classifyTerminalPreview(preview: string): TerminalPreviewLine[] {
    return preview.split("\n").map((line) => ({
        text: line,
        kind: classifyLine(line),
    }));
}
