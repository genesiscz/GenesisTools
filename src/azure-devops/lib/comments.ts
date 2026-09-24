import { extractWorkItemIds } from "@app/azure-devops/utils";

/**
 * The organization a URL names: `https://dev.azure.com/<org>/…` and `https://<org>.visualstudio.com/…`
 * both give `<org>`; a server URL gives its host. Lower-cased. Null when `value` is not a URL.
 */
export function adoOrganizationOf(value: string): string | null {
    if (!URL.canParse(value)) {
        return null;
    }

    const url = new URL(value);
    const host = url.hostname.toLowerCase();

    if (host === "dev.azure.com") {
        return decodeURIComponent(url.pathname.split("/")[1] ?? "").toLowerCase() || null;
    }

    if (host.endsWith(".visualstudio.com")) {
        return host.slice(0, -".visualstudio.com".length);
    }

    return host;
}

/**
 * One work item id from a bare id or a work item URL. Ids are numbered per organization, so a URL
 * from another organization than `configuredOrg` is refused: its id would name a different item
 * here, and add/edit/delete would change that one.
 */
export function resolveWorkItemId(input: string, configuredOrg?: string): number {
    const ids = extractWorkItemIds(input);

    if (ids.length !== 1) {
        throw new Error(`Expected one work item id or URL, got '${input}'`);
    }

    const inputOrg = adoOrganizationOf(input.trim());
    const targetOrg = configuredOrg ? adoOrganizationOf(configuredOrg) : null;

    if (inputOrg !== null && targetOrg !== null && inputOrg !== targetOrg) {
        throw new Error(
            `Work item URL is in organization '${inputOrg}', but the configured organization is '${targetOrg}'. Pass the id, or configure that organization.`
        );
    }

    return ids[0];
}

export function parseCommentId(value: string): number {
    const trimmed = value.trim();
    const id = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;

    if (!Number.isSafeInteger(id) || id < 1) {
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

export type CommentDeletion = "deleted" | "declined" | "needs-yes";

/**
 * The guard in front of the one irreversible comment call. Deleting needs consent: `--yes`, or a
 * "yes" at the prompt in a terminal. Without a terminal and without `--yes` nothing is deleted and
 * the caller prints the flag to add. `remove` runs only after consent, so a path that skips the
 * guard never reaches the DELETE.
 */
export async function deleteCommentWithConsent({
    yes,
    interactive,
    confirm,
    remove,
}: {
    yes: boolean;
    interactive: boolean;
    confirm: () => Promise<boolean>;
    remove: () => Promise<void>;
}): Promise<CommentDeletion> {
    if (!yes && !interactive) {
        return "needs-yes";
    }

    if (!yes && !(await confirm())) {
        return "declined";
    }

    await remove();
    return "deleted";
}
