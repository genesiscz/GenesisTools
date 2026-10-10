import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { gatherHarnessPoster } from "@genesiscz/utils/agent/runtime";
import { env } from "@genesiscz/utils/env";
import { parseImageAttachmentInputs } from "@genesiscz/utils/image/attachments";
import { logger } from "@genesiscz/utils/logger";
import { isTestProcess } from "@genesiscz/utils/test-process";
import {
    defaultTransclusionRegistry,
    type TranscludeOptions,
    type TransclusionRegistry,
    type TransclusionToken,
    transclude,
} from "@genesiscz/utils/transclude";
import type { QuestionItemInput } from "./decisions/items";
import type { DecisionSource, StoredTransclusion } from "./decisions/schema";
import type { AskChoice } from "./pending/types";

/** One token of an item, with the field it was written in (`promptMarkdown`, `reasoning`, `choices[1]`). */
export type FieldTransclusion = TransclusionToken & { field: string };

/** Set on an item whose text changed: the fields as written, and every token. */
export interface ItemTransclusion {
    source: { promptMarkdown?: string; reasoning?: string; proposal?: string; choices?: string[] };
    tokens: FieldTransclusion[];
}

export interface TranscludedItems {
    items: QuestionItemInput[];
    /** Every token of the post; `item` is 1-based, as the CLI and the MCP result name it. */
    tokens: Array<FieldTransclusion & { item: number }>;
}

let registry: TransclusionRegistry | null = null;

/** The kinds `tools question` resolves. One registry for the CLI, the MCP server and the help. */
export function questionTokenRegistry(): TransclusionRegistry {
    registry ??= defaultTransclusionRegistry();
    return registry;
}

/** Where `{{image}}` copies pictures, beside the decision log. */
export function questionAssetDir(): string {
    return join(env.tools.getHome(), ".genesis-tools", "question", "assets");
}

const log = logger.child({ component: "question-transclude" });

/**
 * Resolves the inline tokens of every item at save time: promptMarkdown, reasoning, proposal and each
 * choice label. The resolved text replaces the field; the text as written and the token list go on
 * `item.transclusion`, so the store keeps both. A failed token stays visible in the text as a
 * `⚠️ unresolved` marker; it never blocks the post.
 */
export async function transcludeItems({
    items,
    cwd,
    options,
}: {
    items: QuestionItemInput[];
    /** Relative paths resolve here. Defaults to the calling harness's cwd, like the form's projectPath. */
    cwd?: string;
    options?: Partial<Omit<TranscludeOptions, "cwd" | "label">>;
}): Promise<TranscludedItems> {
    // Most posts carry no token; they skip the harness cwd lookup, which runs git.
    if (!items.some((item) => itemTexts(item).some((text) => text.includes("{{")))) {
        return { items, tokens: [] };
    }

    const base = cwd ?? gatherHarnessPoster({}, isTestProcess() ? {} : undefined).cwd ?? process.cwd();
    const tokens: TranscludedItems["tokens"] = [];
    const out: QuestionItemInput[] = [];

    for (const [index, item] of items.entries()) {
        const source: ItemTransclusion["source"] = {};
        const itemTokens: FieldTransclusion[] = [];

        const resolveField = async (field: string, text: string): Promise<string> => {
            const result = await transclude(text, {
                registry: questionTokenRegistry(),
                assetDir: questionAssetDir(),
                logger: log,
                ...options,
                cwd: base,
                label: `item ${index + 1} ${field}`,
            });
            itemTokens.push(...result.tokens.map((token) => ({ ...token, field })));
            return result.text;
        };

        const next: QuestionItemInput = { ...item };

        for (const field of ["promptMarkdown", "reasoning", "proposal"] as const) {
            const text = item[field];

            if (typeof text !== "string") {
                continue;
            }

            const resolved = await resolveField(field, text);

            if (resolved !== text) {
                source[field] = text;
                next[field] = resolved;
            }
        }

        if (item.choices?.length) {
            const labels = item.choices.map((choice) => (typeof choice === "string" ? choice : choice.label));
            const resolved = await Promise.all(
                labels.map((label, choice) => resolveField(`choices[${choice}]`, label))
            );

            if (resolved.some((label, choice) => label !== labels[choice])) {
                source.choices = labels;
                next.choices = item.choices.map((choice, position) => relabel(choice, resolved[position]));
            }
        }

        if (Object.keys(source).length > 0 || itemTokens.length > 0) {
            next.transclusion = { source, tokens: itemTokens };
        }

        tokens.push(...itemTokens.map((token) => ({ ...token, item: index + 1 })));
        out.push(next);
    }

    return { items: out, tokens };
}

/** A `{{…}}` param value: the grammar's quoted form escapes only `"` and `\` (src/utils/transclude/parse.ts). */
function quoteParam(value: string): string {
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Turns each item's `attachments` into images at the end of its `promptMarkdown`, through the same `{{image}}` kind
 * an agent can write inline: the file is copied into the question store by content hash and embedded as
 * `![label](stored path)`. The widget lifts those images into the card's preview strip
 * (src/hub/lib/widget/card-images.ts). Runs even with transclusion off, because attachments are explicit, and
 * throws before anything is stored when a file is missing or is not an image.
 */
export async function embedItemAttachments({
    items,
    cwd,
    options,
}: {
    items: QuestionItemInput[];
    cwd: string;
    options?: Partial<Omit<TranscludeOptions, "cwd" | "label">>;
}): Promise<QuestionItemInput[]> {
    const out: QuestionItemInput[] = [];

    for (const [index, item] of items.entries()) {
        const { attachments, ...rest } = item;

        if (!attachments?.length) {
            out.push(rest);
            continue;
        }

        const inputs = parseImageAttachmentInputs(attachments);
        const missing = inputs.filter((input) => !existsSync(input.path)).map((input) => input.path);

        if (missing.length > 0) {
            throw new Error(`item ${index + 1}: attachment not found: ${missing.join(", ")}`);
        }

        const tokens = inputs
            .map(
                (input) =>
                    `{{image path=${quoteParam(input.path)} alt=${quoteParam(input.label ?? basename(input.path))}}}`
            )
            .join("\n\n");
        const result = await transclude(tokens, {
            registry: questionTokenRegistry(),
            assetDir: questionAssetDir(),
            logger: log,
            ...options,
            cwd,
            label: `item ${index + 1} attachments`,
        });
        const failed = result.tokens.filter((token) => !token.ok);

        if (failed.length > 0) {
            throw new Error(
                `item ${index + 1}: attachments could not be stored: ${failed.map((token) => token.error).join("; ")}`
            );
        }

        out.push({ ...rest, promptMarkdown: `${rest.promptMarkdown.trimEnd()}\n\n${result.text}` });
    }

    return out;
}

/**
 * The one preparation both doors run before a post is stored (MCP question_post and `tools question ask`): item
 * attachments become embedded images, then the inline tokens resolve unless the caller turned that off.
 */
export async function prepareQuestionItems({
    items,
    cwd,
    transclude: resolveTokens,
    options,
}: {
    items: QuestionItemInput[];
    cwd?: string;
    transclude: boolean;
    options?: Partial<Omit<TranscludeOptions, "cwd" | "label">>;
}): Promise<TranscludedItems> {
    const withImages = items.some((item) => item.attachments?.length)
        ? await embedItemAttachments({ items, cwd: cwd ?? process.cwd(), options })
        : items.map(({ attachments: _attachments, ...item }) => item);

    if (!resolveTokens) {
        return { items: withImages, tokens: [] };
    }

    return transcludeItems({ items: withImages, cwd, options });
}

function itemTexts(item: QuestionItemInput): string[] {
    const choices = (item.choices ?? []).map((choice) => (typeof choice === "string" ? choice : choice.label));
    return [item.promptMarkdown, item.reasoning ?? "", item.proposal ?? "", ...choices];
}

/**
 * A string choice's id is its label (`normalizeChoices`), and a resolved label may be a code block, so
 * a changed string choice keeps the label as written as its id.
 */
function relabel(choice: string | AskChoice, label: string): string | AskChoice {
    if (typeof choice !== "string") {
        return { ...choice, label };
    }

    return label === choice ? choice : { id: choice.trim(), label };
}

/** The decision store's names for an item's transclusion: `prompt` and `options`, and the flat token list. */
export function decisionTransclusion(transclusion: ItemTransclusion | undefined): {
    source?: DecisionSource;
    transclusions?: StoredTransclusion[];
} {
    if (!transclusion) {
        return {};
    }

    const { promptMarkdown, reasoning, proposal, choices } = transclusion.source;
    const source: DecisionSource = {
        ...(promptMarkdown !== undefined ? { prompt: promptMarkdown } : {}),
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(proposal !== undefined ? { proposal } : {}),
        ...(choices !== undefined ? { options: choices } : {}),
    };

    return {
        ...(Object.keys(source).length > 0 ? { source } : {}),
        ...(transclusion.tokens.length > 0
            ? { transclusions: transclusion.tokens.map((token) => ({ ...token })) }
            : {}),
    };
}

/**
 * What the CLI prints to stderr and the MCP result carries: one line per failed token with its reason,
 * then `transclude: N resolved, M failed`. Empty when the post had no tokens.
 */
export function transclusionReport(tokens: TranscludedItems["tokens"]): string[] {
    if (tokens.length === 0) {
        return [];
    }

    const failed = tokens.filter((token) => !token.ok);
    const lines = failed.map((token) => `transclude: item ${token.item} ${token.field}: ${token.raw}: ${token.error}`);
    lines.push(`transclude: ${tokens.length - failed.length} resolved, ${failed.length} failed`);
    return lines;
}
