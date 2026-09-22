import { describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "./git-context.ts";
import {
    fillPlaceholders,
    overrideFor,
    type ProjectOverrides,
    resolveOverride,
    runResolver,
} from "./project-overrides.ts";

const main: Ctx = {
    toplevel: "/repos/acme",
    branch: "feature/next",
    cwd: "/repos/acme",
    pinned: { project: false, branch: false },
};

const worktree: Ctx = {
    toplevel: "/repos/acme-wt-login",
    branch: "fix/login",
    cwd: "/repos/acme-wt-login",
    mainProject: "/repos/acme",
    pinned: { project: false, branch: false },
};

/** Flat research folder, per-ticket wrap-up folder: the two must not collapse into one. */
const SPLIT: ProjectOverrides = {
    "/repos/acme": {
        appliesToWorktrees: true,
        rule: "research is flat, wrap-ups go per ticket",
        consumers: {
            research: { dir: "/vault/Acme/Research" },
            "wrap-up": { resolverCommand: `printf '{"dir":"/vault/Acme/ticket-<branch>"}'` },
        },
    },
};

describe("overrideFor", () => {
    it("matches the main checkout", () => {
        expect(overrideFor(SPLIT, main)?.key).toBe("/repos/acme");
    });

    it("matches a linked worktree through its main checkout", () => {
        expect(overrideFor(SPLIT, worktree)?.key).toBe("/repos/acme");
    });

    it("does not reach into a worktree when the project opts out", () => {
        const optedOut: ProjectOverrides = {
            "/repos/acme": { appliesToWorktrees: false, consumers: { research: { dir: "/v" } } },
        };

        expect(overrideFor(optedOut, worktree)).toBeNull();
        expect(overrideFor(optedOut, main)?.key).toBe("/repos/acme");
    });

    it("returns null for an unrelated project", () => {
        expect(overrideFor(SPLIT, { ...main, toplevel: "/repos/other", cwd: "/repos/other" })).toBeNull();
    });
});

describe("fillPlaceholders", () => {
    it("gives <project> the main checkout and <worktree> the one in use, each shell-quoted", () => {
        expect(
            fillPlaceholders("r --cwd <cwd> --project <project> --worktree <worktree> --branch <branch>", worktree)
        ).toBe(
            "r --cwd '/repos/acme-wt-login' --project '/repos/acme' --worktree '/repos/acme-wt-login' --branch 'fix/login'"
        );
    });

    it("falls back to the toplevel for <project> outside a worktree", () => {
        expect(fillPlaceholders("<project>", main)).toBe("'/repos/acme'");
    });

    it("a branch name cannot break out of the shell command", () => {
        // git permits `;`, `$`, backticks and spaces in a branch name, and the filled string
        // goes to `sh -c`. Unquoted, checking out a branch would run arbitrary commands.
        const hostile = { ...main, branch: `x'; touch /tmp/pwned; echo '` };
        const filled = fillPlaceholders("resolve --branch <branch>", hostile);

        expect(filled).toBe(`resolve --branch 'x'\\''; touch /tmp/pwned; echo '\\'''`);
        expect(filled.startsWith("resolve --branch '")).toBe(true);
    });

    it("the quoted value still reaches the resolver intact", async () => {
        const { output } = await runResolver(`echo '{"dir":"'<branch>'"}'`, { ...main, branch: "fix/login" }, "test");

        expect(output?.dir).toBe("fix/login");
    });

    it("a hostile branch really does run through sh -c without executing", async () => {
        // Asserting on the filled string alone proves the quoting looks right. This runs it,
        // so the claim is that nothing executed, not that nothing appeared to.
        const marker = join(tmpdir(), `gt-inject-${process.pid}-${Date.now()}.txt`);
        // The payload must be one that injects when UNQUOTED and is inert when quoted. A
        // payload carrying its own quotes (`x'; touch …; echo '`) is shaped to escape THIS
        // implementation's quoting and, left unquoted, merely echoes as a literal — so it
        // would pass either way and prove nothing.
        const hostile = { ...main, branch: `x; touch ${marker}` };
        const { output, error } = await runResolver(
            `echo '{"dir":"/ok"}' && echo <branch> >/dev/null`,
            hostile,
            "test"
        );

        expect(existsSync(marker)).toBe(false);
        expect(error).toBeUndefined();
        expect(output?.dir).toBe("/ok");

        if (existsSync(marker)) {
            rmSync(marker, { force: true });
        }
    });
});

describe("runResolver", () => {
    it("reads dir and warnings out of the resolver's JSON", async () => {
        const { output, error } = await runResolver(`echo '{"dir":"/v/acme","warnings":["reused"]}'`, main, "test");

        expect(error).toBeUndefined();
        expect(output?.dir).toBe("/v/acme");
        expect(output?.warnings).toEqual(["reused"]);
    });

    it("substitutes placeholders before running", async () => {
        const { output } = await runResolver(`printf '{"dir":"/v/<branch>"}'`, main, "test");

        expect(output?.dir).toBe("/v/feature/next");
    });

    it("fails rather than guessing when the resolver prints no dir", async () => {
        const { output, error } = await runResolver(`echo '{"adoId":"1"}'`, main, "test");

        expect(output).toBeUndefined();
        expect(error).toContain('no "dir"');
    });

    it("fails rather than guessing when the resolver prints non-JSON", async () => {
        expect((await runResolver("echo not-json", main, "test")).error).toContain("did not print JSON");
    });

    it("fails rather than guessing when the resolver prints nothing", async () => {
        expect((await runResolver("true", main, "test")).error).toContain("printed nothing");
    });
});

describe("resolveOverride", () => {
    it("gives each consumer its OWN folder for the same project", async () => {
        const research = await resolveOverride({ overrides: SPLIT, ctx: main, consumer: "research", label: "test" });
        const wrapUp = await resolveOverride({ overrides: SPLIT, ctx: main, consumer: "wrap-up", label: "test" });

        expect(research).toMatchObject({ kind: "dir", dir: "/vault/Acme/Research" });
        expect(wrapUp).toMatchObject({ kind: "resolver", dir: "/vault/Acme/ticket-feature/next" });
    });

    it("carries the project's rule so the agent can show it", async () => {
        const resolved = await resolveOverride({ overrides: SPLIT, ctx: main, consumer: "research", label: "test" });

        expect(resolved).toMatchObject({ rule: "research is flat, wrap-ups go per ticket" });
    });

    it("says none for a consumer the project does not configure", async () => {
        expect(await resolveOverride({ overrides: SPLIT, ctx: main, consumer: "obsidian", label: "test" })).toEqual({
            kind: "none",
        });
    });

    it("says failed, not none, when a declared resolver breaks", async () => {
        const broken: ProjectOverrides = {
            "/repos/acme": { consumers: { research: { resolverCommand: "echo not-json" } } },
        };
        const resolved = await resolveOverride({ overrides: broken, ctx: main, consumer: "research", label: "test" });

        // The distinction is the point: "none" falls through to the next tier, "failed" must not.
        expect(resolved.kind).toBe("failed");
    });

    it("expands a ~ in a static dir", async () => {
        const tilde: ProjectOverrides = { "/repos/acme": { consumers: { research: { dir: "~/Vault/R" } } } };
        const resolved = await resolveOverride({ overrides: tilde, ctx: main, consumer: "research", label: "test" });

        expect(resolved.kind === "dir" && resolved.dir.startsWith("/")).toBe(true);
        expect(resolved.kind === "dir" && resolved.dir.includes("~")).toBe(false);
    });
});
