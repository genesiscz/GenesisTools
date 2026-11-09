import { basename, extname } from "node:path";
import { formatBytes } from "@genesiscz/utils/format";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/** An upload cannot be undone: the asset stays on GitHub even when nothing references it. */
export const UPLOAD_ENDPOINT = "https://uploads.github.com/user-attachments/assets";

const MB = 1024 * 1024;
export const IMAGE_LIMIT_BYTES = 10 * MB;
export const VIDEO_LIMIT_BYTES = 100 * MB;
export const FREE_PLAN_VIDEO_LIMIT_BYTES = 10 * MB;

export type MediaKind = "image" | "video" | "other";

const IMAGE_TYPES: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
};

const VIDEO_TYPES: Record<string, string> = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
};

export interface MediaFileType {
    kind: MediaKind;
    contentType: string;
}

/** The kind and MIME type of a file name. A type it does not know is `other`: GitHub decides whether to accept it. */
export function classifyMedia(fileName: string): MediaFileType {
    const ext = extname(fileName).toLowerCase();
    const image = IMAGE_TYPES[ext];
    if (image) {
        return { kind: "image", contentType: image };
    }

    const video = VIDEO_TYPES[ext];
    if (video) {
        return { kind: "video", contentType: video };
    }

    return { kind: "other", contentType: "application/octet-stream" };
}

/** The most GitHub takes for a kind. An unknown kind gets the largest limit, so GitHub rules on the type. */
export function limitFor(kind: MediaKind): number {
    return kind === "image" ? IMAGE_LIMIT_BYTES : VIDEO_LIMIT_BYTES;
}

export interface MediaArg {
    path: string;
    alt?: string;
}

/** `path` or `path#alt text`: the alt text starts at the first `#`, as in gh. */
export function parseMediaArg(arg: string): MediaArg {
    const hash = arg.indexOf("#");
    if (hash <= 0) {
        return { path: arg };
    }

    const alt = arg.slice(hash + 1).trim();
    return alt === "" ? { path: arg.slice(0, hash) } : { path: arg.slice(0, hash), alt };
}

export interface PlannedFile {
    path: string;
    name: string;
    kind: MediaKind;
    contentType: string;
    bytes: number;
    alt: string;
    ok: boolean;
    /** Why the file is refused locally. Only set when `ok` is false. */
    reason?: string;
}

export interface FileAccess {
    /** The size of the file in bytes, or null when it does not exist. */
    size(path: string): Promise<number | null>;
    read(path: string): Promise<Uint8Array<ArrayBuffer>>;
}

export const diskFiles: FileAccess = {
    size: async (path) => {
        const file = Bun.file(path);
        return (await file.exists()) ? file.size : null;
    },
    read: async (path) => new Uint8Array(await Bun.file(path).arrayBuffer()),
};

function stripExtension(name: string): string {
    const ext = extname(name);
    return ext === "" ? name : name.slice(0, -ext.length);
}

/** Types and sizes every file against the limits. Reads no file content and sends nothing. */
export async function planMediaFiles(args: MediaArg[], files: FileAccess = diskFiles): Promise<PlannedFile[]> {
    const planned: PlannedFile[] = [];

    for (const arg of args) {
        const name = basename(arg.path);
        const type = classifyMedia(name);
        const size = await files.size(arg.path);
        const base = {
            path: arg.path,
            name,
            kind: type.kind,
            contentType: type.contentType,
            alt: arg.alt ?? stripExtension(name),
        };

        if (size === null) {
            planned.push({ ...base, bytes: 0, ok: false, reason: `${arg.path} does not exist` });
            continue;
        }

        if (size === 0) {
            planned.push({ ...base, bytes: 0, ok: false, reason: `${name} is empty` });
            continue;
        }

        const limit = limitFor(type.kind);
        if (size > limit) {
            planned.push({
                ...base,
                bytes: size,
                ok: false,
                reason: `${name} is ${formatBytes(size)}, over the ${formatBytes(limit)} GitHub takes for ${
                    type.kind === "image" ? "an image" : type.kind === "video" ? "a video" : "a file"
                }`,
            });
            continue;
        }

        planned.push({ ...base, bytes: size, ok: true });
    }

    return planned;
}

/** An image is `![alt](url)`. A video is the bare URL, because it plays inline only alone in its paragraph. */
export function markdownFor(file: Pick<PlannedFile, "kind" | "alt" | "name">, url: string): string {
    if (file.kind === "video") {
        return url;
    }

    if (file.kind === "image") {
        return `![${file.alt.replace(/[[\]]/g, "")}](${url})`;
    }

    return `[${file.alt.replace(/[[\]]/g, "")}](${url})`;
}

export class MediaUploadError extends Error {
    constructor(
        message: string,
        readonly status?: number
    ) {
        super(message);
        this.name = "MediaUploadError";
    }
}

function responseDetail(text: string): string {
    const trimmed = text.trim();
    if (trimmed === "") {
        return "";
    }

    try {
        const parsed: unknown = SafeJSON.parse(trimmed);
        if (
            typeof parsed === "object" &&
            parsed !== null &&
            "message" in parsed &&
            typeof parsed.message === "string"
        ) {
            return parsed.message;
        }
    } catch (error) {
        logger.debug({ error }, "github media upload: the error body is not JSON");
    }

    return trimmed.slice(0, 300);
}

/** Turns a failed upload answer into the sentence the user reads. */
export function uploadErrorFor(args: {
    status: number;
    body: string;
    retryAfter?: string | null;
    file: Pick<PlannedFile, "name" | "kind" | "bytes">;
    repo: string;
}): MediaUploadError {
    const { status, body, retryAfter, file, repo } = args;
    const detail = responseDetail(body);

    if (status === 404) {
        return new MediaUploadError(
            `GitHub answered 404 for ${file.name}: the token has no write access to ${repo}. Uploads need WRITE, MAINTAIN or ADMIN access.`,
            status
        );
    }

    if (status === 422) {
        const freePlan =
            file.kind === "video" && file.bytes > FREE_PLAN_VIDEO_LIMIT_BYTES
                ? ` A video over ${formatBytes(FREE_PLAN_VIDEO_LIMIT_BYTES)} needs a paid plan.`
                : "";
        const reason = detail === "" ? "." : `: ${detail.replace(/\.$/, "")}.`;
        return new MediaUploadError(`GitHub refused ${file.name}${reason}${freePlan}`, status);
    }

    if (status === 429) {
        const wait = retryAfter ? ` Retry after ${retryAfter} seconds.` : "";
        return new MediaUploadError(`GitHub rate limited the upload of ${file.name}.${wait}`, status);
    }

    if (status === 401 || status === 403) {
        return new MediaUploadError(
            `GitHub answered ${status} for ${file.name}: the token is missing or not allowed to upload.${detail ? ` ${detail}` : ""}`,
            status
        );
    }

    return new MediaUploadError(`GitHub answered ${status} for ${file.name}.${detail ? ` ${detail}` : ""}`, status);
}

export interface UploadOneArgs {
    file: PlannedFile;
    repoId: number;
    repo: string;
    token: string;
    fetch: typeof fetch;
    files: FileAccess;
}

/** The one irreversible call: POST the raw bytes of one file and return the user-attachments URL. */
export async function uploadMediaFile(args: UploadOneArgs): Promise<string> {
    const { file, repoId, repo, token, files } = args;
    const query = new URLSearchParams({
        name: file.name,
        content_type: file.contentType,
        repository_id: String(repoId),
    });
    const url = `${UPLOAD_ENDPOINT}?${query.toString()}`;
    const body = await files.read(file.path);

    logger.debug(
        { name: file.name, bytes: body.byteLength, contentType: file.contentType, repoId },
        "github media upload: posting"
    );

    const response = await args.fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/octet-stream",
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "Content-Length": String(body.byteLength),
        },
        body,
    });
    const text = await response.text();

    if (!response.ok) {
        throw uploadErrorFor({
            status: response.status,
            body: text,
            retryAfter: response.headers.get("retry-after"),
            file,
            repo,
        });
    }

    let parsed: unknown;
    try {
        parsed = SafeJSON.parse(text);
    } catch (error) {
        logger.debug({ error }, "github media upload: the answer is not JSON");
        throw new MediaUploadError(
            `GitHub accepted ${file.name} but the answer was not JSON: ${text.slice(0, 200)}`,
            response.status
        );
    }

    if (typeof parsed === "object" && parsed !== null && "url" in parsed && typeof parsed.url === "string") {
        return parsed.url;
    }

    throw new MediaUploadError(
        `GitHub accepted ${file.name} but the answer has no url: ${text.slice(0, 200)}`,
        response.status
    );
}

/** The two REST reads and one write the command needs. A test hands in a recorder. */
export interface MediaRepoApi {
    getRepo(owner: string, repo: string): Promise<{ id: number; canPush: boolean }>;
    getBody(args: { owner: string; repo: string; number: number }): Promise<string>;
    setBody(args: { owner: string; repo: string; number: number; body: string }): Promise<void>;
}

export interface MediaTarget {
    kind: "pr" | "issue";
    number: number;
}

export interface MediaUploadInput {
    /** `owner/repo`. */
    repo: string;
    files: MediaArg[];
    dryRun?: boolean;
    target?: MediaTarget;
    append?: boolean;
}

export interface MediaUploadDeps {
    api: MediaRepoApi;
    token: () => string;
    fetch?: typeof fetch;
    files?: FileAccess;
}

export interface UploadedFile {
    file: string;
    url: string | null;
    kind: MediaKind;
    bytes: number;
    contentType: string;
    markdown: string | null;
    /** Dry run only: whether this file would be uploaded. */
    verdict?: string;
}

export interface MediaUploadResult {
    repo: string;
    repoId: number | null;
    canPush: boolean | null;
    dryRun: boolean;
    target: MediaTarget | null;
    appended: boolean;
    files: UploadedFile[];
}

export function parseRepoSlug(repo: string): { owner: string; name: string } {
    const [owner, name, ...rest] = repo.split("/");
    if (!owner || !name || rest.length > 0) {
        throw new Error(`--repo must be owner/repo, got "${repo}"`);
    }

    return { owner, name };
}

/**
 * Uploads local images and videos to GitHub's user-attachments storage. Every file is typed and sized first;
 * a refused file stops a real upload before any request. A dry run reads the repo and uploads nothing.
 */
export async function uploadMedia(input: MediaUploadInput, deps: MediaUploadDeps): Promise<MediaUploadResult> {
    const { owner, name } = parseRepoSlug(input.repo);
    const files = deps.files ?? diskFiles;

    if (input.files.length === 0) {
        throw new Error("give at least one file to upload");
    }

    if (input.append && !input.target) {
        throw new Error("--append needs --pr <n> or --issue <n>");
    }

    const planned = await planMediaFiles(input.files, files);
    const refused = planned.filter((file) => !file.ok);

    if (!input.dryRun && refused.length > 0) {
        throw new Error(`Nothing was uploaded. ${refused.map((file) => file.reason).join("; ")}.`);
    }

    const repo = await deps.api.getRepo(owner, name);
    logger.debug({ repo: input.repo, repoId: repo.id, canPush: repo.canPush }, "github media upload: repo read");

    const base = {
        repo: input.repo,
        repoId: repo.id,
        canPush: repo.canPush,
        target: input.target ?? null,
    };

    if (input.dryRun) {
        return {
            ...base,
            dryRun: true,
            appended: false,
            files: planned.map((file) => ({
                file: file.path,
                url: null,
                kind: file.kind,
                bytes: file.bytes,
                contentType: file.contentType,
                markdown: null,
                verdict: file.ok
                    ? repo.canPush
                        ? "would upload"
                        : "refused: no write access"
                    : `refused: ${file.reason}`,
            })),
        };
    }

    if (!repo.canPush) {
        throw new Error(
            `No write access to ${input.repo}. GitHub answers 404 to an upload without WRITE, MAINTAIN or ADMIN access, so nothing was uploaded.`
        );
    }

    const doFetch = deps.fetch ?? fetch;
    const token = deps.token();
    const uploaded: UploadedFile[] = [];

    for (const file of planned) {
        const url = await uploadMediaFile({ file, repoId: repo.id, repo: input.repo, token, fetch: doFetch, files });
        uploaded.push({
            file: file.path,
            url,
            kind: file.kind,
            bytes: file.bytes,
            contentType: file.contentType,
            markdown: markdownFor(file, url),
        });
    }

    let appended = false;
    if (input.append && input.target) {
        const ref = { owner, repo: name, number: input.target.number };
        const current = await deps.api.getBody(ref);
        const lines = uploaded.map((file) => file.markdown).join("\n\n");
        const body = current.trim() === "" ? lines : `${current.replace(/\s+$/, "")}\n\n${lines}`;
        await deps.api.setBody({ ...ref, body });
        appended = true;
    }

    return { ...base, dryRun: false, appended, files: uploaded };
}
