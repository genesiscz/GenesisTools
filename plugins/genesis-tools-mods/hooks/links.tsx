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
// repository the reply names, and only then the session checkout's.
import type { HookStream, TurnStepChunk, TurnStepInput, TurnStepResult } from "claude-code";
import { COMMIT, checkHubLink, commitLink, type ForgeProject, forgeProject } from "./commit-links";
import { decisionLink, encodePath, finderLink, type GenesisProbe, genesisProbe, mdLink } from "./genesis";
import {
    mentionsIn,
    projectNamed,
    projectOfPath,
    QUALIFIED_PR,
    type RepoMention,
    sameOwner,
    sessionRepos,
} from "./pr-repos";
import { type Host, isRecord, logMod } from "./shared";

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

const pullRequests = new Map<string, { title: string; url: string } | null>();

/** The PR numbers the mod linked since the last note to the model, keyed `<repo>#<n>`. */
const linkedPullRequests = new Map<string, { token: string; repo: string; why: string; url: string }>();

/**
 * Append the pending PR attribution, acknowledging only entries still matching the successful snapshot. A failed
 * append leaves the entries for a later turn, and links recorded during the append are never cleared by it.
 */
export async function appendLinkedPullRequestNote(append: (note: string) => Promise<unknown>): Promise<void> {
    if (linkedPullRequests.size === 0) {
        return;
    }

    const pending = [...linkedPullRequests.entries()];
    const rows = pending.map(([, pr]) => `- ${pr.token} -> ${pr.url}, in ${pr.repo}: ${pr.why}`);

    const note = [
        "The genesis-tools-mods links mod linked these PR numbers:",
        ...rows,
        "It picks a number's repository in this order: one written at the number (owner/repo#123), the same number linked before, the nearest repository your reply names (a GitHub URL, a hub link, a path in a checkout), and last the remote of the session's checkout. If a number belongs to another repository, tell the user in your next reply that the link was added automatically and is wrong, and give the correct link. Write owner/repo#123 to choose the repository yourself; a PR you write as a full markdown link is never changed.",
    ].join("\n");
    await append(note);

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
    const named = [...ctx.named, ...[...ctx.above, ...ctx.line].flatMap((m) => (m.project ? [m.project] : []))];

    return ctx.project ? [...named, ctx.project] : named;
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
 * GitLab project there, or nothing names a GitHub one (`pr-repos.ts`).
 */
async function prRepo(
    ctx: LinkContext,
    n: number,
    at: number
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

    const nearest = [...ctx.line].sort((a, b) => Math.abs(a.start - at) - Math.abs(b.start - at));

    for (const mention of [...nearest, ...earlier]) {
        const project = await mentionProject(ctx, mention);

        if (project) {
            return project.kind === "github" ? { project, why: "the nearest repository the reply names" } : undefined;
        }
    }

    return ctx.project?.kind === "github" ? { project: ctx.project, why: "the session's checkout" } : undefined;
}

/** The repository and number a PR token (`#12`, `web#12`, `acme/web#12`) means, and why. */
async function prTarget(
    ctx: LinkContext,
    token: string,
    at: number
): Promise<{ project: ForgeProject; number: string; why: string } | undefined> {
    const [, owner, name, written] = new RegExp(`^${QUALIFIED_PR.source}$`).exec(token) ?? [];

    if (name && written) {
        const project = owner
            ? { kind: "github" as const, host: githubHost(ctx), path: `${owner}/${name}` }
            : (projectNamed(name, knownProjects(ctx)) ?? sameOwner(name, ctx.project));

        return project ? { project, number: written, why: "written at the number" } : undefined;
    }

    const n = token.slice(1);
    const found = await prRepo(ctx, Number(n), at);

    return found ? { ...found, number: n } : undefined;
}

/** The PR's title and URL from `gh`, kept for the session; null for a number that is no PR of that repository. */
async function pullRequest(
    ctx: LinkContext,
    project: ForgeProject,
    n: string
): Promise<{ title: string; url: string } | null> {
    if (project.kind !== "github") {
        return null;
    }

    const repo = project.host === "github.com" ? project.path : `${project.host}/${project.path}`;
    const key = `${repo}#${n}`;
    const held = pullRequests.get(key);

    if (held !== undefined) {
        return held;
    }

    const run = await ctx.host
        .run(["gh", "pr", "view", n, "--repo", repo, "--json", "title,url"], { timeoutMs: 8_000 })
        .catch(() => undefined);
    let found: { title: string; url: string } | null = null;

    try {
        const parsed: unknown = run?.exitCode === 0 ? JSON.parse(run.stdout) : undefined;

        if (isRecord(parsed) && typeof parsed.title === "string" && typeof parsed.url === "string") {
            found = { title: parsed.title.replace(/^Draft: /, ""), url: parsed.url };
        }
    } catch {
        found = null;
    }

    pullRequests.set(key, found);

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
    const yes = run?.exitCode === 0 && run.stdout.trim() === "commit";
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
            const target = await prTarget(ctx, hit.token, offset + hit.start);
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
    ctx.line = mentionsIn(line, githubHost(ctx));

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
    // The next lines of the reply look up to what this one named.
    ctx.above.push(...ctx.line);

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

    return {
        host,
        home,
        cwd,
        root,
        repo,
        project,
        linked,
        named,
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
