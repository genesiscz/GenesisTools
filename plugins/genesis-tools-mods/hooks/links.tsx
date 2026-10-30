// The link fixer: the main loop's reply text is rewritten line by line as it streams, so a path, a commit or a
// repeated decision reaches the screen and the transcript as a link (AGENTS.md "Clickable paths"). Code fences,
// existing markdown links and bare URLs are left as they are, and nothing is linked unless it resolves: a path
// that exists, a commit the repository has, a decision asked in an earlier message. Every transform and every
// candidate it rejected goes to `mods-log/links.jsonl` with the reason, to tune the heuristics from real replies.
// A genesis.tools link (a note, a folder, a commit in the hub, a decision) is written only when this Mac opens it
// (`genesis.ts`); else a note gets its plain path and a folder, a commit or a decision stays text. A commit links into
// the PR that holds it when `tools hub link` names one (`commit-links.ts`), in GitHub and GitLab checkouts alike, and a
// hub link the reply built by hand gets its `&amp;` undone and its problems logged as `bad-hub-link`. A PR number links
// in the repository the reply means (`pr-repos.ts`): one written at it, the same number linked before, the nearest
// repository the reply names (a URL, a path, or a known repository's name as a plain word), and only then the session
// checkout's. A session that works in two or more checkouts gets no silent guess: the title the reply wrote after the
// number picks the repository whose PR has it, and with no such evidence the number stays text.
import type { HookStream, TurnStepChunk, TurnStepInput, TurnStepResult } from "claude-code";
import { sessionCheckouts } from "./checkouts";
import { COMMIT, checkHubLink, commitLink, type ForgeProject, forgeProject } from "./commit-links";
import { decisionLink, encodePath, finderLink, type GenesisProbe, genesisProbe, mdLink } from "./genesis";
import {
    mentionsIn,
    namesIn,
    projectNamed,
    projectOfPath,
    QUALIFIED_PR,
    type RepoMention,
    sameOwner,
    sessionRepos,
    titleMatches,
} from "./pr-repos";
import { agentsDir, type Host, isRecord, logMod } from "./shared";
import { cliLacks } from "./shared-run";

const DOC = new Set(["md", "mdx", "json", "jsonl", "yaml", "yml", "toml", "log", "txt", "csv"]);
const CODE = new Set([
    "ts",
    "tsx",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "swift",
    "py",
    "go",
    "rs",
    "rb",
    "php",
    "java",
    "kt",
    "sh",
    "zsh",
    "html",
    "css",
    "scss",
    "sql",
    "proto",
    "c",
    "h",
    "m",
    "mm",
    "cpp",
    "vue",
    "svelte",
]);
const ANY_EXT = new Set([
    ...DOC,
    ...CODE,
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "svg",
    "pdf",
    "zst",
    "plist",
    "xml",
    "lock",
    "env",
]);

/** A path as written: absolute or under the home, relative with a slash, or a bare name with a known extension. */
const PATH =
    /(?:~\/|\/(?:Users|tmp|private|opt|var|Applications|Library|Volumes)\/)[^\s`'"()<>[\]|,;]+|(?:\.{1,2}\/)?(?:[\w@.+-]+\/)+[\w@.+-]*(?::\d+(?:-\d+)?)?|[\w@+-][\w@.+-]*\.[a-zA-Z][a-zA-Z0-9]{0,6}(?::\d+(?:-\d+)?)?/g;
const DECISION = /❓\s*DECISION\s+(\d+)/g;
/** A pull request named by number: `#507`, not inside a word or a URL anchor. */
const PR = /(?<![\w/#&])#(\d{1,6})\b/g;
/** What stays as written: a markdown link, a bare URL, an inline code span (tried as a path on its own). */
const PROTECTED =
    /(\[[^\]\n]*\]\([^)\s]*\))|((?:https?|cursor|genesis-tools|genesis-md|file):\/\/[^\s)]+)|(`[^`\n]+`)/g;

export interface LinkContext {
    host: Host;
    home: string;
    cwd: string;
    root: string | undefined;
    /** The forge project's web path (`owner/repo`, `group/sub/app`): the `repo=` of a commit no PR holds. */
    repo: string | undefined;
    /** The forge of the session's checkout, the last choice for a PR number; `gh` links GitHub PRs only. */
    project: ForgeProject | undefined;
    /** GitHub PR numbers the session's earlier messages linked, with their repository (the latest wins). */
    linked: Map<number, ForgeProject>;
    /** The projects the session's earlier messages named whole. */
    named: ForgeProject[];
    /** The projects of the checkouts the session's tool calls wrote to or changed git state in. */
    worked: ForgeProject[];
    /** The sentence of the current line a position falls in, set by `linkLine`. */
    sentenceAt?: (at: number) => number;
    /** What this reply named in the lines above the current one, in order. */
    above: RepoMention[];
    /** What the current line names. */
    line: RepoMention[];
    sessionId: string;
    askedBefore: Set<number>;
    probe: GenesisProbe;
    log: Record<string, unknown>[];
}

/** Paths the tools of this session named, by file name, so a bare `register.tsx` finds its one absolute path. */
const known = new Map<string, Set<string>>();
const commits = new Map<string, boolean>();

function remember(path: unknown): void {
    if (typeof path !== "string" || !path.startsWith("/")) {
        return;
    }

    const name = path.split("/").filter(Boolean).pop();

    if (!name) {
        return;
    }

    const set = known.get(name) ?? new Set<string>();
    set.add(path.replace(/\/+$/, ""));
    known.set(name, set);
}

function extOf(path: string): string {
    const name = path.split("/").pop() ?? "";
    const dot = name.lastIndexOf(".");

    return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * The link target for an absolute path, by kind (AGENTS.md "Clickable paths"), or undefined for a folder this Mac
 * cannot reveal from a link (a plain folder path opens nothing useful).
 */
export function targetFor(
    probe: GenesisProbe,
    path: string,
    kind: "file" | "dir",
    line?: number,
    end?: number
): string | undefined {
    if (kind === "dir") {
        return finderLink(probe, path);
    }

    const ext = extOf(path);

    if (DOC.has(ext)) {
        const md = mdLink(probe, path, line ? `${line}${end ? `-${end}` : ""}` : undefined);

        if (md) {
            return md;
        }
    }

    if (line) {
        return `cursor://file${encodePath(path)}:${line}`;
    }

    return encodePath(path);
}

async function kindOf(host: Host, path: string): Promise<"file" | "dir" | undefined> {
    const stat = await host.stat(path).catch(() => undefined);

    return stat?.kind === "file" || stat?.kind === "dir" ? stat.kind : undefined;
}

/** Resolves one candidate to an existing absolute path, or says why not. */
async function resolve(
    ctx: LinkContext,
    token: string
): Promise<{ path: string; kind: "file" | "dir"; line?: number; end?: number } | { reason: string }> {
    const lineMatch = /^(.*?):(\d+)(?:-(\d+))?$/.exec(token);
    const raw = (lineMatch ? lineMatch[1] : token) ?? token;
    const line = lineMatch ? Number(lineMatch[2]) : undefined;
    const end = lineMatch?.[3] ? Number(lineMatch[3]) : undefined;
    const bare = !raw.includes("/");

    if (bare && !ANY_EXT.has(extOf(raw))) {
        return { reason: "no known extension" };
    }

    const tries: string[] = [];

    if (raw.startsWith("~/")) {
        tries.push(`${ctx.home}${raw.slice(1)}`);
    } else if (raw.startsWith("/")) {
        tries.push(raw);
    } else if (bare) {
        const found = [...(known.get(raw) ?? [])];

        if (found.length > 1) {
            return { reason: `ambiguous: ${found.length} paths in this session` };
        }

        tries.push(...found, `${ctx.cwd}/${raw}`);
    } else {
        const rel = raw.replace(/^\.\//, "");
        tries.push(`${ctx.cwd}/${rel}`);

        if (ctx.root && ctx.root !== ctx.cwd) {
            tries.push(`${ctx.root}/${rel}`);
        }
    }

    for (const path of tries) {
        const clean = path.replace(/\/+$/, "");
        const kind = await kindOf(ctx.host, clean);

        if (kind) {
            return { path: clean, kind, line, end };
        }
    }

    return { reason: "not on disk" };
}

type PullRequest = { title: string; url: string };

/** How long an answer is shared: a PR's title and URL rarely change; a number that is no PR yet may become one. */
const PR_FOUND_TTL_MS = 6 * 60 * 60_000;
const PR_MISSING_TTL_MS = 10 * 60_000;
const PR_MISSING_TTL_S = String(PR_MISSING_TTL_MS / 1000);

const pullRequests = new Map<string, { at: number; pr: PullRequest | null }>();
let prIncludeMissing = false;

/** Forgets PR answers and CLI capability (tests); shared files stay. */
export function forgetPullRequests(): void {
    pullRequests.clear();
    prIncludeMissing = false;
}

/** The PR numbers the mod linked since the last note to the model, keyed `<repo>#<n>`. */
type LinkedPullRequest = { token: string; repo: string; why: string; url: string };
const linkedPullRequests = new Map<string, LinkedPullRequest>();

function pullRequestNote(pending: readonly LinkedPullRequest[]): string {
    return [
        "The genesis-tools-mods links mod linked these PR numbers in your last message:",
        ...pending.map((pr) => `- ${pr.token} -> ${pr.url}, in ${pr.repo}: ${pr.why}`),
        "It picks a number's repository in this order: one written at the number (owner/repo#123), the same number linked before, the nearest repository your reply names (a GitHub URL, a hub link, a path in a checkout, or a repository's name as a plain word), and last the remote of the session's checkout. In a session that works in several checkouts, a bare number with none of these is linked only when the title you wrote after it matches that repository's PR. If a number belongs to another repository, tell the user in your next reply that the link was added automatically and is wrong, and give the correct link. Write owner/repo#123 to choose the repository yourself; a PR you write as a full markdown link is never changed.",
    ].join("\n");
}

/**
 * The pending PR attribution as context for the main loop's next tool result, so the model reads it in the same turn
 * as the message that holds the links; the entries are taken. Undefined when nothing is pending.
 */
export function takeLinkedPullRequestNote(): string | undefined {
    if (linkedPullRequests.size === 0) {
        return undefined;
    }

    const note = pullRequestNote([...linkedPullRequests.values()]);
    linkedPullRequests.clear();

    return note;
}

/**
 * Append the pending PR attribution, acknowledging only entries still matching the successful snapshot. A failed
 * append leaves the entries for a later turn, and links recorded during the append are never cleared by it. The turn's
 * end uses it for links of a last message, which no tool result follows.
 */
export async function appendLinkedPullRequestNote(append: (note: string) => Promise<unknown>): Promise<void> {
    if (linkedPullRequests.size === 0) {
        return;
    }

    const pending = [...linkedPullRequests.entries()];
    await append(pullRequestNote(pending.map(([, pr]) => pr)));

    for (const [key, pr] of pending) {
        if (linkedPullRequests.get(key) === pr) {
            linkedPullRequests.delete(key);
        }
    }
}

function githubHost(ctx: LinkContext): string {
    return ctx.project?.kind === "github" ? ctx.project.host : "github.com";
}

/** Every project the session and this reply named whole, and the session checkout's. */
function knownProjects(ctx: LinkContext): ForgeProject[] {
    const named = [
        ...ctx.named,
        ...ctx.worked,
        ...[...ctx.above, ...ctx.line].flatMap((m) => (m.project ? [m.project] : [])),
    ];

    return ctx.project ? [...named, ctx.project] : named;
}

/** The GitHub projects the session works in: its checkout's and each one its tool calls changed, once each. */
function workedProjects(ctx: LinkContext): ForgeProject[] {
    const seen = new Map<string, ForgeProject>();

    for (const project of ctx.project ? [ctx.project, ...ctx.worked] : ctx.worked) {
        if (project.kind === "github") {
            seen.set(`${project.host}/${project.path}`.toLowerCase(), project);
        }
    }

    return [...seen.values()];
}

/** The project a mention names: whole, by a name without its owner, or by a path inside a checkout. */
async function mentionProject(ctx: LinkContext, mention: RepoMention): Promise<ForgeProject | undefined> {
    if (mention.project) {
        return mention.project;
    }

    if (mention.name) {
        return projectNamed(mention.name, knownProjects(ctx));
    }

    return mention.path ? projectOfPath(ctx.host, mention.path, ctx.home) : undefined;
}

/**
 * The GitHub repository a bare `#n` at `at` of the current line means, and why; undefined when the reply names a
 * GitLab project there, nothing names a GitHub one, or the session works in several and no evidence picks one
 * (`pr-repos.ts`). `after`: the text right after the number, where a reply writes the PR's title.
 */
function writtenTitle(after: string): string | undefined {
    if (!after.startsWith(" (")) {
        return undefined;
    }

    let depth = 1;
    for (let i = 2; i < after.length && after[i] !== "\n"; i++) {
        if (after[i] === "(") {
            depth++;
        } else if (after[i] === ")") {
            if (depth === 1 && after[i + 1] === ")") {
                continue;
            }
            if (--depth === 0) {
                return after.slice(2, i) || undefined;
            }
        }
    }
    return after.slice(2).split("\n")[0] || undefined;
}

async function prRepo(
    ctx: LinkContext,
    n: number,
    { at, after }: { at: number; after: string }
): Promise<{ project: ForgeProject; why: string } | undefined> {
    const earlier = [...ctx.above].reverse();

    for (const mention of [...ctx.line, ...earlier]) {
        const project = mention.number === n && !mention.path ? await mentionProject(ctx, mention) : undefined;

        if (project?.kind === "github") {
            return { project, why: `the reply links #${n} there` };
        }
    }

    const before = ctx.linked.get(n);

    if (before) {
        return { project: before, why: `the session linked #${n} there before` };
    }

    // The nearest mention of the same sentence first, then the nearest of the rest of the line.
    const sentence = ctx.sentenceAt?.(at);
    const distance = (m: RepoMention) =>
        (ctx.sentenceAt && ctx.sentenceAt(m.start) !== sentence ? 1_000_000 : 0) + Math.abs(m.start - at);
    const nearest = [...ctx.line].sort((a, b) => distance(a) - distance(b));

    for (const mention of [...nearest, ...earlier]) {
        const project = await mentionProject(ctx, mention);

        if (project) {
            return project.kind === "github" ? { project, why: "the nearest repository the reply names" } : undefined;
        }
    }

    const candidates = workedProjects(ctx);

    if (candidates.length < 2) {
        return ctx.project?.kind === "github" ? { project: ctx.project, why: "the session's checkout" } : undefined;
    }

    // Several checkouts and no word of the reply picks one: the PR lookup is the evidence.
    const written = writtenTitle(after);
    const looked = await Promise.all(
        candidates.map(async (project) => ({ project, pr: await pullRequest(ctx, project, String(n)) }))
    );
    const found = looked.flatMap(({ project, pr }) => (pr ? [{ project, pr }] : []));

    const titled = written ? found.filter((hit) => titleMatches(written, hit.pr.title)) : [];

    if (titled.length === 1 && titled[0]) {
        return { project: titled[0].project, why: "its title there matches the title the reply wrote" };
    }

    ctx.log.push({
        kind: "pr-unsure",
        token: `#${n}`,
        candidates: candidates.map((project) => project.path),
        withPr: found.map((hit) => hit.project.path),
        titleWritten: Boolean(written),
    });

    return undefined;
}

/** The repository and number a PR token (`#12`, `web#12`, `acme/web#12`) means, and why. */
async function prTarget(
    ctx: LinkContext,
    token: string,
    { at, after }: { at: number; after: string }
): Promise<{ project: ForgeProject; number: string; why: string } | undefined> {
    const [, owner, name, written] = new RegExp(`^${QUALIFIED_PR.source}$`).exec(token) ?? [];

    if (name && written) {
        const project = owner
            ? { kind: "github" as const, host: githubHost(ctx), path: `${owner}/${name}` }
            : (projectNamed(name, knownProjects(ctx)) ?? sameOwner(name, ctx.project));

        return project ? { project, number: written, why: "written at the number" } : undefined;
    }

    const n = token.slice(1);
    const found = await prRepo(ctx, Number(n), { at, after });

    return found ? { ...found, number: n } : undefined;
}

function freshPullRequest(held: unknown, key: string): { at: number; pr: PullRequest | null } | undefined {
    if (!isRecord(held) || held.key !== key || typeof held.at !== "number") {
        return undefined;
    }

    const pr =
        isRecord(held.pr) && typeof held.pr.title === "string" && typeof held.pr.url === "string"
            ? { title: held.pr.title, url: held.pr.url }
            : held.pr === null
              ? null
              : undefined;

    if (pr === undefined || Date.now() - held.at >= (pr ? PR_FOUND_TTL_MS : PR_MISSING_TTL_MS)) {
        return undefined;
    }

    return { at: held.at, pr };
}

/**
 * The PR's title and URL from `tools github pr` or `gh`; null for a number that is no PR of that repository. Every
 * session on this Mac shares the answer through `<agents>/mods-state/pull-requests/<host_owner_repo_n>.json`: a PR for 6 hours, a number
 * with no PR for 10 minutes. A failed `gh` (network, auth, timeout) is neither kept nor shared.
 */
async function pullRequest(ctx: LinkContext, project: ForgeProject, n: string): Promise<PullRequest | null> {
    if (project.kind !== "github") {
        return null;
    }

    const repo = project.host === "github.com" ? project.path : `${project.host}/${project.path}`;
    const key = `${project.host}/${project.path}#${n}`;
    const inMemory = freshPullRequest(pullRequests.has(key) ? { key, ...pullRequests.get(key) } : undefined, key);

    if (inMemory) {
        return inMemory.pr;
    }

    const dir = await agentsDir(ctx.host);
    const file = dir ? `${dir}/mods-state/pull-requests/${key.replace(/[^\w.-]+/g, "_")}.json` : undefined;
    const text = file ? await ctx.host.read(file).catch(() => undefined) : undefined;
    let shared: { at: number; pr: PullRequest | null } | undefined;

    try {
        shared = freshPullRequest(text ? JSON.parse(text) : undefined, key);
    } catch {
        // A file another session is writing: ask gh.
    }

    if (shared) {
        pullRequests.set(key, shared);
        return shared.pr;
    }

    // With the GenesisTools CLI, `tools github pr --include` answers from the cache every tool on this Mac shares
    // (asked for at most the miss TTL, since this file already keeps a found PR longer); without it, gh.
    let useTools = ctx.probe.tools && !prIncludeMissing;
    const gh = ["gh", "pr", "view", n, "--repo", repo, "--json", "title,url"];
    const argv = useTools
        ? ["tools", "github", "pr", n, "--repo", repo, "--include", "title,url", "--max-cache-age", PR_MISSING_TTL_S]
        : gh;
    let run = await ctx.host.run(argv, { timeoutMs: 15_000 }).catch(() => undefined);

    if (useTools && cliLacks(run)) {
        prIncludeMissing = true;
        useTools = false;
        run = await ctx.host.run(gh, { timeoutMs: 15_000 }).catch(() => undefined);
    }

    // A run that timed out, could not start, or failed for another reason than "no such PR" (network, auth) is
    // asked again on the next reply instead of keeping the number unlinked for the whole session.
    if (
        !run ||
        (run.exitCode !== 0 &&
            (useTools || !/no pull requests? found|could not resolve to a pull ?request/i.test(run.stderr)))
    ) {
        return null;
    }

    let found: PullRequest | null = null;

    try {
        const answer: unknown = run.exitCode === 0 ? JSON.parse(run.stdout) : undefined;
        // `tools github pr --include` prints `{ pr }`, with `pr: null` for a number that is no PR.
        const parsed: unknown = useTools && isRecord(answer) ? answer.pr : answer;

        if (isRecord(parsed) && typeof parsed.title === "string" && typeof parsed.url === "string") {
            found = { title: parsed.title.replace(/^Draft: /, ""), url: parsed.url };
        }
    } catch {
        return null;
    }

    const at = Date.now();
    pullRequests.set(key, { at, pr: found });

    if (file) {
        await ctx.host.write(file, JSON.stringify({ key, at, pr: found })).catch(() => undefined);
    }

    return found;
}

async function isCommit(ctx: LinkContext, sha: string): Promise<boolean> {
    if (!ctx.root) {
        return false;
    }

    const key = `${ctx.root}|${sha}`;
    const held = commits.get(key);

    if (held !== undefined) {
        return held;
    }

    const run = await ctx.host
        .run(["git", "-C", ctx.root, "cat-file", "-t", sha], { timeoutMs: 3_000 })
        .catch(() => undefined);

    // A timed-out lookup (a busy machine) is no answer: keep it out of the cache.
    if (!run) {
        return false;
    }

    const yes = run.exitCode === 0 && run.stdout.trim() === "commit";
    commits.set(key, yes);

    return yes;
}

/**
 * Links the paths, decisions, PR numbers and commits of one stretch of plain text (no link, URL or code span in it).
 * `offset`: where the stretch starts in its line, which the repository mentions of `ctx.line` count from.
 */
async function linkPlain(ctx: LinkContext, text: string, offset: number): Promise<string> {
    let out = "";
    let at = 0;
    const hits: { start: number; end: number; kind: "path" | "sha" | "decision" | "pr"; token: string }[] = [];

    for (const match of text.matchAll(DECISION)) {
        hits.push({
            start: match.index ?? 0,
            end: (match.index ?? 0) + match[0].length,
            kind: "decision",
            token: match[0],
        });
    }

    for (const match of text.matchAll(PATH)) {
        hits.push({
            start: match.index ?? 0,
            end: (match.index ?? 0) + match[0].length,
            kind: "path",
            token: match[0],
        });
    }

    for (const match of [...text.matchAll(PR), ...text.matchAll(QUALIFIED_PR)]) {
        hits.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, kind: "pr", token: match[0] });
    }

    for (const match of text.matchAll(COMMIT)) {
        hits.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, kind: "sha", token: match[0] });
    }

    hits.sort((a, b) => a.start - b.start || b.end - a.end);

    for (const hit of hits) {
        if (hit.start < at) {
            continue;
        }

        let replacement: string | undefined;
        let because: Record<string, string> = {};
        let start = hit.start;
        let end = hit.end;

        if (hit.kind === "pr") {
            const target = await prTarget(ctx, hit.token, { at: offset + hit.start, after: text.slice(end) });
            const pr = target ? await pullRequest(ctx, target.project, target.number) : null;

            if (target && pr) {
                // The rule: a PR's label carries its title, unless the reply already writes it after the number.
                const titled = text.slice(end, end + 2) === " (";
                const title = pr.title.replace(/[\\[\]]/g, "\\$&");
                replacement = `[${titled ? hit.token : `${hit.token} (${title})`}](${pr.url})`;
                because = { repo: target.project.path, why: target.why };

                // A repository `gh` confirmed (`web#12` guessed as acme/web) is known from now on, for later numbers.
                if (!knownProjects(ctx).some((project) => project.path === target.project.path)) {
                    ctx.named.push(target.project);
                }

                linkedPullRequests.set(`${target.project.path}#${target.number}`, {
                    token: hit.token,
                    repo: target.project.path,
                    why: target.why,
                    url: pr.url,
                });
            }
        } else if (hit.kind === "decision") {
            const n = Number(/\d+/.exec(hit.token)?.[0]);

            const link = ctx.askedBefore.has(n) ? decisionLink(ctx.probe, ctx.sessionId, n) : undefined;

            if (link) {
                replacement = `[${hit.token}](${link})`;
            }
        } else if (hit.kind === "sha") {
            const ends = hit.token.split("..");
            const root = ctx.root;
            const known = root ? (await Promise.all(ends.map((end) => isCommit(ctx, end)))).every(Boolean) : false;
            const link =
                root && known
                    ? await commitLink({
                          host: ctx.host,
                          probe: ctx.probe,
                          root,
                          project: ctx.project,
                          spec: hit.token,
                      })
                    : undefined;

            if (link) {
                const bold = text.slice(start - 2, start) === "**" && text.slice(end, end + 2) === "**";
                start = bold ? start - 2 : start;
                end = bold ? end + 2 : end;
                const label = bold ? `**${hit.token}**` : hit.token;
                replacement = `[${label}](${link})`;
            }
        } else {
            const token = hit.token.replace(/[.,:;!?]+$/, "");
            end = hit.start + token.length;
            const found = await resolve(ctx, token);

            const target =
                "path" in found ? targetFor(ctx.probe, found.path, found.kind, found.line, found.end) : undefined;

            if (target) {
                replacement = `[${token}](${target})`;
            } else if ("path" in found) {
                ctx.log.push({ kind: "miss", token, reason: "this Mac opens no link to it" });
            } else if (token.includes("/") || ANY_EXT.has(extOf(token.replace(/:\d+(-\d+)?$/, "")))) {
                ctx.log.push({ kind: "miss", token, reason: found.reason });
            }
        }

        if (replacement === undefined) {
            continue;
        }

        ctx.log.push({ kind: hit.kind, token: text.slice(start, end), link: replacement, ...because });
        out += text.slice(at, start) + replacement;
        at = end;
    }

    return out + text.slice(at);
}

/** One line of reply text with its candidates linked; links, URLs and code spans that do not resolve stay. */
export async function linkLine(ctx: LinkContext, line: string): Promise<string> {
    let out = "";
    let at = 0;
    const known = knownProjects({ ...ctx, line: [] });
    ctx.line = [...mentionsIn(line, githubHost(ctx)), ...namesIn(line, known)].sort((a, b) => a.start - b.start);
    const ends = [...line.matchAll(/[.!?;](?=\s|$)/g)].map((match) => match.index ?? 0);
    ctx.sentenceAt = (at) => ends.filter((end) => end < at).length;

    for (const match of line.matchAll(PROTECTED)) {
        const start = match.index ?? 0;
        out += await linkPlain(ctx, line.slice(at, start), at);
        at = start + match[0].length;

        const written = match[1] ?? match[2];
        const url = match[1] ? /\]\(([^)\s]*)\)$/.exec(match[1])?.[1] : match[2];
        const checked = written && url ? checkHubLink(url) : undefined;

        if (written && url && checked && checked.problems.length > 0) {
            const fixed = written.replace(url, checked.url);
            ctx.log.push({ kind: "bad-hub-link", token: written, problems: checked.problems, link: fixed });
            out += fixed;
            continue;
        }

        const code = match[3];

        if (code) {
            const inner = code.slice(1, -1).trim();
            const found = /\s/.test(inner) ? { reason: "code with spaces" } : await resolve(ctx, inner);

            const target =
                "path" in found ? targetFor(ctx.probe, found.path, found.kind, found.line, found.end) : undefined;

            if (target) {
                const link = `[${inner}](${target})`;
                ctx.log.push({ kind: "code-path", token: code, link });
                out += link;
                continue;
            }
        }

        out += match[0];
    }

    out += await linkPlain(ctx, line.slice(at), at);
    // The next lines of the reply look up to what this one named; a plain repository name speaks for its line alone.
    ctx.above.push(...ctx.line.filter((mention) => !mention.byName));

    return out;
}

/** `messageCount`: the messages the request carried; later ones are this reply itself, which asks nothing earlier. */
async function contextOf(host: Host, messageCount: number): Promise<LinkContext> {
    const home = (await host.env("HOME")) ?? "";
    const cwd = await host.cwd();
    const sessionId = await host.sessionId();
    const top = await host
        .run(["git", "-C", cwd, "rev-parse", "--show-toplevel"], { timeoutMs: 3_000 })
        .catch(() => undefined);
    const root = top?.exitCode === 0 ? top.stdout.trim() : undefined;
    const origin = root
        ? await host
              .run(["git", "-C", root, "remote", "get-url", "origin"], { timeoutMs: 3_000 })
              .catch(() => undefined)
        : undefined;
    const project = origin?.exitCode === 0 ? forgeProject(origin.stdout) : undefined;
    const repo = project?.path;
    const askedBefore = new Set<number>();
    const messages = (await host.messages()).slice(0, messageCount);

    for (const message of messages) {
        if (message.role !== "assistant") {
            continue;
        }

        for (const match of message.text.matchAll(/(^|[^[])❓\s*\**\s*DECISION\s+(\d+)/gm)) {
            askedBefore.add(Number(match[2]));
        }
    }

    const { linked, named } = sessionRepos(
        messages.map((message) => message.text),
        project?.kind === "github" ? project.host : "github.com"
    );
    // The checkouts the git band already keeps for this session; each root's origin is read once per module load.
    const touches = await sessionCheckouts(host).catch(() => []);
    const worked: ForgeProject[] = [];

    for (const touch of touches.slice(0, 8)) {
        const touched = await projectOfPath(host, touch.root, home);

        if (touched) {
            worked.push(touched);
        }
    }

    return {
        host,
        home,
        cwd,
        root,
        repo,
        project,
        linked,
        named,
        worked,
        above: [],
        line: [],
        sessionId,
        askedBefore,
        probe: await genesisProbe(host),
        log: [],
    };
}

/** Notes the absolute paths a tool call names, so a bare file name in a later reply finds its one path. */
export function rememberToolPaths(input: unknown): void {
    if (isRecord(input)) {
        remember(input.file_path);
        remember(input.notebook_path);
        remember(input.path);

        if (typeof input.command === "string") {
            for (const match of input.command.matchAll(/(?:^|[\s'"=])(\/(?:Users|tmp|private)\/[^\s'"|;&)]+)/g)) {
                remember(match[1]);
            }
        }
    }
}

/** The turn.step stage of the main loop: reply text passes line by line, each line linked (see `linkLine`). */
export async function* linksStep(
    host: Host,
    e: TurnStepInput,
    stream: HookStream<TurnStepChunk, TurnStepResult | undefined>
): AsyncGenerator<TurnStepChunk, TurnStepResult | undefined> {
    {
        let ctx: LinkContext | undefined;
        const lines = new Map<number, string>();
        const fenced = new Set<number>();
        let answer = "";
        let changed = false;

        async function* emit(index: number, line: string): AsyncGenerator<TurnStepChunk> {
            if (/^\s*```/.test(line)) {
                if (fenced.has(index)) {
                    fenced.delete(index);
                } else {
                    fenced.add(index);
                }

                answer += line;
                yield { kind: "text", index, text: line };
                return;
            }

            if (fenced.has(index) || !line.trim()) {
                answer += line;
                yield { kind: "text", index, text: line };
                return;
            }

            ctx ??= await contextOf(host, e.messageCount);
            const linked = await linkLine(ctx, line);
            changed ||= linked !== line;
            answer += linked;
            yield { kind: "text", index, text: linked };
        }

        async function* flush(): AsyncGenerator<TurnStepChunk> {
            for (const [index, rest] of lines) {
                if (rest) {
                    yield* emit(index, rest);
                }
            }

            lines.clear();
        }

        for await (const chunk of stream) {
            if (chunk.kind !== "text") {
                yield* flush();
                yield chunk;
                continue;
            }

            let held = (lines.get(chunk.index) ?? "") + chunk.text;
            let newline = held.indexOf("\n");

            while (newline !== -1) {
                yield* emit(chunk.index, held.slice(0, newline + 1));
                held = held.slice(newline + 1);
                newline = held.indexOf("\n");
            }

            lines.set(chunk.index, held);
        }

        yield* flush();

        if (ctx && ctx.log.length > 0) {
            await logMod(host, "links", { session: ctx.sessionId, turn: e.turnId, step: e.index, items: ctx.log });
        }

        // The recorded answer carries the links too, so a hook above and the transcript read what was shown.
        const result: TurnStepResult | undefined = await stream.result;

        return result && changed ? { ...result, answer } : result;
    }
}
