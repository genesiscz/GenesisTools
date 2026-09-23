import { extractWorkItemIds } from "@app/azure-devops/utils";

export function resolveWorkItemId(input: string): number {
    const ids = extractWorkItemIds(input);

    if (ids.length !== 1) {
        throw new Error(`Expected one work item id or URL, got '${input}'`);
    }

    return ids[0];
}

export function parseCommentId(value: string): number {
    const id = Number(value);

    if (!Number.isInteger(id) || id < 1) {
        throw new Error(`Invalid comment id '${value}': expected a positive whole number`);
    }

    return id;
}

/** Exactly one source: `--text`, or `--file` where "-" reads stdin. */
export async function resolveCommentBody({
    file,
    text,
    readStdin = () => Bun.stdin.text(),
}: {
    file?: string;
    text?: string;
    readStdin?: () => Promise<string>;
}): Promise<string> {
    let body: string;

    if (text !== undefined && file === undefined) {
        body = text;
    } else if (file !== undefined && text === undefined) {
        body = await readCommentFile({ file, readStdin });
    } else {
        throw new Error("Pass exactly one of --file <path> or --text <text>");
    }

    if (body.trim() === "") {
        throw new Error("The comment is empty");
    }

    return body.trimEnd();
}

async function readCommentFile({
    file,
    readStdin,
}: {
    file: string;
    readStdin: () => Promise<string>;
}): Promise<string> {
    if (file === "-") {
        return readStdin();
    }

    const handle = Bun.file(file);

    if (!(await handle.exists())) {
        throw new Error(`File not found: ${file}`);
    }

    return handle.text();
}

const HTML_ENTITIES: Record<string, string> = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
};

/** First line of the comment, tags and common entities stripped, for a one-row preview. */
export function commentPreview(text: string, width = 80): string {
    const firstLine = text
        .replace(/<[^>]+>/g, " ")
        .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (entity) => HTML_ENTITIES[entity] ?? entity)
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .find((line) => line !== "");
    const preview = firstLine ?? "";

    return preview.length > width ? `${preview.slice(0, width - 1)}…` : preview;
}
