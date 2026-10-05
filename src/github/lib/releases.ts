/** The fields of a GitHub release this tool reads. An Octokit release is assignable to it. */
export interface RawRelease {
    tag_name: string;
    name: string | null;
    draft: boolean;
    prerelease: boolean;
    created_at: string;
    published_at: string | null;
    html_url: string;
    body?: string | null;
}

export interface ReleaseNote {
    tag: string;
    name: string | null;
    /** ISO timestamp; a release that was never published falls back to its creation time. */
    publishedAt: string;
    prerelease: boolean;
    url: string;
    body: string;
}

export interface RepoRef {
    owner: string;
    repo: string;
}

export const RELEASES_PER_PAGE = 100;

const NAME_PART = /^[\w.-]+$/;

/** `owner/repo`, an https or ssh github.com URL (with or without `.git` or a trailing path). */
export function parseRepoRef(input: string): RepoRef | null {
    const trimmed = input.trim();
    const url = /github\.com[:/]+([^/]+)\/([^/#?]+)/i.exec(trimmed);
    const short = /^([^/]+)\/([^/]+)$/.exec(trimmed);
    const match = url ?? short;

    if (!match) {
        return null;
    }

    const owner = match[1];
    const repo = match[2].replace(/\.git$/, "");

    return NAME_PART.test(owner) && NAME_PART.test(repo) ? { owner, repo } : null;
}

export function toReleaseNote(raw: RawRelease): ReleaseNote {
    return {
        tag: raw.tag_name,
        name: raw.name?.trim() || null,
        publishedAt: raw.published_at ?? raw.created_at,
        prerelease: raw.prerelease,
        url: raw.html_url,
        body: (raw.body ?? "").replace(/\r\n?/g, "\n").trim(),
    };
}

function timeOf(note: ReleaseNote): number {
    return Date.parse(note.publishedAt);
}

export interface CollectReleasesOptions {
    /** One page of the releases listing (1-based), at `RELEASES_PER_PAGE` per page. */
    listPage: (page: number) => Promise<RawRelease[]>;
    /** Keep at most this many, the newest. */
    limit?: number;
    /** Drop releases published before this moment. */
    since?: Date;
    /** False drops pre-releases. */
    prereleases: boolean;
    /** Return the oldest first instead of the newest first. */
    oldestFirst?: boolean;
}

/**
 * Every release that passes the filters, newest first (or oldest first), walking the listing page by
 * page. Drafts are always skipped. With `since`, the walk stops at the first page whose published
 * releases are all older than it. With `limit`, it stops as soon as enough releases are kept. Both stops
 * assume the listing, which GitHub orders by creation time, tracks publication time to within a page: a
 * release published long after its commit date, more than a page away, can be missed.
 */
export async function collectReleases(options: CollectReleasesOptions): Promise<ReleaseNote[]> {
    const { listPage, limit, since, prereleases, oldestFirst } = options;
    const sinceMs = since?.getTime();
    const kept: ReleaseNote[] = [];

    for (let page = 1; ; page++) {
        const raw = await listPage(page);
        let published = 0;
        let inRange = 0;

        for (const release of raw) {
            if (release.draft) {
                continue;
            }

            published++;
            const note = toReleaseNote(release);

            if (sinceMs !== undefined && timeOf(note) < sinceMs) {
                continue;
            }

            inRange++;

            if (prereleases || !note.prerelease) {
                kept.push(note);
            }
        }

        const pastSince = sinceMs !== undefined && published > 0 && inRange === 0;
        const enough = limit !== undefined && kept.length >= limit;

        if (raw.length < RELEASES_PER_PAGE || pastSince || enough) {
            break;
        }
    }

    const newestFirst = kept.sort((a, b) => timeOf(b) - timeOf(a)).slice(0, limit);

    return oldestFirst ? newestFirst.reverse() : newestFirst;
}

/**
 * Push every ATX heading of a release body down so it nests under the release's own `##` heading.
 * Headings inside fenced code blocks are left alone; the level stops at 6.
 */
export function demoteHeadings(body: string, by = 2): string {
    let fence: string | null = null;

    return body
        .split("\n")
        .map((line) => {
            const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];

            if (marker) {
                if (fence === null) {
                    fence = marker;
                } else if (marker[0] === fence[0] && marker.length >= fence.length) {
                    fence = null;
                }

                return line;
            }

            const heading = fence === null ? /^( {0,3})(#{1,6})(?=\s|$)(.*)$/.exec(line) : null;

            if (!heading) {
                return line;
            }

            return `${heading[1]}${"#".repeat(Math.min(6, heading[2].length + by))}${heading[3]}`;
        })
        .join("\n");
}

function isoDay(iso: string): string {
    const time = Date.parse(iso);

    return Number.isNaN(time) ? iso : new Date(time).toISOString().slice(0, 10);
}

function headingOf(note: ReleaseNote): string {
    const title = note.name && note.name !== note.tag ? `${note.tag} - ${note.name}` : note.tag;

    return `${title} (${isoDay(note.publishedAt)})`;
}

export interface RenderReleasesOptions extends RepoRef {
    releases: ReleaseNote[];
    generatedAt: Date;
}

/** One markdown document: a heading per release with tag, name and date, then the body and the release URL. */
export function renderReleasesMarkdown({ owner, repo, releases, generatedAt }: RenderReleasesOptions): string {
    const count = `${releases.length} release${releases.length === 1 ? "" : "s"}`;
    const source = `https://github.com/${owner}/${repo}/releases`;
    const generated = isoDay(generatedAt.toISOString());
    const lines = [
        `# Releases: ${owner}/${repo}`,
        "",
        `${count} from <${source}>. Generated on ${generated} (UTC).`,
        "",
    ];

    if (releases.length === 0) {
        lines.push("No releases found.", "");
    }

    for (const note of releases) {
        lines.push("---", "", `## ${headingOf(note)}`, "");

        if (note.prerelease) {
            lines.push("Pre-release.", "");
        }

        lines.push(
            note.body ? demoteHeadings(note.body) : "_No release notes._",
            "",
            `Release page: <${note.url}>`,
            ""
        );
    }

    return lines.join("\n");
}
