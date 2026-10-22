// `[ask]` on a finished tool row: a press puts the row, quoted, into the prompt where the cursor is, so a question
// about a tool call, its output or the hook text in it needs no copy and no screenshot. The folded group line
// ("ran 3 shell commands") quotes each call's input; a single row also quotes its output, cut to MAX_OUTPUT.
// Each press goes to `mods-log/ask.jsonl`.
import type { ElementTable, RenderElement } from "claude-code";
import { type Host, isRecord, logMod, settingsOf } from "./shared";

const MAX_OUTPUT = 800;
const MAX_INPUT = 300;

function textOf(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map(textOf).join("\n");
    }

    if (isRecord(value)) {
        if (typeof value.text === "string") {
            return value.text;
        }

        if (typeof value.stdout === "string") {
            return [value.stdout, typeof value.stderr === "string" ? value.stderr : ""].filter(Boolean).join("\n");
        }
    }

    return value === undefined ? "" : JSON.stringify(value);
}

/** What a call was asked to do, in one short line: the command, the path, the pattern, else its JSON. */
export function inputLine(tool: string, input: unknown): string {
    const held = isRecord(input) ? input : {};
    const main = [held.command, held.file_path, held.path, held.pattern, held.description, held.prompt].find(
        (value): value is string => typeof value === "string"
    );
    const text = (main ?? JSON.stringify(input ?? {})).replace(/\s+/g, " ").trim();

    return `${tool}: ${text.length > MAX_INPUT ? `${text.slice(0, MAX_INPUT)}…` : text}`;
}

function cut(text: string): string {
    const trimmed = text.trim();

    return trimmed.length > MAX_OUTPUT
        ? `${trimmed.slice(0, MAX_OUTPUT)}\n… (${trimmed.length - MAX_OUTPUT} more characters)`
        : trimmed;
}

/** The quote a press puts into the prompt: each line under `> `, then an empty line for the question. */
export function quoteOf(rows: readonly { tool: string; input: unknown; output?: unknown }[]): string {
    const body = rows
        .map((row) => {
            const output = row.output === undefined ? "" : cut(textOf(row.output));

            return output ? `${inputLine(row.tool, row.input)}\n${output}` : inputLine(row.tool, row.input);
        })
        .join("\n\n");

    return `${body
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`;
}

async function ask(host: Host, id: string, rows: Parameters<typeof quoteOf>[0]): Promise<void> {
    const text = quoteOf(rows);

    await host.fill({ text, mode: "insert" });
    await logMod(host, "ask", { id, tools: rows.map((row) => row.tool), chars: text.length });
}

/** A finished tool row with `[ask]` beside it; the row as drawn while running, or with the mod off. */
export async function askOnRow(
    host: Host,
    ui: ElementTable,
    drawn: RenderElement,
    row: { id: string; isRunning: boolean; calls: { tool: string; input: unknown; output?: unknown }[] }
): Promise<RenderElement> {
    if (row.isRunning || !(await settingsOf(host)).askRow.enabled) {
        return drawn;
    }

    return withButton(ui, drawn, `ask-${row.id}`, () => ask(host, row.id, row.calls));
}

function withButton(ui: ElementTable, drawn: RenderElement, key: string, onPress: () => Promise<void>): RenderElement {
    const { Box, Button } = ui;

    return (
        <Box key={`${key}-row`} flexDirection="row" gap={1} alignItems="flex-end">
            <Box key={`${key}-drawn`} flexGrow={1} flexShrink={1}>
                {drawn}
            </Box>
            <Button key={key} dimColor onPress={() => void onPress()}>
                ask
            </Button>
        </Box>
    );
}
