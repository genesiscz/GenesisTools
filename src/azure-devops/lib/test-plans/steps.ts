import { SafeJSON } from "@genesiscz/utils/json";
import { htmlToMarkdown } from "@genesiscz/utils/markdown/html-to-md";
import { Marked } from "marked";

/**
 * The steps of a Test Case work item (`Microsoft.VSTS.TCM.Steps`), its parameters
 * (`Microsoft.VSTS.TCM.Parameters`) and their values (`Microsoft.VSTS.TCM.LocalDataSource`).
 *
 * The Steps field is XML. Each `<step>` holds two `<parameterizedString>` elements, the action and
 * the expected result. With `isformatted="true"` their text is HTML, stored XML-escaped
 * (`&lt;div&gt;&lt;p&gt;…`); older items hold plain text. A `<compref ref="N">` calls the steps of
 * the Shared Steps work item N, and the steps that follow it may sit inside the `<compref>` element.
 */

/** One step of a test case, with its text as markdown. */
export interface TestStepAction {
    kind: "step";
    /** The step id inside the XML; not the 1-based number the web UI shows. */
    id: number;
    action: string;
    expected: string;
}

/** A call to the steps of a Shared Steps work item. */
export interface TestStepShared {
    kind: "shared";
    id: number;
    sharedStepsId: number;
    /** Filled when the Shared Steps work item was read. */
    title?: string;
    steps?: TestStepAction[];
}

export type TestStep = TestStepAction | TestStepShared;

/** A step to write: the text is markdown. */
export type TestStepInput = { action: string; expected?: string } | { sharedStepsId: number };

export interface TestCaseParameters {
    names: string[];
    /** One row per iteration, from a local data source. */
    rows: Record<string, string>[];
    /** Set when the values come from Shared Parameter work items instead of the test case itself. */
    sharedParameterSetIds?: number[];
}

interface XmlToken {
    kind: "open" | "close" | "self" | "text";
    name: string;
    attrs: Record<string, string>;
    text: string;
}

const TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/;

/** Decode the five XML entities and numeric references. `&amp;` goes last, so `&amp;lt;` stays `&lt;`. */
export function decodeXmlEntities(text: string): string {
    return text
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

export function escapeXml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function tokenize(xml: string): XmlToken[] {
    const tokens: XmlToken[] = [];
    let last = 0;

    for (const match of xml.matchAll(TAG)) {
        const index = match.index ?? 0;

        if (index > last) {
            tokens.push({ kind: "text", name: "", attrs: {}, text: xml.slice(last, index) });
        }

        const attrs: Record<string, string> = {};

        for (const attr of (match[3] ?? "").matchAll(ATTR)) {
            attrs[attr[1]] = decodeXmlEntities(attr[2] ?? attr[3] ?? "");
        }

        const kind = match[1] ? "close" : match[4] ? "self" : "open";
        tokens.push({ kind, name: match[2], attrs, text: "" });
        last = index + match[0].length;
    }

    if (last < xml.length) {
        tokens.push({ kind: "text", name: "", attrs: {}, text: xml.slice(last) });
    }

    return tokens;
}

/**
 * The text of one `<parameterizedString>`, as markdown. The XML holds HTML (`isformatted="true"`), so
 * text without tags still carries HTML entities: a stored `&amp;amp;` is a literal `&`.
 */
export function stepTextToMarkdown(raw: string): string {
    const text = decodeXmlEntities(raw);

    if (!HTML_TAG.test(text)) {
        return decodeXmlEntities(text)
            .replace(/&nbsp;/g, " ")
            .replace(/\r\n/g, "\n")
            .trim();
    }

    return htmlToMarkdown(text).replace(/ /g, " ").trim();
}

function toInt(value: string | undefined): number {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

/** Parse the Steps XML. An empty or missing field gives no steps. */
export function parseStepsXml(xml: string | undefined | null): TestStep[] {
    if (!xml?.trim()) {
        return [];
    }

    const steps: TestStep[] = [];
    let current: { id: number; strings: string[]; buffer: string | null } | null = null;

    for (const token of tokenize(xml)) {
        if (token.name === "compref" && (token.kind === "open" || token.kind === "self")) {
            steps.push({ kind: "shared", id: toInt(token.attrs.id), sharedStepsId: toInt(token.attrs.ref) });
            continue;
        }

        if (token.name === "step" && token.kind === "open") {
            current = { id: toInt(token.attrs.id), strings: [], buffer: null };
            continue;
        }

        if (!current) {
            continue;
        }

        if (token.name === "parameterizedString") {
            if (token.kind === "self") {
                current.strings.push("");
            } else if (token.kind === "open") {
                current.buffer = "";
            } else if (token.kind === "close" && current.buffer !== null) {
                current.strings.push(current.buffer);
                current.buffer = null;
            }

            continue;
        }

        if (token.kind === "text" && current.buffer !== null) {
            current.buffer += token.text;
            continue;
        }

        if (token.name === "step" && token.kind === "close") {
            steps.push({
                kind: "step",
                id: current.id,
                action: stepTextToMarkdown(current.strings[0] ?? ""),
                expected: stepTextToMarkdown(current.strings[1] ?? ""),
            });
            current = null;
        }
    }

    return steps;
}

const markdownToHtmlParser = new Marked({ gfm: true, breaks: true });

/** Markdown step text as the HTML the web UI stores; empty text stays empty. */
export function markdownToStepHtml(markdown: string): string {
    const trimmed = markdown.trim();

    if (!trimmed) {
        return "";
    }

    const html = markdownToHtmlParser.parse(trimmed, { async: false });
    return html.trim();
}

/**
 * The Steps XML for a list of steps. Ids count from 2 (as the web UI does), `last` is the highest id,
 * a step with an expected result is a `ValidateStep`, any other an `ActionStep`.
 */
export function buildStepsXml(steps: readonly TestStepInput[]): string {
    let id = 1;
    const body = steps.map((step) => {
        id += 1;

        if ("sharedStepsId" in step) {
            return `<compref id="${id}" ref="${step.sharedStepsId}" />`;
        }

        const expected = step.expected?.trim() ?? "";
        const type = expected ? "ValidateStep" : "ActionStep";
        const action = escapeXml(markdownToStepHtml(step.action));
        const result = escapeXml(markdownToStepHtml(expected));

        return (
            `<step id="${id}" type="${type}">` +
            `<parameterizedString isformatted="true">${action}</parameterizedString>` +
            `<parameterizedString isformatted="true">${result}</parameterizedString>` +
            "<description/></step>"
        );
    });

    return `<steps id="0" last="${id}">${body.join("")}</steps>`;
}

const ITEM = /^(\d+)[.)]\s+(.*)$/;
const EXPECTED = /^(?:>\s*)?(?:[-*]\s+)?expected(?:\s+result)?\s*:\s*(.*)$/i;
const SHARED = /^shared\s+steps\s+#?(\d+)\b/i;

/**
 * Steps written as a numbered markdown list. The lines of an item form its action, until a line
 * `Expected: …` starts the expected result. An item `Shared steps #123` calls a Shared Steps work item.
 *
 * ```md
 * 1. Open the sign-in page
 *    Expected: The form shows a user name field
 * 2. Shared steps #12345
 * ```
 */
export function parseStepsMarkdown(markdown: string): TestStepInput[] {
    const steps: TestStepInput[] = [];
    let action: string[] | null = null;
    let expected: string[] | null = null;

    const flush = (): void => {
        if (!action) {
            return;
        }

        const actionText = action.join("\n").trim();
        const shared = SHARED.exec(action[0].trim());

        if (shared) {
            // The indented lines under a shared steps item are its expansion, printed for reading only.
            steps.push({ sharedStepsId: Number(shared[1]) });
        } else {
            steps.push({ action: actionText, expected: (expected ?? []).join("\n").trim() });
        }

        action = null;
        expected = null;
    };

    for (const raw of markdown.replace(/\r\n/g, "\n").split("\n")) {
        const item = ITEM.exec(raw);

        if (item) {
            flush();
            action = [item[2]];
            continue;
        }

        if (!action) {
            continue;
        }

        if (/^#{1,6}\s/.test(raw)) {
            flush();
            continue;
        }

        const line = raw.replace(/^ {1,4}/, "");
        const expectedLine = EXPECTED.exec(line.trim());

        if (expectedLine && expected === null) {
            expected = [expectedLine[1]];
            continue;
        }

        (expected ?? action).push(line);
    }

    flush();
    return steps;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Steps as JSON: `[{ "action": "…", "expected": "…" }, { "sharedStepsId": 123 }]`, or `{ "steps": [...] }`. */
export function parseStepsJson(text: string): TestStepInput[] {
    const parsed: unknown = SafeJSON.parse(text, { strict: true });
    const list = isRecord(parsed) && Array.isArray(parsed.steps) ? parsed.steps : parsed;

    if (!Array.isArray(list)) {
        throw new Error('Steps JSON must be an array, or an object with a "steps" array');
    }

    return list.map((item, index) => {
        if (!isRecord(item)) {
            throw new Error(`Step ${index + 1} is not an object`);
        }

        if (typeof item.sharedStepsId === "number") {
            return { sharedStepsId: item.sharedStepsId };
        }

        if (typeof item.action !== "string") {
            throw new Error(`Step ${index + 1} needs an "action" string, or a "sharedStepsId" number`);
        }

        return { action: item.action, expected: typeof item.expected === "string" ? item.expected : "" };
    });
}

/** Steps input from a file's text: JSON when it starts with `[` or `{`, a markdown list otherwise. */
export function parseStepsInput(text: string): TestStepInput[] {
    const trimmed = text.trim();

    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        return parseStepsJson(trimmed);
    }

    const steps = parseStepsMarkdown(trimmed);

    if (steps.length === 0 && trimmed) {
        throw new Error('No steps found. Write a numbered list ("1. Action", then "   Expected: Result"), or JSON');
    }

    return steps;
}

function indent(text: string, prefix: string): string {
    return text
        .split("\n")
        .map((line, index) => (index === 0 ? line : `${prefix}${line}`))
        .join("\n");
}

/**
 * Steps as the numbered markdown list that {@link parseStepsMarkdown} reads back. The steps of a
 * Shared Steps item that was read are listed under it, indented, for reading only.
 */
export function renderStepsMarkdown(steps: readonly TestStep[]): string {
    if (steps.length === 0) {
        return "_No steps._";
    }

    const lines: string[] = [];

    steps.forEach((step, index) => {
        const number = `${index + 1}.`;
        const pad = " ".repeat(number.length + 1);

        if (step.kind === "shared") {
            lines.push(`${number} Shared steps #${step.sharedStepsId}${step.title ? ` (${step.title})` : ""}`);

            for (const [subIndex, sub] of (step.steps ?? []).entries()) {
                lines.push(`${pad}${subIndex + 1}) ${indent(sub.action || "_(empty)_", `${pad}   `)}`);

                if (sub.expected) {
                    lines.push(`${pad}   Expected: ${indent(sub.expected, `${pad}   `)}`);
                }
            }

            return;
        }

        lines.push(`${number} ${indent(step.action || "_(empty)_", pad)}`);

        if (step.expected) {
            lines.push(`${pad}Expected: ${indent(step.expected, pad)}`);
        }
    });

    return lines.join("\n");
}

/** Parameter names from `<parameters><param name="X" bind="default"/></parameters>`. */
export function parseParameterNames(xml: string | undefined | null): string[] {
    if (!xml?.trim()) {
        return [];
    }

    return tokenize(xml)
        .filter((token) => token.name === "param" && token.kind !== "close" && token.attrs.name)
        .map((token) => token.attrs.name);
}

/**
 * Parameter values. A local data source is a .NET DataSet XML whose `<Table1>` rows hold one element
 * per parameter. With shared parameters the field is JSON instead and names the Shared Parameter sets.
 */
export function parseTestCaseParameters(
    parametersXml: string | undefined | null,
    dataSource: string | undefined | null
): TestCaseParameters {
    const names = parseParameterNames(parametersXml);
    const source = dataSource?.trim() ?? "";

    if (source.startsWith("{")) {
        const parsed: unknown = SafeJSON.parse(source, { strict: true });
        const ids =
            isRecord(parsed) && Array.isArray(parsed.sharedParameterDataSetIds)
                ? parsed.sharedParameterDataSetIds.filter((id): id is number => typeof id === "number")
                : [];
        return { names, rows: [], sharedParameterSetIds: ids };
    }

    const rows: Record<string, string>[] = [];
    let row: Record<string, string> | null = null;
    let field: string | null = null;
    let inSchema = 0;

    for (const token of tokenize(source)) {
        if (token.name === "xs:schema") {
            inSchema += token.kind === "open" ? 1 : token.kind === "close" ? -1 : 0;
            continue;
        }

        if (inSchema > 0) {
            continue;
        }

        if (/^Table\d+$/.test(token.name)) {
            if (token.kind === "open") {
                row = {};
            } else if (token.kind === "close" && row) {
                rows.push(row);
                row = null;
            }

            continue;
        }

        if (!row) {
            continue;
        }

        if (token.kind === "open") {
            field = token.name;
            row[field] = "";
        } else if (token.kind === "self") {
            row[token.name] = "";
        } else if (token.kind === "text" && field) {
            // A value is pasted into the HTML of a step, so it is stored HTML-escaped inside the XML.
            row[field] += decodeXmlEntities(decodeXmlEntities(token.text));
        } else if (token.kind === "close") {
            field = null;
        }
    }

    return { names, rows };
}
