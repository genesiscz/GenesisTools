#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import * as p from "@clack/prompts";
import { isInteractive, runTool, suggestEnumFlag } from "@genesiscz/utils/cli";
import { PR_LIST_STATES, type PrListState } from "@genesiscz/utils/git/origins";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { genesisAppBundlePath } from "@genesiscz/utils/macos/genesis-app";
import { Command } from "commander";
import { registerCheckLogCommand } from "./commands/checks";
import { registerConfigCommands } from "./commands/config";
import { registerNotifyCommands } from "./commands/notify";
import { fixThreads, realFixThreadsDeps } from "./lib/fix-threads";
import { HUB_MODES, HUB_TABS, openHub } from "./lib/open";
import {
    backendFor,
    type DraftAddInput,
    type FoundPr,
    findBranchPr,
    forgetThreads,
    HubPrError,
    type PrBackend,
    type PublishEvent,
    prThreads,
    resolvePr,
    THREAD_SIDES,
    type ThreadSide,
} from "./lib/pr";
import { fetchPrHead, PR_FETCH_PROVIDERS, PrFetchError } from "./lib/pr-fetch";
import { isHubPrRef } from "./lib/pr-ref";
import { prSessions } from "./lib/pr-sessions";
import {
    hubStatus,
    listProposals,
    ProposalError,
    parseProposal,
    proposalKey,
    proposalMarkdown,
    saveProposal,
} from "./lib/proposal";
import { hubPr, hubPrs, PrRefError, parsePrRef } from "./lib/prs";
import { repoFactsMany } from "./lib/repo";
import {
    buildTimeline,
    parseSince,
    parseUntil,
    resolveRange,
    TIMELINE_AUTHORS,
    TIMELINE_DEFAULT_RANGE,
    TIMELINE_KINDS,
    TIMELINE_LIMITS,
    TIMELINE_RANGE_PRESETS,
    type TimelineKind,
} from "./lib/timeline";
import { TIMELINE_DETAIL_KINDS, type TimelineDetailKind, timelineDetail } from "./lib/timeline-detail";
import { registerWorktreesCommand } from "./lib/worktrees-command";

function isPrListState(value: unknown): value is PrListState {
    return typeof value === "string" && (PR_LIST_STATES as readonly string[]).includes(value);
}

function isTimelineDetailKind(value: string): value is TimelineDetailKind {
    return (TIMELINE_DETAIL_KINDS as readonly string[]).includes(value);
}

function isTimelineKind(value: string): value is TimelineKind {
    return (TIMELINE_KINDS as readonly string[]).includes(value);
}

const program = new Command()
    .name("hub")
    .description(
        "The GenesisTools.app agent hub: `tools hub` opens it (building the app when needed); the subcommands are its data doors"
    );

/**
 * An optional enumerated flag: undefined when absent, the value when valid, a picker in a TTY when
 * given bare or invalid, else null after printing the possible values.
 */
async function enumFlag<T extends string>(
    flag: string,
    values: readonly T[],
    given: string | true | undefined
): Promise<T | undefined | null> {
    if (given === undefined) {
        return undefined;
    }

    const match = values.find((value) => value === given);
    if (match) {
        return match;
    }

    if (isInteractive()) {
        const picked = await p.select<string>({
            message: flag,
            options: values.map((value): { value: string; label: string } => ({ value, label: value })),
        });
        return p.isCancel(picked) ? null : (values.find((value) => value === picked) ?? null);
    }

    out.log.error(suggestEnumFlag("tools hub", flag, values, { given: typeof given === "string" ? given : undefined }));
    return null;
}

program
    .command("open", { isDefault: true })
    .description("Open the hub window (the default); a hub that already runs comes forward and takes the flags")
    .option("--mode [mode]", `${HUB_MODES.join("|")} (default sessions)`)
    .option("--session <id>", "select this session (id or id prefix)")
    .option("--pr <ref>", "select this PR/MR in the PRs mode: 42, or with its project: group/app#42")
    .option("--tab [tab]", `${HUB_TABS.join("|")}: the pane to show`)
    .option("--filter <text>", "filter the session list (also searches every project's history)")
    .option("--palette [text]", "open the command palette (⌘K), optionally with this text: 'gt pr 424'")
    .option("--find [text]", "open find in files (⌘⇧F), optionally with this query")
    .option("--no-activate", "open behind the window in front, without taking focus")
    .option("--no-build", "never build; fail when GenesisTools.app is missing or stale")
    .action(
        async (opts: {
            mode?: string | true;
            session?: string;
            pr?: string;
            tab?: string | true;
            filter?: string;
            palette?: string | true;
            find?: string | true;
            activate: boolean;
            build: boolean;
        }) => {
            const mode = await enumFlag("--mode", HUB_MODES, opts.mode);
            const tab = await enumFlag("--tab", HUB_TABS, opts.tab);
            if (mode === null || tab === null) {
                process.exitCode = 1;
                return;
            }

            const pr = opts.pr?.trim();
            if (pr !== undefined && !isHubPrRef(pr)) {
                out.log.error(`--pr takes 42, #42 or <project>#42, got ${opts.pr}`);
                process.exitCode = 1;
                return;
            }

            try {
                const opened = await openHub({
                    mode,
                    tab,
                    pr,
                    session: opts.session,
                    filter: opts.filter,
                    palette: opts.palette === true ? "" : opts.palette,
                    find: opts.find === true ? "" : opts.find,
                    activate: opts.activate,
                    build: opts.build,
                    onStep: (message) => out.log.step(message),
                });
                out.log.success(`Hub opened${opened.built ? " (app rebuilt first)" : ""}`);
            } catch (error) {
                out.log.error(String(error instanceof Error ? error.message : error));
                process.exitCode = 1;
            }
        }
    );

const proposal = program
    .command("proposal")
    .description("Agent-written review proposals: verdict, draft comments, meta");

async function readInput(file: string): Promise<string> {
    return file === "-" ? await Bun.stdin.text() : await Bun.file(file).text();
}

function openInApp(path: string): void {
    const binary = join(genesisAppBundlePath(), "Contents", "MacOS", "GenesisTools");
    const child = spawn(binary, ["--review", "--proposal", path], { detached: true, stdio: "ignore" });
    child.unref();
}

proposal
    .command("push")
    .description("Validate and store a proposal (JSON file or - for stdin); keeps decisions already made in the window")
    .argument("<file>", "proposal JSON, or - for stdin")
    .option("--open", "open it in the review window")
    .option("--json", "print the stored key and path as JSON")
    .action(async (file: string, opts: { open?: boolean; json?: boolean }) => {
        try {
            const parsed = parseProposal(SafeJSON.parse(await readInput(file)));
            const saved = await saveProposal(parsed);

            if (opts.open) {
                const status = hubStatus();

                if (status.available) {
                    openInApp(saved.path);
                } else {
                    out.log.warn(`Not opened: ${status.reason}`);
                }
            }

            if (opts.json) {
                out.result(saved);
                return;
            }

            out.println(`Stored ${saved.key} (${parsed.drafts.length} drafts, ${saved.kept} kept from the window)`);
            out.println(saved.path);
        } catch (error) {
            out.log.error(error instanceof ProposalError ? `Invalid proposal: ${error.message}` : String(error));
            process.exitCode = 1;
        }
    });

proposal
    .command("list")
    .description("Stored proposals, newest first")
    .option("--json", "machine-readable output")
    .action((opts: { json?: boolean }) => {
        const all = listProposals();

        if (opts.json) {
            out.result(all.map((item) => ({ key: proposalKey(item), ...item })));
            return;
        }

        for (const item of all) {
            const open = item.drafts.filter((draft) => draft.status === "proposed").length;
            out.println(
                `${proposalKey(item)}  ${item.verdict.decision}  ${open}/${item.drafts.length} drafts open  ${item.title ?? ""}`
            );
        }
    });

proposal
    .command("show")
    .description("Print one proposal as markdown (json2md) or JSON")
    .argument("<key>", "key from `proposal list`")
    .option("--json", "the stored JSON")
    .action((key: string, opts: { json?: boolean }) => {
        const found = listProposals().find((item) => proposalKey(item) === key);

        if (!found) {
            out.log.error(`No proposal ${key}. See tools hub proposal list.`);
            process.exitCode = 1;
            return;
        }

        if (opts.json) {
            out.result(found);
            return;
        }

        out.print(proposalMarkdown(found));
    });

program
    .command("status")
    .description("Exit 0 when GenesisTools.app with the review window is installed, 1 otherwise (the hard gate)")
    .option("--json", "machine-readable output")
    .action((opts: { json?: boolean }) => {
        const status = hubStatus();

        if (opts.json) {
            out.result(status);
        } else {
            out.println(status.available ? `available: ${status.bundlePath}` : `not available: ${status.reason}`);
        }

        process.exitCode = status.available ? 0 : 1;
    });

program
    .command("repo")
    .description("Checkout, branch, origin web pages and (with --pr) the PR/MR of each folder, as JSON")
    .argument("<paths...>", "folders inside git checkouts")
    .option("--pr", "also look up the PR/MR whose head is the branch (gh / glab; slower)")
    .option("--fresh", "ignore the PR lookup cache (tools hub config)")
    .action(async (paths: string[], opts: { pr?: boolean; fresh?: boolean }) => {
        out.result(await repoFactsMany({ paths, withPr: Boolean(opts.pr), fresh: Boolean(opts.fresh) }));
    });

const timeline = program
    .command("timeline")
    .description(
        "Activity across projects: sessions, commits, pushes, PR events, review comments, decisions and CI results, one page at a time"
    )
    .option("--range [preset]", `${TIMELINE_RANGE_PRESETS.join("|")} (default ${TIMELINE_DEFAULT_RANGE})`)
    .option("--since <time>", "HH:MM today, an ISO date (local midnight) or an ISO time; overrides --range")
    .option("--until <time>", "the same grammar; a bare date means the end of that day (default: now)")
    .option("--before <iso>", "an older page: events at or before this time (the previous page's nextBefore)")
    .option(
        "--limit <n>",
        `events per page (default ${TIMELINE_LIMITS.pageDefault}, at most ${TIMELINE_LIMITS.pageMax})`
    )
    .option("--author [who]", `${TIMELINE_AUTHORS.join("|")}: whose events (default all)`)
    .option("--needs-me", "only what waits for me: open decisions, failed CI on my PRs, unanswered threads on my PRs")
    .option("--kinds <list>", `only these kinds, comma-separated: ${TIMELINE_KINDS.join(",")}`)
    .option("--no-prs", "skip the PR list (the one network call)")
    .option("--fresh", "ignore the page cache")
    .option("--json", "machine-readable output")
    .action(
        async (opts: {
            range?: string | true;
            since?: string;
            until?: string;
            before?: string;
            limit?: string;
            author?: string | true;
            needsMe?: boolean;
            kinds?: string;
            prs?: boolean;
            fresh?: boolean;
            json?: boolean;
        }) => {
            const preset = await enumFlag("--range", TIMELINE_RANGE_PRESETS, opts.range);
            const author = await enumFlag("--author", TIMELINE_AUTHORS, opts.author);

            if (preset === null || author === null) {
                process.exitCode = 1;
                return;
            }

            const kinds = opts.kinds === undefined ? undefined : opts.kinds.split(",").map((kind) => kind.trim());
            const badKind = kinds?.find((kind) => !isTimelineKind(kind));

            if (badKind !== undefined) {
                out.log.error(
                    suggestEnumFlag("tools hub", "--kinds", TIMELINE_KINDS, {
                        subcommand: ["timeline"],
                        given: badKind,
                    })
                );
                process.exitCode = 1;
                return;
            }

            const range = resolveRange(preset ?? TIMELINE_DEFAULT_RANGE);
            const since = opts.since === undefined ? range.since : parseSince(opts.since);
            const until = opts.until === undefined ? range.until : parseUntil(opts.until);

            if (!since || !until) {
                out.log.error(
                    `--since and --until take HH:MM, an ISO date or an ISO time, not "${since ? opts.until : opts.since}"`
                );
                process.exitCode = 1;
                return;
            }

            const before = opts.before === undefined ? null : new Date(opts.before);

            if (before && Number.isNaN(before.getTime())) {
                out.log.error(`--before takes an ISO time, not "${opts.before}"`);
                process.exitCode = 1;
                return;
            }

            const limit = opts.limit === undefined ? TIMELINE_LIMITS.pageDefault : Number(opts.limit);

            if (!Number.isInteger(limit) || limit < 1) {
                out.log.error(`--limit takes a positive whole number, not "${opts.limit}"`);
                process.exitCode = 1;
                return;
            }

            const result = await buildTimeline({
                since,
                until,
                before,
                limit,
                filters: {
                    author: author ?? "all",
                    needsMe: Boolean(opts.needsMe),
                    kinds: kinds?.filter(isTimelineKind),
                },
                prs: opts.prs !== false,
                fresh: Boolean(opts.fresh),
            });

            if (opts.json) {
                out.result(result);
                return;
            }

            for (const event of [...result.events].reverse()) {
                const time = new Date(event.at).toTimeString().slice(0, 5);
                const day = event.at.slice(0, 10);
                out.println(
                    `${day} ${time}  ${event.kind.padEnd(13)} ${(event.project ?? "").padEnd(18)} ${event.title}`
                );
            }

            const more = result.hasMore ? ` · older: --before ${result.nextBefore}` : "";
            out.println(
                `${result.events.length} events · ${result.repos.length} repos · ${result.elapsedMs} ms${result.cached ? " (cached)" : ""}${more}`
            );
        }
    );

timeline
    .command("detail")
    .description(
        "What one Activity row folds open to: a session's prompts and files, a commit's files, a push's commits, a PR's checks, a whole review thread"
    )
    .requiredOption("--kind <kind>", TIMELINE_DETAIL_KINDS.join("|"))
    .requiredOption("--id <id>", "the row's id (commit:<sha>, turn:<session>, thread:<comment>, …) or the bare key")
    .option("--repo <path>", "the repository (commit, push)")
    .option("--pr <url>", "the PR/MR URL (pr, ci, thread)")
    .option("--session <id>", "the session when the id does not carry it")
    .option("--from <sha>", "a push's old tip")
    .option("--since <time>", "the period a session or PR row stands for (default: midnight)")
    .option("--until <time>", "the period's end (default: now)")
    .option("--file <path>", "a commit's one file whose diff is wanted")
    .option("--fresh", "ignore the detail cache")
    .option("--json", "machine-readable output")
    .action(
        async (opts: {
            kind: string;
            id: string;
            repo?: string;
            pr?: string;
            session?: string;
            from?: string;
            since?: string;
            until?: string;
            file?: string;
            fresh?: boolean;
            json?: boolean;
        }) => {
            if (!isTimelineDetailKind(opts.kind)) {
                out.log.error(
                    suggestEnumFlag("tools hub", "--kind", TIMELINE_DETAIL_KINDS, {
                        subcommand: ["timeline", "detail"],
                        given: opts.kind,
                    })
                );
                process.exitCode = 1;
                return;
            }

            // `timeline` declares --since, --until, --fresh and --json too, and commander hands a
            // flag both commands know to the PARENT, so the subcommand reads both stores.
            const parent = timeline.opts<{ since?: string; until?: string; fresh?: boolean; json?: boolean }>();
            const sinceText = opts.since ?? parent.since;
            const untilText = opts.until ?? parent.until;
            const fresh = Boolean(opts.fresh ?? parent.fresh);
            const json = Boolean(opts.json ?? parent.json);
            const since = sinceText === undefined ? undefined : parseSince(sinceText);
            const until = untilText === undefined ? undefined : parseUntil(untilText);

            if (since === null || until === null) {
                out.log.error("--since and --until take HH:MM, an ISO date or an ISO time");
                process.exitCode = 1;
                return;
            }

            try {
                const detail = await timelineDetail({
                    request: {
                        kind: opts.kind,
                        id: opts.id,
                        repo: opts.repo ? resolve(opts.repo) : undefined,
                        pr: opts.pr,
                        session: opts.session,
                        from: opts.from,
                        since,
                        until,
                        file: opts.file,
                        fresh,
                    },
                });

                if (json) {
                    out.result(detail);
                    return;
                }

                out.println(SafeJSON.stringify(detail, null, 2));
            } catch (error) {
                if (json) {
                    out.result({
                        error: error instanceof Error ? error.message : String(error),
                        kind: opts.kind,
                        id: opts.id,
                    });
                } else {
                    out.log.error(error instanceof Error ? error.message : String(error));
                }

                process.exitCode = 1;
            }
        }
    );

// `tools hub pr …`: read-only views of many projects (list, show), and the review verbs on the PR/MR of
// one checkout's branch (find, threads, reply, draft, resolve, publish) that the review window calls.
const pr = program.command("pr").description("GitHub PRs and GitLab MRs of the projects the hub shows");

pr.command("list")
    .description("Open (or merged/all) PRs/MRs of every project among the folders, as JSON; read-only")
    .argument("<paths...>", "folders inside git checkouts; worktrees and clones of one origin count once")
    .option("--state [state]", `${PR_LIST_STATES.join("|")} (default open)`)
    .option("--mine", "only PRs/MRs authored by the logged-in gh/glab user")
    .option("--limit <n>", "at most this many per project", "30")
    .action(async (paths: string[], opts: { state?: string | true; mine?: boolean; limit: string }) => {
        let state = opts.state === undefined ? "open" : opts.state;

        if (!isPrListState(state) && isInteractive()) {
            const picked = await p.select({
                message: "Which PRs/MRs",
                options: PR_LIST_STATES.map((value) => ({ value, label: value })),
            });

            if (p.isCancel(picked)) {
                process.exitCode = 1;
                return;
            }

            state = picked;
        }

        if (!isPrListState(state)) {
            out.log.error(
                suggestEnumFlag("tools hub", "--state", PR_LIST_STATES, {
                    subcommand: ["pr", "list"],
                    given: typeof state === "string" ? state : undefined,
                })
            );
            process.exitCode = 1;
            return;
        }

        const limit = Number(opts.limit);

        if (!Number.isInteger(limit) || limit < 1) {
            out.log.error(`--limit must be a positive integer, got "${opts.limit}"`);
            process.exitCode = 1;
            return;
        }

        out.result(await hubPrs({ paths, state, mine: Boolean(opts.mine), limit }));
    });

pr.command("show")
    .description("One PR/MR with body, commits, checks and merge state, as JSON; read-only")
    .argument("<ref>", "PR/MR URL, or <repoPath>#<number> (the path form also finds the local worktree)")
    .action(async (ref: string) => {
        try {
            out.result(await hubPr({ ref }));
        } catch (error) {
            if (!(error instanceof PrRefError)) {
                throw error;
            }

            out.log.error(error.message);
            out.result({ ref, error: error.message });
            process.exitCode = 1;
        }
    });

pr.command("fetch")
    .description(
        "Put a PR/MR head into refs/genesis/pr/<n>/ of a checkout without a checkout (the hub's diff); changes no branch, tag or working tree"
    )
    .argument("<ref>", "<repoPath>#<number>: the checkout whose origin holds the PR/MR")
    .option("--head <sha>", "the head the PR list names: when it is already local, nothing is fetched")
    .option("--base <sha>", "the PR's recorded base commit")
    .option("--base-branch <name>", "the PR's target branch, fetched when --base is not local")
    .option("--provider [provider]", `${PR_FETCH_PROVIDERS.join("|")} (default: from the remote's URL)`)
    .option("--remote <name>", "the remote that holds the PR's project", "origin")
    .option("--json", "machine-readable output")
    .action(
        async (
            ref: string,
            opts: {
                head?: string;
                base?: string;
                baseBranch?: string;
                provider?: string | true;
                remote: string;
                json?: boolean;
            }
        ) => {
            const provider = await enumFlag("--provider", PR_FETCH_PROVIDERS, opts.provider);

            if (provider === null) {
                process.exitCode = 1;
                return;
            }

            await prVerb({
                json: opts.json,
                run: async () => {
                    const parsed = parsePrRef(ref);

                    if (!parsed || "url" in parsed) {
                        throw new PrFetchError("not-a-repo", `fetch takes <repoPath>#<number>, got "${ref}"`);
                    }

                    return fetchPrHead({
                        repo: resolve(parsed.path),
                        number: parsed.number,
                        head: opts.head,
                        base: opts.base,
                        baseBranch: opts.baseBranch,
                        provider,
                        remote: opts.remote,
                    });
                },
                human: (result) =>
                    [
                        `${result.headRef} = ${result.head.slice(0, 10)} (${result.fetched ? `fetched from ${result.remote} ${result.sourceRef}` : "already here, no fetch"}, ${result.elapsedMs} ms)`,
                        `base ${result.base?.slice(0, 10) ?? "none"}, merge base ${result.mergeBase?.slice(0, 10) ?? "none"}`,
                        ...result.warnings.map((warning) => `warning: ${warning}`),
                    ].join("\n"),
            });
        }
    );

pr.command("sessions")
    .description(
        "Agent sessions that touched a PR/MR: its head checkout, its head branch, its commits, its files; read-only, cached 60 s"
    )
    .requiredOption("--repo <path>", "a checkout of the repository")
    .requiredOption("--branch <name>", "the PR's head branch")
    .option("--base <ref>", "the PR's base commit or ref (with --head: the PR's files and commits)")
    .option("--head <sha>", "the PR's head commit")
    .option("--commits <shas>", "comma-separated PR commits (default: git log base..head)")
    .option("--since <iso>", "the PR's first activity; scans start a day before it (default: 90 days ago)")
    .option("--no-cache", "recompute instead of reading the 60 s cache")
    .option("--json", "machine-readable output")
    .action(
        async (opts: {
            repo: string;
            branch: string;
            base?: string;
            head?: string;
            commits?: string;
            since?: string;
            cache: boolean;
            json?: boolean;
        }) => {
            const since = opts.since ? new Date(opts.since) : null;

            if (since && Number.isNaN(since.getTime())) {
                out.log.error(`--since is not a date: ${opts.since}`);
                process.exitCode = 1;
                return;
            }

            await prVerb({
                json: opts.json,
                run: () =>
                    prSessions({
                        input: {
                            repoRoot: opts.repo,
                            headBranch: opts.branch,
                            base: opts.base ?? null,
                            head: opts.head ?? null,
                            commits: opts.commits?.split(",").filter(Boolean),
                            since,
                        },
                        fresh: !opts.cache,
                    }),
                human: (result) =>
                    [
                        ...result.sessions.map(
                            (s) =>
                                `${s.provider.padEnd(6)} ${s.sessionId.slice(0, 8)} ${s.reasons.join(",").padEnd(22)} ${s.title ?? s.cwd}`
                        ),
                        `${result.sessions.length} sessions (${result.elapsedMs} ms${result.cached ? ", cached" : ""})`,
                    ].join("\n"),
            });
        }
    );

/**
 * Runs one review verb: the result as JSON with --json (the window always passes it), else one human line.
 * A failure prints `{ error, code }` with --json and exits 1; `code` is a HubPrErrorCode or `provider`.
 */
async function prVerb<T>({
    json,
    run,
    human,
}: {
    json?: boolean;
    run: () => Promise<T>;
    human: (result: T) => string;
}): Promise<void> {
    try {
        const result = await run();

        if (json) {
            out.result(result);
            return;
        }

        out.println(human(result));
    } catch (error) {
        const code = error instanceof HubPrError || error instanceof PrFetchError ? error.code : "provider";
        const message = error instanceof Error ? error.message : String(error);
        out.log.error(message);

        if (json) {
            out.result({ error: message, code });
        }

        process.exitCode = 1;
    }
}

/** The branch's PR/MR and its backend, then one write; the thread cache is dropped after it. */
async function prWrite<T>(
    target: { repo: string; pr?: string },
    write: (backend: PrBackend, found: FoundPr) => Promise<T>
): Promise<T> {
    const found = await resolvePr(target);
    const result = await write(await backendFor(found), found);
    await forgetThreads({ pr: found });
    return result;
}

async function readBody(file: string | undefined): Promise<string> {
    if (!file) {
        throw new HubPrError("bad-input", "--body-file <file> is required (- reads stdin)");
    }

    const body = await readInput(file);

    if (!body.trim()) {
        throw new HubPrError("bad-input", `the body in ${file} is empty`);
    }

    return body;
}

function lineNumber(value: string | undefined, flag: string): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    const line = Number(value);

    if (!Number.isInteger(line) || line < 1) {
        throw new HubPrError("bad-input", `${flag} takes a positive line number, got "${value}"`);
    }

    return line;
}

const REPO_HELP = "the checkout whose branch names the PR/MR (default: the current directory)";
const PR_HELP = "this PR/MR instead of the branch's: its URL, or <repoPath>#<number> (a detached review worktree)";

pr.command("find")
    .description("The PR/MR whose source branch is the checked-out branch, or provider null with a reason; read-only")
    .option("--repo <path>", REPO_HELP, ".")
    .option("--json", "machine-readable output")
    .action(async (opts: { repo: string; json?: boolean }) => {
        await prVerb({
            json: opts.json,
            run: () => findBranchPr({ repo: opts.repo }),
            human: (found) =>
                found.provider === null
                    ? `No PR/MR: ${found.reason}`
                    : `${found.provider} ${found.project}#${found.number} ${found.state} ${found.title}\n${found.url}`,
        });
    });

pr.command("threads")
    .description("Review threads with side/line positions, authors, reactions and my drafts; read-only, cached 30 s")
    .option("--repo <path>", REPO_HELP, ".")
    .option("--pr <ref>", PR_HELP)
    .option("--no-cache", "ask the host even when a 30 s old answer is cached")
    .option("--json", "machine-readable output")
    .action(async (opts: { repo: string; pr?: string; cache: boolean; json?: boolean }) => {
        await prVerb({
            json: opts.json,
            run: async () => {
                const found = await resolvePr({ repo: opts.repo, pr: opts.pr });
                return prThreads({ pr: found, backend: await backendFor(found), noCache: !opts.cache });
            },
            human: (result) =>
                [
                    `${result.pr.project}#${result.pr.number}: ${result.threads.length} threads, ${result.draftCount} drafts${result.cached ? " (cached)" : ""}`,
                    ...result.threads.map(
                        (thread) =>
                            `  ${thread.resolved ? "resolved" : "open    "} ${thread.path}:${thread.line}${thread.outdated ? " (outdated)" : ""}  ${thread.comments.length} comments  ${thread.id}`
                    ),
                ].join("\n"),
        });
    });

pr.command("reply")
    .description("Reply in a review thread: published at once, or a draft in my pending review with --draft")
    .requiredOption("--thread <id>", "thread id from `threads` (GitHub PRRT_…, GitLab discussion id)")
    .option("--body-file <file>", "the reply (markdown); - reads stdin")
    .option("--draft", "keep it pending until `publish`")
    .option("--repo <path>", REPO_HELP, ".")
    .option("--pr <ref>", PR_HELP)
    .option("--json", "machine-readable output")
    .action(
        async (opts: {
            thread: string;
            bodyFile?: string;
            draft?: boolean;
            repo: string;
            pr?: string;
            json?: boolean;
        }) => {
            await prVerb({
                json: opts.json,
                run: async () => {
                    const body = await readBody(opts.bodyFile);
                    return prWrite(opts, (backend) =>
                        backend.reply({ threadId: opts.thread, body, draft: Boolean(opts.draft) })
                    );
                },
                human: (result) => `${result.isDraft ? "Drafted" : "Posted"} reply ${result.commentId}`,
            });
        }
    );

interface LineCommentOptions {
    path: string;
    line: string;
    startLine?: string;
    side?: string | true;
    bodyFile?: string;
    repo: string;
    pr?: string;
    json?: boolean;
}

/**
 * `draft add` and `comment` take the same line flags (the review window builds both argv from one
 * helper, `PRCommand.lineComment`); only what the backend does with the comment differs.
 */
function lineCommentVerb<T>(
    command: Command,
    { write, human }: { write: (backend: PrBackend, input: DraftAddInput) => Promise<T>; human: (result: T) => string }
): void {
    command
        .requiredOption("--path <path>", "repo-relative file (the new path)")
        .requiredOption("--line <n>", "line on --side; the last line of a multi-line comment")
        .option("--start-line <n>", "first line of a multi-line comment")
        .option("--side [side]", `${THREAD_SIDES.join("|")} (default additions: the new side)`)
        .option("--body-file <file>", "the comment (markdown); - reads stdin")
        .option("--repo <path>", REPO_HELP, ".")
        .option("--pr <ref>", PR_HELP)
        .option("--json", "machine-readable output")
        .action(async (opts: LineCommentOptions) => {
            const side = await enumFlag<ThreadSide>("--side", THREAD_SIDES, opts.side);

            if (side === null) {
                process.exitCode = 1;
                return;
            }

            await prVerb({
                json: opts.json,
                run: async () => {
                    const line = lineNumber(opts.line, "--line") ?? 0;
                    const startLine = lineNumber(opts.startLine, "--start-line");
                    const body = await readBody(opts.bodyFile);
                    return prWrite(opts, (backend) =>
                        write(backend, { path: opts.path, side: side ?? "additions", line, startLine, body })
                    );
                },
                human,
            });
        });
}

const draft = pr.command("draft").description("My pending review comments: only `publish` sends them");

lineCommentVerb(
    draft
        .command("add")
        .description("Add a draft review comment on a diff line (GitHub: the pending review, created when missing)"),
    {
        write: (backend, input) => backend.draftAdd(input),
        human: (result) => `Draft ${result.draftId} added${result.threadId ? ` (thread ${result.threadId})` : ""}`,
    }
);

lineCommentVerb(
    pr
        .command("comment")
        .description(
            "Post a NEW comment on a diff line at once, visible to everyone; my other pending drafts stay pending"
        ),
    {
        write: (backend, input) => backend.comment(input),
        human: (result) => `Posted${result.url ? `: ${result.url}` : ""}`,
    }
);

draft
    .command("update")
    .description("Replace the text of one of my drafts; a published comment is refused")
    .argument("<draftId>", "draftId from `draft add` (or a draft comment id from `threads`)")
    .option("--body-file <file>", "the new text (markdown); - reads stdin")
    .option("--repo <path>", REPO_HELP, ".")
    .option("--pr <ref>", PR_HELP)
    .option("--json", "machine-readable output")
    .action(async (draftId: string, opts: { bodyFile?: string; repo: string; pr?: string; json?: boolean }) => {
        await prVerb({
            json: opts.json,
            run: async () => {
                const body = await readBody(opts.bodyFile);
                return prWrite(opts, (backend) => backend.draftUpdate({ draftId, body }));
            },
            human: (result) => `Draft ${result.draftId} updated`,
        });
    });

draft
    .command("delete")
    .description("Delete one of my drafts; a published comment is refused")
    .argument("<draftId>", "draftId from `draft add` (or a draft comment id from `threads`)")
    .option("--repo <path>", REPO_HELP, ".")
    .option("--pr <ref>", PR_HELP)
    .option("--json", "machine-readable output")
    .action(async (draftId: string, opts: { repo: string; pr?: string; json?: boolean }) => {
        await prVerb({
            json: opts.json,
            run: () => prWrite(opts, (backend) => backend.draftDelete(draftId)),
            human: (result) => `Draft ${result.draftId} deleted`,
        });
    });

pr.command("resolve")
    .description("Resolve a review thread, or reopen it with --unresolve")
    .argument("<threadId>", "thread id from `threads`")
    .option("--unresolve", "reopen a resolved thread")
    .option("--repo <path>", REPO_HELP, ".")
    .option("--pr <ref>", PR_HELP)
    .option("--json", "machine-readable output")
    .action(async (threadId: string, opts: { unresolve?: boolean; repo: string; pr?: string; json?: boolean }) => {
        await prVerb({
            json: opts.json,
            run: () => prWrite(opts, (backend) => backend.resolve({ threadId, resolved: !opts.unresolve })),
            human: (result) => `Thread ${result.threadId} ${result.resolved ? "resolved" : "reopened"}`,
        });
    });

pr.command("fix")
    .description(
        "Send review threads as one task to the session that owns the branch, then focus its cmux pane; never writes to the PR"
    )
    .requiredOption("--threads <ids>", "comma-separated thread ids from `threads`")
    .option("--session <id>", "send to this session instead of the best live one that worked on the branch")
    .option("--no-send", "only write the task file and print the prompt (to start a new agent with it)")
    .option("--no-focus", "do not focus the session's cmux pane after the send")
    .option("--no-activate", "focus the pane without raising the cmux app")
    .option("--dry-run", "print the plan (task file, prompt, owner, candidates); write and send nothing")
    .option("--repo <path>", REPO_HELP, ".")
    .option("--pr <ref>", PR_HELP)
    .option("--json", "machine-readable output")
    .action(
        async (opts: {
            threads: string;
            session?: string;
            send: boolean;
            focus: boolean;
            activate: boolean;
            dryRun?: boolean;
            repo: string;
            pr?: string;
            json?: boolean;
        }) => {
            await prVerb({
                json: opts.json,
                run: async () => {
                    const result = await fixThreads(
                        {
                            repo: resolve(opts.repo),
                            pr: opts.pr,
                            ids: opts.threads
                                .split(",")
                                .map((id) => id.trim())
                                .filter(Boolean),
                            session: opts.session,
                            dryRun: opts.dryRun,
                            send: opts.send,
                            focus: opts.focus,
                            activate: opts.activate,
                        },
                        realFixThreadsDeps
                    );

                    if (result.error && !result.sent && opts.send) {
                        process.exitCode = 1;
                    }

                    return result;
                },
                human: (result) =>
                    [
                        `${result.pr.label}: ${result.threads.length} threads in ${result.file}${result.written ? "" : " (not written)"}`,
                        result.missing.length ? `Not on the PR: ${result.missing.join(", ")}` : null,
                        result.owner
                            ? `Owner: ${result.owner.provider} ${result.owner.sessionId.slice(0, 8)} ${result.owner.live ? "(open in cmux)" : "(not open in cmux)"} ${result.owner.title ?? result.owner.cwd}`
                            : "Owner: none",
                        result.sent ? `Sent${result.focused ? " and focused" : ""}.` : `Prompt: ${result.prompt}`,
                        result.error ? `Error: ${result.error}` : null,
                    ]
                        .filter(Boolean)
                        .join("\n"),
            });
        }
    );

pr.command("publish")
    .description(
        "🛑 Publish ALL my drafts as one review, visible to everyone (GitHub COMMENT unless --approve / --request-changes; GitLab bulk publish)"
    )
    .option("--approve", "submit as an approval")
    .option("--request-changes", "submit as a change request (GitHub only)")
    .option("--body-file <file>", "a review summary (markdown); - reads stdin")
    .option("--repo <path>", REPO_HELP, ".")
    .option("--pr <ref>", PR_HELP)
    .option("--json", "machine-readable output")
    .action(
        async (opts: {
            approve?: boolean;
            requestChanges?: boolean;
            bodyFile?: string;
            repo: string;
            pr?: string;
            json?: boolean;
        }) => {
            await prVerb({
                json: opts.json,
                run: async () => {
                    if (opts.approve && opts.requestChanges) {
                        throw new HubPrError("bad-input", "--approve and --request-changes exclude each other");
                    }

                    const event: PublishEvent = opts.approve
                        ? "APPROVE"
                        : opts.requestChanges
                          ? "REQUEST_CHANGES"
                          : "COMMENT";
                    const body = opts.bodyFile ? await readBody(opts.bodyFile) : undefined;
                    return prWrite(opts, (backend) => backend.publish({ event, body }));
                },
                human: (result) =>
                    `Published ${result.published} drafts as ${result.event}${result.url ? `: ${result.url}` : ""}`,
            });
        }
    );

registerWorktreesCommand(program);
registerCheckLogCommand(pr);
registerNotifyCommands(program);
registerConfigCommands(program);

await runTool(program, { tool: "hub" });
