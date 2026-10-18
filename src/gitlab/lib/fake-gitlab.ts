/**
 * Test support for the gitlab commands: a GitLab REST API behind `globalThis.fetch`, and small git
 * repositories to run the content check against. Nothing here is used outside `*.test.ts` files.
 */

import { mock, spyOn } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type GitLabToolConfig, mergeConfig, NEUTRAL_CONFIG } from "@app/gitlab/lib/config";
import type { ReviewFields, StaleMr, StaleReport } from "@app/gitlab/lib/stale-branches";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";

export const FAKE_HOST = "https://gitlab.example.com";
export const FAKE_PROJECT = "acme/widgets";
export const FAKE_PROJECT_ID = 4242;
export const PROJECT_API = `/projects/${encodeURIComponent(FAKE_PROJECT)}`;
export const FAKE_TOKEN = "glpat-fake0token0for0tests";

export interface FakeRequest {
    method: string;
    /** The path after `/api/v4`, with the project path still percent-encoded. */
    path: string;
    query: URLSearchParams;
    body: unknown;
}

type Responder = (request: FakeRequest) => unknown;

/** A JSON body, a `Response`, or a function of the request returning either. */
type Reply = Responder | Response | readonly unknown[] | Record<string, unknown>;

interface Route {
    method: string;
    matcher: string | RegExp;
    reply: Reply;
}

/** A reply with a status other than 200. */
export function status(code: number, body: unknown = { message: `HTTP ${code}` }): Response {
    return code === 204 ? new Response(null, { status: 204 }) : Response.json(body, { status: code });
}

/**
 * Every call goes to the first route that matches, and a route added later wins over an earlier one.
 * A call no route matches answers 404, which is what GitLab says for an unknown object.
 */
export class FakeGitLab {
    readonly requests: FakeRequest[] = [];
    private readonly routes: Route[] = [];

    /** `reply` is a JSON value, a `Response` (use `status()`), or a function of the request returning either. */
    on(method: string, matcher: string | RegExp, reply: Reply): this {
        this.routes.unshift({ method, matcher, reply });

        return this;
    }

    get(matcher: string | RegExp, reply: Reply): this {
        return this.on("GET", matcher, reply);
    }

    /** Every request of this method whose path starts with `prefix`. */
    calls(method: string, prefix: string): FakeRequest[] {
        return this.requests.filter((request) => request.method === method && request.path.startsWith(prefix));
    }

    /** Every request that changed something on the server. */
    writes(): FakeRequest[] {
        return this.requests.filter((request) => request.method !== "GET");
    }

    /** What `fetch` answers while this fake is the one in scope (see `scoped`). */
    async respond(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = (init?.method ?? "GET").toUpperCase();
        const text = typeof init?.body === "string" ? init.body : "";
        const request: FakeRequest = {
            method,
            path: url.pathname.replace(/^\/api\/v4/, ""),
            query: url.searchParams,
            body: text ? SafeJSON.parse(text, { strict: true }) : undefined,
        };
        this.requests.push(request);

        const route = this.routes.find(
            (candidate) =>
                candidate.method === method &&
                (typeof candidate.matcher === "string"
                    ? candidate.matcher === request.path
                    : candidate.matcher.test(request.path))
        );

        if (!route) {
            return status(404);
        }

        const reply = typeof route.reply === "function" ? route.reply(request) : route.reply;

        return reply instanceof Response ? reply : Response.json(reply);
    }
}

// ─── running a command against a fake ──────────────────────────────────────────

interface RunScope {
    fake: FakeGitLab;
    stdout: string[];
    stderr: string[];
}

const scope = new AsyncLocalStorage<RunScope>();
let realFetch: typeof fetch | null = null;
let outSpies: Array<{ mockRestore(): void }> = [];

/**
 * Puts one `fetch` and one set of `out` spies in place for the whole file (call it in `beforeAll`).
 * Each call is routed by the async scope it was started in, so a command that outlives its test
 * (a test that hit its time limit) still talks to its own fake and writes to its own output, and
 * can never restore a global underneath the test that runs next. Outside a scope `fetch` throws,
 * so nothing reaches the network.
 */
export function startFakeRuntime(): void {
    if (realFetch) {
        return;
    }

    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const current = scope.getStore();

        if (!current) {
            throw new Error("fetch was called outside a fake GitLab scope");
        }

        return current.fake.respond(input, init);
    }) as unknown as typeof fetch;

    const write = (target: "stdout" | "stderr", ending: string) => (raw?: unknown) => {
        scope.getStore()?.[target].push(`${raw ?? ""}${ending}`);
    };
    outSpies = [
        spyOn(out, "println").mockImplementation(write("stdout", "\n")),
        spyOn(out, "print").mockImplementation(write("stdout", "")),
        spyOn(out, "printlnErr").mockImplementation(write("stderr", "\n")),
        spyOn(out, "result").mockImplementation((raw?: unknown) => {
            scope.getStore()?.stdout.push(`${SafeJSON.stringify(raw)}\n`);
        }),
    ];
}

export function stopFakeRuntime(): void {
    for (const spy of outSpies) {
        spy.mockRestore();
    }

    outSpies = [];

    if (realFetch) {
        globalThis.fetch = realFetch;
        realFetch = null;
    }
}

/** Runs `fn` with `fake` answering every `fetch` it makes, and returns its value with what it printed. */
export async function scoped<T>(
    fake: FakeGitLab,
    fn: () => Promise<T>
): Promise<{ value: T; stdout: string; stderr: string }> {
    const current: RunScope = { fake, stdout: [], stderr: [] };
    const value = await scope.run(current, fn);

    return { value, stdout: current.stdout.join(""), stderr: current.stderr.join("") };
}

export interface RawUser {
    username: string;
    name: string;
    id: number;
    state: string;
}

export const ALICE: RawUser = { username: "alice", name: "Alice Example", id: 11, state: "active" };
export const BOB: RawUser = { username: "bob", name: "Bob Example", id: 12, state: "blocked" };

export function rawMr(iid: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        iid,
        title: `MR ${iid}`,
        description: null,
        author: ALICE,
        source_branch: `feature/${iid}`,
        target_branch: "main",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-02-01T00:00:00Z",
        draft: false,
        state: "opened",
        labels: [],
        web_url: `${FAKE_HOST}/${FAKE_PROJECT}/-/merge_requests/${iid}`,
        has_conflicts: false,
        detailed_merge_status: "mergeable",
        user_notes_count: 0,
        sha: `${String(iid).padStart(8, "0")}cafebabe`,
        ...extra,
    };
}

export function rawNote(
    id: number,
    extra: { author?: string; body?: string; system?: boolean; at?: string } = {}
): Record<string, unknown> {
    const at = extra.at ?? "2026-02-02T00:00:00Z";

    return {
        id,
        author: { username: extra.author ?? "carol" },
        created_at: at,
        updated_at: at,
        system: extra.system ?? false,
        body: extra.body ?? `note ${id}`,
    };
}

/** The routes every command needs: the project, the token owner, and the project id the ledger keys on. */
export function baseRoutes(fake: FakeGitLab): FakeGitLab {
    return fake
        .get(PROJECT_API, {
            id: FAKE_PROJECT_ID,
            name: "widgets",
            name_with_namespace: "Acme / widgets",
            path_with_namespace: FAKE_PROJECT,
            web_url: `${FAKE_HOST}/${FAKE_PROJECT}`,
            default_branch: "main",
        })
        .get("/user", { id: 99, username: "me", name: "Me Example", web_url: `${FAKE_HOST}/me` });
}

/** Routes for one MR: its record, its notes, its approvals. Pass `mr` fields to change the record. */
export function mrRoutes(
    fake: FakeGitLab,
    iid: number,
    options: { mr?: Record<string, unknown>; notes?: Array<Record<string, unknown>>; approvedBy?: string[] } = {}
): FakeGitLab {
    const base = `${PROJECT_API}/merge_requests/${iid}`;

    return fake
        .get(base, () => rawMr(iid, options.mr))
        .get(`${base}/notes`, () => options.notes ?? [])
        .get(`${base}/approvals`, () => ({
            approved: (options.approvedBy ?? []).length > 0,
            approved_by: (options.approvedBy ?? []).map((username) => ({ user: { username } })),
        }));
}

// ─── sweep fixtures ────────────────────────────────────────────────────────────

/** An MR record that agrees with `rawMr(iid)`, so a live read of it shows nothing moved since the sweep. */
export function staleMrFixture(iid: number, review: Partial<ReviewFields> = {}, extra: Partial<StaleMr> = {}): StaleMr {
    const raw = rawMr(iid);

    return {
        iid,
        title: `MR ${iid}`,
        description: "",
        author: ALICE,
        sourceBranch: `feature/${iid}`,
        targetBranch: "main",
        createdAt: String(raw.created_at),
        updatedAt: String(raw.updated_at),
        draft: false,
        state: "opened",
        labels: [],
        webUrl: String(raw.web_url),
        hasConflicts: false,
        detailedMergeStatus: "mergeable",
        userNotesCount: 0,
        sha: String(raw.sha),
        ageDays: 200,
        daysSinceUpdate: 10,
        git: {
            sourceMissing: false,
            targetMissing: false,
            behind: 1,
            ahead: 1,
            lastCommitDate: "2026-02-01",
            lastCommitAuthor: "Alice Example",
            lastCommitEmail: "alice@example.com",
        },
        notes: [],
        lastNote: null,
        lastHumanNote: null,
        approvals: null,
        shipped: null,
        labelConflicts: [],
        siblings: [],
        ado: null,
        adoExtra: [],
        needsReview: true,
        review: { ...emptyReviewFields(), ...review },
        ...extra,
    };
}

function emptyReviewFields(): ReviewFields {
    return {
        recommendation: null,
        confidence: null,
        reason: null,
        adoCommentsSummary: null,
        draftComment: null,
        labels: [],
        evidence: [],
    };
}

/** A reviewed MR with a drafted comment, ready to be posted. */
export function reviewedMrFixture(
    iid: number,
    review: Partial<ReviewFields> = {},
    extra: Partial<StaleMr> = {}
): StaleMr {
    return staleMrFixture(
        iid,
        {
            recommendation: "ASK AUTHOR",
            confidence: 80,
            reason: "No activity for months.",
            draftComment: `Is !${iid} still needed?`,
            ...review,
        },
        extra
    );
}

export function staleReportFixture(mrs: StaleMr[], extra: Partial<StaleReport> = {}): StaleReport {
    return {
        _instructions: "",
        generatedAt: "2026-03-01T12:00:00Z",
        asOfDate: "2026-03-01",
        host: FAKE_HOST,
        project: FAKE_PROJECT,
        defaultBranch: "main",
        repoRoot: "/nonexistent/checkout",
        reviewMinAgeDays: 90,
        inactiveAfterDays: 30,
        mrs,
        authors: [],
        shippedRefs: ["origin/main"],
        shippedRoles: { uat: null, production: "origin/main", test: null },
        failures: [],
        commands: [],
        ...extra,
    };
}

// ─── config ────────────────────────────────────────────────────────────────────

/** The config `loadConfig()` answers with while the fake is installed. `loadConfig` itself reads one file once per process. */
export const fakeConfig: { current: GitLabToolConfig } = { current: mergeConfig({}, NEUTRAL_CONFIG) };

export async function installFakeConfig(): Promise<void> {
    const real = await import("@app/gitlab/lib/config");

    mock.module("@app/gitlab/lib/config", () => ({
        ...real,
        loadConfig: () => Promise.resolve(fakeConfig.current),
    }));
}

// ─── Azure DevOps ──────────────────────────────────────────────────────────────

/** Work items `tools azure-devops workitem <id>` answers with; a string is the stderr of a failed read. */
export const adoWorkItems = new Map<number, Record<string, unknown> | string>();
/** The ids read through the fake, in order. */
export const adoReads: number[] = [];

export function rawAdo(
    id: number,
    extra: {
        title?: string;
        state?: string;
        type?: string;
        parent?: number;
        changed?: string;
        comments?: Array<{ id: number; author: string; date: string; text: string }>;
        fields?: Record<string, unknown>;
    } = {}
): Record<string, unknown> {
    return {
        id,
        title: extra.title ?? `Work item ${id}`,
        state: extra.state ?? "Active",
        changed: extra.changed ?? "2026-03-01T00:00:00Z",
        created: "2026-01-01T00:00:00Z",
        assignee: "Dana Example",
        tags: "",
        description: "<p>Details</p>",
        changedBy: "Dana Example",
        url: `https://dev.azure.com/acme/_apis/wit/workItems/${id}`,
        rawFields: {
            "System.WorkItemType": extra.type ?? "Bug",
            ...(extra.parent === undefined ? {} : { "System.Parent": extra.parent }),
            ...extra.fields,
        },
        comments: extra.comments ?? [],
    };
}

/**
 * Answers `execTool(["azure-devops", "workitem", <id>, ...])` from `adoWorkItems`; every other call
 * reaches the real function, so the replacement is harmless to a test that shares the process.
 */
export async function installFakeAdo(): Promise<void> {
    const real = await import("@genesiscz/utils/cli");

    mock.module("@genesiscz/utils/cli", () => ({
        ...real,
        execTool: async (args: string[], options?: Parameters<typeof real.execTool>[1]) => {
            if (args[0] !== "azure-devops" || args[1] !== "workitem") {
                return real.execTool(args, options);
            }

            const id = Number(args[2]);
            const item = adoWorkItems.get(id);
            adoReads.push(id);

            if (typeof item === "object") {
                return { success: true, stdout: SafeJSON.stringify(item), stderr: "", exitCode: 0 };
            }

            return {
                success: false,
                stdout: "",
                stderr: item ?? `TF401232: work item ${id} does not exist`,
                exitCode: 1,
            };
        },
    }));
}

// ─── git ───────────────────────────────────────────────────────────────────────

const GIT_ENV = { GIT_AUTHOR_DATE: "2026-02-01T10:00:00Z", GIT_COMMITTER_DATE: "2026-02-01T10:00:00Z" };

export function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
    const result = spawnSync(
        "git",
        ["-c", "user.name=Alice Example", "-c", "user.email=alice@example.com", "-c", "commit.gpgsign=false", ...args],
        { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV, ...env } }
    );

    if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
    }

    return result.stdout.trim();
}

export function writeIn(root: string, path: string, text: string): void {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
}

export function commitAll(repo: string, message: string, date: string, author?: { name: string; email: string }): void {
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", message], {
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
        ...(author
            ? {
                  GIT_AUTHOR_NAME: author.name,
                  GIT_AUTHOR_EMAIL: author.email,
                  GIT_COMMITTER_NAME: author.name,
                  GIT_COMMITTER_EMAIL: author.email,
              }
            : {}),
    });
}

const BOB_AUTHOR = { name: "Bob Example", email: "bob@example.com" };

export interface StaleRepo {
    root: string;
    /** The clone the commands run in; `origin` is the upstream beside it. */
    clone: string;
    upstream: string;
}

/**
 * `origin/main` has moved on from the branches' common base by one commit.
 *   feature/1: a new file main does not have            (content absent from main)
 *   feature/2: lines main later got too                 (content present on main)
 *   feature/3: stacked on feature/1
 */
export function createStaleRepo(): StaleRepo {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gt-gitlab-stale-")));
    const upstream = join(root, "upstream");
    const clone = join(root, "clone");
    git(root, ["init", "-q", "-b", "main", upstream]);
    writeIn(upstream, "src/a.ts", "export const shared = computeShared(1);\n");
    writeIn(upstream, "src/c.ts", "export const zero = 0;\n");
    commitAll(upstream, "base", "2026-01-01T09:00:00Z");

    git(upstream, ["checkout", "-q", "-b", "feature/1"]);
    writeIn(
        upstream,
        "src/b.ts",
        "export const fromOne = buildFromOne(1);\nexport const fromOneToo = buildFromOne(2);\n"
    );
    commitAll(upstream, "feature one", "2026-02-01T09:00:00Z");

    git(upstream, ["checkout", "-q", "-b", "feature/3"]);
    writeIn(upstream, "src/d.ts", "export const stacked = buildStacked(3);\n");
    commitAll(upstream, "feature three", "2026-02-05T09:00:00Z");

    git(upstream, ["checkout", "-q", "main"]);
    git(upstream, ["checkout", "-q", "-b", "feature/2"]);
    writeIn(upstream, "src/c.ts", "export const zero = 0;\nexport const two = computeTwo(2);\n");
    commitAll(upstream, "feature two", "2026-02-10T09:00:00Z", BOB_AUTHOR);

    git(upstream, ["checkout", "-q", "main"]);
    writeIn(upstream, "src/c.ts", "export const zero = 0;\nexport const two = computeTwo(2);\n");
    commitAll(upstream, "main got two", "2026-03-01T09:00:00Z");

    git(root, ["clone", "-q", upstream, clone]);
    // A `git fetch` in the clone would otherwise start a detached maintenance run in the middle of a later test.
    git(clone, ["config", "maintenance.auto", "false"]);
    git(clone, ["config", "gc.auto", "0"]);

    return { root, clone, upstream };
}
