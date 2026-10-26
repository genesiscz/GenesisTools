// The link fixer: the main loop's reply text is rewritten line by line as it streams, so a path, a commit or a
// repeated decision reaches the screen and the transcript as a link (AGENTS.md "Clickable paths"). Code fences,
// existing markdown links and bare URLs are left as they are, and nothing is linked unless it resolves: a path
// that exists, a commit the repository has, a decision asked in an earlier message. Every transform and every
// candidate it rejected goes to `mods-log/links.jsonl` with the reason, to tune the heuristics from real replies.
// A genesis.tools link (a note, a folder, a commit in the hub, a decision) is written only when this Mac opens it
// (`genesis.ts`); else a note gets its plain path and a folder, a commit or a decision stays text.
import type { HookStream, TurnStepChunk, TurnStepInput, TurnStepResult } from "claude-code";
import { decisionLink, encodePath, finderLink, type GenesisProbe, genesisProbe, hubLink, mdLink } from "./genesis";
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
/** A commit: 7 to 12 hex characters with at least one digit and one letter. */
const SHA = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,12}\b/g;
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
    repo: string | undefined;
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
const linkedPullRequests = new Map<string, { token: string; repo: string; title: string; url: string }>();

/**
 * A note for the model about the PR numbers the mod linked in its reply, or undefined when it linked none; taking it
 * clears the list. The mod picks the repository of the session's folder, so a number the reply meant in another
 * repository gets a wrong link and a wrong title, and only the model can see that.
 */
export function takeLinkedPullRequestNote(): string | undefined {
    if (linkedPullRequests.size === 0) {
        return undefined;
    }

    const rows = [...linkedPullRequests.values()].map((pr) => `- ${pr.token} -> ${pr.url} (${pr.title})`);
    const repos = [...new Set([...linkedPullRequests.values()].map((pr) => pr.repo))].join(", ");
    linkedPullRequests.clear();

    return [
        `The genesis-tools-mods links mod changed your last reply: it linked these bare PR numbers to ${repos}, the GitHub repository of the session's folder, and added the title GitHub gives there:`,
        ...rows,
        "The mod cannot see which repository you meant. If a number belongs to another repository, or the title is not the PR you meant, tell the user in your next reply that the link was added automatically and is wrong, and give the correct link. A PR you write as a full markdown link is never changed.",
    ].join("\n");
}

/** The PR's title and URL from `gh`, kept for the session; null for a number that is no PR of this repository. */
async function pullRequest(ctx: LinkContext, n: string): Promise<{ title: string; url: string } | null> {
    if (!ctx.root || !ctx.repo) {
        return null;
    }

    const key = `${ctx.repo}#${n}`;
    const held = pullRequests.get(key);

    if (held !== undefined) {
        return held;
    }

    const run = await ctx.host
        .run(["gh", "pr", "view", n, "--json", "title,url"], { cwd: ctx.root, timeoutMs: 8_000 })
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

/** Links the paths, decisions and commits of one stretch of plain text (no link, URL or code span in it). */
async function linkPlain(ctx: LinkContext, text: string): Promise<string> {
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

    for (const match of text.matchAll(PR)) {
        hits.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, kind: "pr", token: match[0] });
    }

    for (const match of text.matchAll(SHA)) {
        hits.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, kind: "sha", token: match[0] });
    }

    hits.sort((a, b) => a.start - b.start || b.end - a.end);

    for (const hit of hits) {
        if (hit.start < at) {
            continue;
        }

        let replacement: string | undefined;
        let start = hit.start;
        let end = hit.end;

        if (hit.kind === "pr") {
            const pr = await pullRequest(ctx, hit.token.slice(1));

            if (pr) {
                // The rule: a PR's label carries its title, unless the reply already writes it after the number.
                const titled = text.slice(end, end + 2) === " (";
                const title = pr.title.replace(/[\\[\]]/g, "\\$&");
                replacement = `[${titled ? hit.token : `${hit.token} (${title})`}](${pr.url})`;
                linkedPullRequests.set(`${ctx.repo}${hit.token}`, {
                    token: hit.token,
                    repo: ctx.repo ?? "",
                    title: pr.title,
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
            const link = ctx.repo ? hubLink(ctx.probe, { repo: ctx.repo, commit: hit.token }) : undefined;

            if (link && (await isCommit(ctx, hit.token))) {
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

        ctx.log.push({ kind: hit.kind, token: text.slice(start, end), link: replacement });
        out += text.slice(at, start) + replacement;
        at = end;
    }

    return out + text.slice(at);
}

/** One line of reply text with its candidates linked; links, URLs and code spans that do not resolve stay. */
export async function linkLine(ctx: LinkContext, line: string): Promise<string> {
    let out = "";
    let at = 0;

    for (const match of line.matchAll(PROTECTED)) {
        const start = match.index ?? 0;
        out += await linkPlain(ctx, line.slice(at, start));
        at = start + match[0].length;

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

    return out + (await linkPlain(ctx, line.slice(at)));
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
    const repo =
        origin?.exitCode === 0
            ? /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/.exec(origin.stdout)?.[1]
            : undefined;
    const askedBefore = new Set<number>();

    for (const message of (await host.messages()).slice(0, messageCount)) {
        if (message.role !== "assistant") {
            continue;
        }

        for (const match of message.text.matchAll(/(^|[^[])❓\s*\**\s*DECISION\s+(\d+)/gm)) {
            askedBefore.add(Number(match[2]));
        }
    }

    return { host, home, cwd, root, repo, sessionId, askedBefore, probe: await genesisProbe(host), log: [] };
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
