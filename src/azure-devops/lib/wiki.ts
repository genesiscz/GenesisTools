import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Api } from "@app/azure-devops/api";
import type {
    GitCommitRefApi,
    WikiPageApi,
    WikiRecursionLevel,
    WikiSearchResponse,
    WikiV2,
} from "@app/azure-devops/api.types";
import { getLocalConfigDir } from "@app/azure-devops/config";
import type { AzureConfig } from "@app/azure-devops/types";
import { concurrentMap } from "@genesiscz/utils/async";
import { renderUnifiedDiff } from "@genesiscz/utils/diff";
import { logger } from "@genesiscz/utils/logger";
import { slugify } from "@genesiscz/utils/string";

/** What the user named: a page id, a page path, or both via a URL, optionally with the wiki. */
export interface WikiPageRef {
    wiki?: string;
    pageId?: number;
    pagePath?: string;
}

export interface WikiTreeRow {
    id?: number;
    path: string;
    name: string;
    depth: number;
    hasChildren: boolean;
}

export interface WikiAttachmentRef {
    /** The link target exactly as the markdown writes it, so it can be replaced verbatim. */
    original: string;
    name: string;
}

export interface WikiPageChange {
    commitId: string;
    date?: string;
    author?: string;
    message?: string;
}

export interface WikiPageDetails {
    wiki: { id: string; name: string };
    id?: number;
    path: string;
    title: string;
    url?: string;
    gitItemPath?: string;
    lastChange?: WikiPageChange;
    views?: { days: number; count: number };
    subPages: Array<{ id?: number; path: string }>;
    attachments: Array<{ name: string; localPath?: string }>;
    content?: string;
}

export interface WikiPageDiff {
    wiki: string;
    path: string;
    from: WikiPageChange;
    to: WikiPageChange;
    /** Unified diff of the page markdown; empty when the two versions hold the same text. */
    diff: string;
}

export interface WikiSearchRow {
    wiki: string;
    pagePath: string;
    fileName: string;
    highlights: string[];
    url: string;
}

const ATTACHMENT_PATTERN = /\/\.attachments\/[^\s)"'<>\]]+/g;
const HIGHLIGHT_TAG_PATTERN = /<\/?highlighthit>/g;

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch (error) {
        logger.debug(`[wiki] left '${value}' undecoded: ${error}`);
        return value;
    }
}

/**
 * Read a page reference: a wiki URL (`/_wiki/wikis/<wiki>/<id>/<slug>` or `?pagePath=…&pageId=…`),
 * a bare page id, or a page path. A path without a leading slash gets one.
 */
export function parseWikiPageRef(input: string): WikiPageRef {
    const trimmed = input.trim();

    if (/^\d+$/.test(trimmed)) {
        return { pageId: Number(trimmed) };
    }

    if (!/^https?:\/\//i.test(trimmed)) {
        return { pagePath: trimmed.startsWith("/") ? trimmed : `/${trimmed}` };
    }

    const url = new URL(trimmed);
    const segments = url.pathname.split("/").map(safeDecode);
    const wikiIndex = segments.indexOf("_wiki");

    if (wikiIndex === -1) {
        throw new Error(`Not a wiki URL (no /_wiki/ segment): ${input}`);
    }

    const ref: WikiPageRef = {};

    if (segments[wikiIndex + 1] === "wikis" && segments[wikiIndex + 2]) {
        ref.wiki = segments[wikiIndex + 2];
    }

    const idSegment = segments[wikiIndex + 3];

    if (idSegment && /^\d+$/.test(idSegment)) {
        ref.pageId = Number(idSegment);
    }

    const queryId = url.searchParams.get("pageId");

    if (ref.pageId === undefined && queryId && /^\d+$/.test(queryId)) {
        ref.pageId = Number(queryId);
    }

    const pagePath = url.searchParams.get("pagePath");

    if (pagePath) {
        ref.pagePath = pagePath;
    }

    if (ref.pageId === undefined && ref.pagePath === undefined) {
        throw new Error(`The URL names a wiki but no page (no page id, no pagePath): ${input}`);
    }

    return ref;
}

function normalizeWikiName(name: string): string {
    return name
        .toLowerCase()
        .replace(/\.wiki$/, "")
        .replace(/[-\s]+/g, " ")
        .trim();
}

/**
 * Pick the wiki a command works on: the requested one (id, name, or name without `.wiki` and with
 * spaces for dashes), else the project wiki, else the only wiki there is.
 */
export function pickWiki(wikis: WikiV2[], requested?: string): WikiV2 {
    const available = wikis.map((wiki) => wiki.name).join(", ") || "none";

    if (requested) {
        const wanted = normalizeWikiName(requested);
        const match =
            wikis.find((wiki) => wiki.id === requested) ??
            wikis.find((wiki) => wiki.name.toLowerCase() === requested.toLowerCase()) ??
            wikis.find((wiki) => normalizeWikiName(wiki.name) === wanted);

        if (!match) {
            throw new Error(`No wiki named '${requested}'. Available: ${available}`);
        }

        return match;
    }

    const projectWikis = wikis.filter((wiki) => wiki.type === "projectWiki");

    if (projectWikis.length === 1) {
        return projectWikis[0];
    }

    if (wikis.length === 1) {
        return wikis[0];
    }

    throw new Error(`Several wikis and no project wiki; pass --wiki. Available: ${available}`);
}

/**
 * Turn the git path of a page file into the page path the wiki UI shows. The wiki writes a space as
 * `-` and escapes every other special character, a literal `-` included (`%2D`), so the dashes go
 * back to spaces before the percent-decoding.
 */
export function gitPathToPagePath(gitPath: string, mappedPath = "/"): string {
    const root = mappedPath.replace(/\/+$/, "");
    const relative = root && gitPath.startsWith(`${root}/`) ? gitPath.slice(root.length) : gitPath;
    const withoutExtension = relative.replace(/\.md$/i, "");
    const segments = withoutExtension
        .split("/")
        .filter(Boolean)
        .map((segment) => safeDecode(segment.replace(/-/g, " ")));

    return `/${segments.join("/")}`;
}

export function pageTitle(path: string): string {
    const segments = path.split("/").filter(Boolean);

    return segments.at(-1) ?? "/";
}

export function wikiPageWebUrl(config: AzureConfig, wikiName: string, pagePath: string): string {
    const base = config.org.replace(/\/+$/, "");

    return `${base}/${encodeURIComponent(config.project)}/_wiki/wikis/${encodeURIComponent(wikiName)}?pagePath=${encodeURIComponent(pagePath)}`;
}

/** Every `/.attachments/…` file the page links or embeds, once each, in order of appearance. */
export function extractAttachmentRefs(markdown: string): WikiAttachmentRef[] {
    const seen = new Set<string>();
    const refs: WikiAttachmentRef[] = [];

    for (const match of markdown.matchAll(ATTACHMENT_PATTERN)) {
        const original = match[0];

        if (seen.has(original)) {
            continue;
        }

        seen.add(original);
        refs.push({ original, name: safeDecode(original.slice("/.attachments/".length)) });
    }

    return refs;
}

/**
 * One pass over the same pattern that found the links. Replacing each original in turn let a
 * shorter one rewrite the front of a longer one: `/.attachments/shot.png` also hit
 * `/.attachments/shot.png.orig`, which then pointed at a wrong local path.
 */
export function rewriteAttachmentLinks(markdown: string, localPaths: Map<string, string>): string {
    return markdown.replace(ATTACHMENT_PATTERN, (original) => {
        const localPath = localPaths.get(original);

        return localPath === undefined ? original : encodeURI(localPath);
    });
}

/** Map `--depth` onto the API's recursion levels; anything below the first level needs `full`. */
export function recursionLevelForDepth(depth: number | "all"): WikiRecursionLevel {
    if (depth === 0) {
        return "none";
    }

    if (depth === 1) {
        return "oneLevel";
    }

    return "full";
}

/** The page and its descendants as rows, the page itself at depth 0, cut below `maxDepth`. */
export function flattenPageTree(root: WikiPageApi, maxDepth: number | "all"): WikiTreeRow[] {
    const rows: WikiTreeRow[] = [];

    const visit = (page: WikiPageApi, depth: number): void => {
        const children = page.subPages ?? [];
        rows.push({
            id: page.id,
            path: page.path,
            name: page.path === "/" ? "/" : pageTitle(page.path),
            depth,
            hasChildren: children.length > 0 || page.isParentPage === true,
        });

        if (maxDepth !== "all" && depth >= maxDepth) {
            return;
        }

        for (const child of children) {
            visit(child, depth + 1);
        }
    };

    visit(root, 0);

    return rows;
}

/**
 * The Pages API returns an id only for the page that was asked for, never for its subpages, so the
 * ids of a listing cost one lookup per row. Rows that already carry an id are skipped.
 */
export async function fillPageIds({
    api,
    wiki,
    rows,
}: {
    api: Api;
    wiki: WikiV2;
    rows: WikiTreeRow[];
}): Promise<WikiTreeRow[]> {
    const missing = rows.filter((row) => row.id === undefined);
    const ids = await concurrentMap({
        items: missing,
        concurrency: 8,
        fn: async (row) => (await api.getWikiPage({ wikiId: wiki.id, path: row.path, recursionLevel: "none" })).id,
        onError: (row, error) => logger.warn(`[wiki] no id for ${row.path}: ${error}`),
    });

    return rows.map((row) => (row.id === undefined ? { ...row, id: ids.get(row) } : row));
}

export function stripHighlightTags(text: string): string {
    return text.replace(HIGHLIGHT_TAG_PATTERN, "");
}

export function toSearchRows(config: AzureConfig, response: WikiSearchResponse): WikiSearchRow[] {
    return response.results.map((result) => {
        const wikiName = result.wiki?.name ?? "";
        const pagePath = gitPathToPagePath(result.path, result.wiki?.mappedPath);

        return {
            wiki: wikiName,
            pagePath,
            fileName: result.fileName,
            highlights: (result.hits ?? []).flatMap((hit) => hit.highlights),
            url: wikiPageWebUrl(config, wikiName, pagePath),
        };
    });
}

export function toPageChange(commit: GitCommitRefApi): WikiPageChange {
    return {
        commitId: commit.commitId,
        date: commit.author?.date ?? commit.committer?.date,
        author: commit.author?.name ?? commit.committer?.name,
        message: commit.comment?.split("\n")[0],
    };
}

/** The wiki named by the URL or `--wiki`, and the page itself. */
export async function resolveWikiPage({
    api,
    input,
    wikiName,
    recursionLevel = "oneLevel",
    includeContent = false,
}: {
    api: Api;
    input: string;
    wikiName?: string;
    recursionLevel?: WikiRecursionLevel;
    includeContent?: boolean;
}): Promise<{ wiki: WikiV2; page: WikiPageApi }> {
    const ref = parseWikiPageRef(input);
    const wikis = await api.getWikis();
    const wiki = pickWiki(wikis, wikiName ?? ref.wiki);
    logger.debug(`[wiki] ${input} → wiki ${wiki.name}, page ${ref.pageId ?? ref.pagePath}`);

    const page = await api.getWikiPage({
        wikiId: wiki.id,
        pageId: ref.pageId,
        path: ref.pageId === undefined ? ref.pagePath : undefined,
        recursionLevel,
        includeContent,
    });

    return { wiki, page };
}

export function defaultAttachmentDir(wiki: WikiV2, page: WikiPageApi): string {
    return join(getLocalConfigDir(), "wiki", slugify(wiki.name), String(page.id ?? slugify(pageTitle(page.path))));
}

function attachmentGitPath(wiki: WikiV2, name: string): string {
    return `${wiki.mappedPath.replace(/\/+$/, "")}/.attachments/${name}`;
}

function safeFileName(name: string): string {
    return name.replace(/[<>:"/\\|?*]/g, "_");
}

/**
 * One local file name per attachment, decided BEFORE the concurrent downloads start. Flattening
 * alone mapped `a/b.png` and `a_b.png` to one file, both links pointed at it, and whichever write
 * finished last won. A later clash gets `-2`, `-3` before its extension. Compared case-insensitively,
 * because the default macOS volume treats `A.png` and `a.png` as the same file.
 */
export function localAttachmentNames(refs: WikiAttachmentRef[]): Map<string, string> {
    const taken = new Set<string>();
    const names = new Map<string, string>();

    for (const ref of refs) {
        const base = safeFileName(ref.name);
        const dot = base.lastIndexOf(".");
        const stem = dot > 0 ? base.slice(0, dot) : base;
        const extension = dot > 0 ? base.slice(dot) : "";
        let candidate = base;

        for (let suffix = 2; taken.has(candidate.toLowerCase()); suffix += 1) {
            candidate = `${stem}-${suffix}${extension}`;
        }

        taken.add(candidate.toLowerCase());
        names.set(ref.original, candidate);
    }

    return names;
}

/** Download the page's attachments; a file that fails is reported and skipped, the rest still land. */
export async function downloadWikiAttachments({
    api,
    config,
    wiki,
    refs,
    outputDir,
}: {
    api: Api;
    config: AzureConfig;
    wiki: WikiV2;
    refs: WikiAttachmentRef[];
    outputDir: string;
}): Promise<Map<string, string>> {
    const localPaths = new Map<string, string>();

    if (refs.length === 0) {
        return localPaths;
    }

    await mkdir(outputDir, { recursive: true });
    const version = wiki.versions?.[0]?.version;
    const fileNames = localAttachmentNames(refs);

    await concurrentMap({
        items: refs,
        concurrency: 4,
        fn: async (ref) => {
            const url = Api.gitItemDownloadUrl(config, {
                repositoryId: wiki.repositoryId,
                path: attachmentGitPath(wiki, ref.name),
                version,
            });
            const bytes = await api.fetchBinary(url, `wiki attachment ${ref.name}`);
            const localPath = join(outputDir, fileNames.get(ref.original) ?? safeFileName(ref.name));
            await Bun.write(localPath, bytes);
            localPaths.set(ref.original, localPath);
            logger.debug(`[wiki] saved ${ref.name} (${bytes.byteLength} B) to ${localPath}`);
        },
        onError: (ref, error) => logger.warn(`[wiki] could not download ${ref.name}: ${error}`),
    });

    return localPaths;
}

/**
 * Everything `wiki get` reports about one page. The last change and the view count are extra calls;
 * a failure there is logged and leaves the field out instead of failing the whole page.
 */
export async function loadWikiPageDetails({
    api,
    config,
    input,
    wikiName,
    includeContent,
    viewsDays,
    images,
}: {
    api: Api;
    config: AzureConfig;
    input: string;
    wikiName?: string;
    includeContent: boolean;
    viewsDays: number;
    /** Download the attachments and point the content's links at the copies (default dir: `defaultAttachmentDir`). */
    images?: { outputDir?: string };
}): Promise<WikiPageDetails> {
    const { wiki, page } = await resolveWikiPage({ api, input, wikiName, includeContent: true });
    const content = page.content ?? "";
    const refs = extractAttachmentRefs(content);

    const lastChangePromise = page.gitItemPath
        ? api
              .getGitCommitsForPath({
                  repositoryId: wiki.repositoryId,
                  itemPath: page.gitItemPath,
                  version: wiki.versions?.[0]?.version,
                  top: 1,
              })
              .then((commits) => (commits[0] ? toPageChange(commits[0]) : undefined))
              .catch((error) => {
                  logger.warn(`[wiki] last change of ${page.path} unavailable: ${error}`);
                  return undefined;
              })
        : Promise.resolve(undefined);

    const viewsPromise =
        viewsDays > 0 && page.id !== undefined
            ? api
                  .getWikiPageViews({ wikiId: wiki.id, pageId: page.id, days: viewsDays })
                  .then((stats) => ({
                      days: viewsDays,
                      count: (stats.viewStats ?? []).reduce((sum, day) => sum + day.count, 0),
                  }))
                  .catch((error) => {
                      logger.warn(`[wiki] views of ${page.path} unavailable: ${error}`);
                      return undefined;
                  })
            : Promise.resolve(undefined);

    const localPathsPromise = images
        ? downloadWikiAttachments({
              api,
              config,
              wiki,
              refs,
              outputDir: resolve(images.outputDir ?? defaultAttachmentDir(wiki, page)),
          })
        : Promise.resolve(new Map<string, string>());

    const [lastChange, views, localPaths] = await Promise.all([lastChangePromise, viewsPromise, localPathsPromise]);

    return {
        wiki: { id: wiki.id, name: wiki.name },
        id: page.id,
        path: page.path,
        title: pageTitle(page.path),
        url: page.remoteUrl,
        gitItemPath: page.gitItemPath,
        lastChange,
        views,
        subPages: (page.subPages ?? []).map((subPage) => ({ id: subPage.id, path: subPage.path })),
        attachments: refs.map((ref) => ({ name: ref.name, localPath: localPaths.get(ref.original) })),
        content: includeContent ? rewriteAttachmentLinks(content, localPaths) : undefined,
    };
}

/**
 * Match a full or abbreviated commit id against the page's history, newest first. A prefix that
 * matches several commits is refused: taking the first one diffed a version nobody asked for.
 */
export function findCommit(commits: GitCommitRefApi[], ref: string): GitCommitRefApi | undefined {
    const wanted = ref.trim().toLowerCase();
    const matches = commits.filter((commit) => commit.commitId.toLowerCase().startsWith(wanted));

    if (matches.length > 1) {
        throw new Error(
            `Commit prefix '${ref}' is ambiguous: ${matches.map((commit) => commit.commitId.slice(0, 10)).join(", ")}`
        );
    }

    return matches[0];
}

async function readPageAt({
    api,
    config,
    wiki,
    gitItemPath,
    commitId,
}: {
    api: Api;
    config: AzureConfig;
    wiki: WikiV2;
    gitItemPath: string;
    commitId: string;
}): Promise<string> {
    const url = Api.gitItemDownloadUrl(config, {
        repositoryId: wiki.repositoryId,
        path: gitItemPath,
        version: commitId,
        versionType: "commit",
    });
    const bytes = await api.fetchBinary(url, `${gitItemPath} at ${commitId.slice(0, 8)}`);

    return new TextDecoder().decode(bytes);
}

/**
 * Diff two versions of one page. `to` defaults to the newest commit and `from` to the one before
 * `to`, so a bare call answers "what did the last edit change". The history window is the last
 * 100 commits of the page's current git path; a version from before a rename is not reachable.
 */
export async function diffWikiPage({
    api,
    config,
    input,
    wikiName,
    from,
    to,
    context = 3,
}: {
    api: Api;
    config: AzureConfig;
    input: string;
    wikiName?: string;
    from?: string;
    to?: string;
    context?: number;
}): Promise<WikiPageDiff> {
    const { wiki, page } = await resolveWikiPage({ api, input, wikiName, recursionLevel: "none" });

    if (!page.gitItemPath) {
        throw new Error(`Page ${page.path} has no git path, so it has no versions to compare`);
    }

    const commits = await api.getGitCommitsForPath({
        repositoryId: wiki.repositoryId,
        itemPath: page.gitItemPath,
        version: wiki.versions?.[0]?.version,
        top: 100,
    });
    const toCommit = to ? findCommit(commits, to) : commits[0];

    if (!toCommit) {
        throw new Error(`No commit '${to}' in the last ${commits.length} versions of ${page.path}`);
    }

    const fromCommit = from ? findCommit(commits, from) : commits[commits.indexOf(toCommit) + 1];

    if (!fromCommit) {
        throw new Error(
            from
                ? `No commit '${from}' in the last ${commits.length} versions of ${page.path}`
                : `${page.path} has no version older than ${toCommit.commitId.slice(0, 8)}`
        );
    }

    const gitItemPath = page.gitItemPath;
    const [before, after] = await Promise.all([
        readPageAt({ api, config, wiki, gitItemPath, commitId: fromCommit.commitId }),
        readPageAt({ api, config, wiki, gitItemPath, commitId: toCommit.commitId }),
    ]);

    return {
        wiki: wiki.name,
        path: page.path,
        from: toPageChange(fromCommit),
        to: toPageChange(toCommit),
        diff: renderUnifiedDiff({ before, after, label: pageTitle(page.path), context }),
    };
}

function escapeCell(value: string): string {
    return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderWikiPageMarkdown(details: WikiPageDetails): string {
    const rows: Array<[string, string]> = [
        ["Wiki", details.wiki.name],
        ["Page id", details.id === undefined ? "—" : String(details.id)],
        ["Path", `\`${details.path}\``],
    ];

    if (details.url) {
        rows.push(["URL", details.url]);
    }

    if (details.gitItemPath) {
        rows.push(["Git path", `\`${details.gitItemPath}\``]);
    }

    if (details.lastChange) {
        const { date, author, message, commitId } = details.lastChange;
        rows.push([
            "Last change",
            `${date ?? "?"} · ${author ?? "?"} · ${message ?? ""} (\`${commitId.slice(0, 8)}\`)`,
        ]);
    }

    if (details.views) {
        rows.push([`Views (${details.views.days} d)`, String(details.views.count)]);
    }

    rows.push(["Subpages", String(details.subPages.length)]);
    rows.push(["Attachments", String(details.attachments.length)]);

    const lines = [`# ${details.title}`, "", "| Field | Value |", "|---|---|"];

    for (const [field, value] of rows) {
        lines.push(`| ${field} | ${escapeCell(value)} |`);
    }

    if (details.subPages.length > 0) {
        lines.push("", "## Subpages", "");

        for (const subPage of details.subPages) {
            lines.push(`- ${subPage.id === undefined ? "" : `\`${subPage.id}\` `}${subPage.path}`);
        }
    }

    if (details.attachments.length > 0) {
        lines.push("", "## Attachments", "");

        for (const attachment of details.attachments) {
            lines.push(`- ${attachment.name}${attachment.localPath ? ` → ${attachment.localPath}` : ""}`);
        }
    }

    if (details.content !== undefined) {
        lines.push("", "---", "", details.content.trimEnd());
    }

    return `${lines.join("\n")}\n`;
}
