import { describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "./git-context.ts";
import {
    fillPlaceholders,
    overrideFor,
    type ProjectOverrides,
    placeholderEnv,
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

    it("lets a block keyed on the worktree win over the main block, whichever comes first", () => {
        const mainFirst: ProjectOverrides = {
            "/repos/acme": { consumers: { research: { dir: "/v/main" } } },
            "/repos/acme-wt-login": { consumers: { research: { dir: "/v/worktree" } } },
        };

        expect(overrideFor(mainFirst, worktree)?.key).toBe("/repos/acme-wt-login");
        expect(overrideFor(mainFirst, main)?.key).toBe("/repos/acme");
    });

    it("returns null for an unrelated project", () => {
        expect(overrideFor(SPLIT, { ...main, toplevel: "/repos/other", cwd: "/repos/other" })).toBeNull();
    });
});

describe("fillPlaceholders", () => {
    it("gives <project> the main checkout and <worktree> the one in use", async () => {
        const { output } = await runResolver(
            `printf '{"dir":"x","cwd":"%s","project":"%s","worktree":"%s","branch":"%s"}' <cwd> <project> <worktree> <branch>`,
            worktree,
            "test"
        );

        expect(output).toMatchObject({
            cwd: "/repos/acme-wt-login",
            project: "/repos/acme",
            worktree: "/repos/acme-wt-login",
            branch: "fix/login",
        });
    });

    it("falls back to the toplevel for <project> outside a worktree", () => {
        expect(placeholderEnv(main).GT_RESOLVER_PROJECT).toBe("/repos/acme");
    });

    it("writes a quoted variable reference that fits the quotes around it", () => {
        expect(fillPlaceholders("r <branch>")).toBe('r "${GT_RESOLVER_BRANCH}"');
        expect(fillPlaceholders("r '<branch>'")).toBe(`r ''"\${GT_RESOLVER_BRANCH}"''`);
        expect(fillPlaceholders('r "<branch>"')).toBe('r "${GT_RESOLVER_BRANCH}"');
        expect(fillPlaceholders("r < in.txt <other>")).toBe("r < in.txt <other>");
    });

    it("a branch carrying its own quotes stays one inert value", async () => {
        // git permits `;`, `$`, backticks and quotes in a branch name, and the command goes to
        // `sh -c`. The value travels in the environment, so no quote inside it can end anything.
        const marker = join(tmpdir(), `gt-inject-quotes-${process.pid}-${Date.now()}.txt`);
        const hostile = { ...main, branch: `x'; touch ${marker}; echo '` };
        const { output } = await runResolver(`printf '{"dir":"%s"}' <branch>`, hostile, "test");

        expect(existsSync(marker)).toBe(false);
        expect(output?.dir).toBe(hostile.branch);

        if (existsSync(marker)) {
            rmSync(marker, { force: true });
        }
    });

    it("a hostile branch stays inert inside a ${…} and a nested $(…) with quotes in it", async () => {
        // `$(echo ')' …)` fools the quote scan into thinking the substitution had closed, so the
        // refusal does not fire there; the reference is inert anyway.
        const marker = join(tmpdir(), `gt-inject-nested-${process.pid}-${Date.now()}.txt`);
        const hostile = { ...main, branch: `$(touch ${marker})` };

        await runResolver(`echo "$(echo ')' <branch>)" >/dev/null; echo '{"dir":"/ok"}'`, hostile, "test");
        await runResolver(`echo \${GT_UNSET_X:-<branch>} >/dev/null; echo '{"dir":"/ok"}'`, hostile, "test");

        expect(existsSync(marker)).toBe(false);

        if (existsSync(marker)) {
            rmSync(marker, { force: true });
        }
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

describe("a placeholder value can never change the resolver command", () => {
    // Valid as a git branch name, and every piece of it is shell syntax. No `"`, so it can sit
    // inside the JSON the resolver prints.
    const hostile = { ...main, branch: "x;echo injected;'$(echo sub)`echo tick`" };
    const printed = (quoted: string) => `printf '{"dir":"ok","branch":"%s"}' ${quoted}`;

    it("arrives as one literal argument, bare or inside either kind of quote", async () => {
        for (const form of ["<branch>", "'<branch>'", '"<branch>"']) {
            const { output, error } = await runResolver(printed(form), hostile, "t");

            expect(error).toBeUndefined();
            expect(output?.branch).toBe(hostile.branch);
        }
    });

    it("inside a larger single-quoted string too", async () => {
        const { output } = await runResolver(`printf '{"dir":"/v/<branch>"}'`, hostile, "t");

        expect(output?.dir).toBe(`/v/${hostile.branch}`);
    });

    it("never runs a command smuggled in through the branch name", async () => {
        // An injected `echo injected` would print to stdout and break the JSON below.
        const run = await runResolver(`echo <branch> > /dev/null; echo '{"dir":"ok"}'`, hostile, "t");

        expect(run.error).toBeUndefined();
        expect(run.output?.dir).toBe("ok");
    });
});

describe("a resolver that never answers", () => {
    it("is stopped at its deadline, children included, with a named error", async () => {
        const started = Date.now();
        const { output, error } = await runResolver("sleep 20; echo late", main, "t", { timeoutMs: 300 });

        expect(output).toBeUndefined();
        expect(error).toContain("did not finish within 300 ms");
        expect(Date.now() - started).toBeLessThan(5_000);
    }, 15_000);

    it("reports a failing exit with its stderr instead of 'printed nothing'", async () => {
        expect((await runResolver("echo broken >&2; exit 3", main, "t")).error).toContain("exited 3: broken");
    });
});

describe("review fixes", () => {
    it("a worktree block without the requested consumer does not hide the main checkout's entry", async () => {
        const partial: ProjectOverrides = {
            ...SPLIT,
            "/repos/acme-wt-login": { consumers: { research: { dir: "/vault/Acme/Login-Research" } } },
        };
        const research = await resolveOverride({ overrides: partial, ctx: worktree, consumer: "research", label: "t" });
        const wrapUp = await resolveOverride({ overrides: partial, ctx: worktree, consumer: "wrap-up", label: "t" });

        expect(research.kind === "dir" && research.dir).toBe("/vault/Acme/Login-Research");
        expect(wrapUp.kind === "resolver" && wrapUp.dir).toBe("/vault/Acme/ticket-fix/login");
    });

    it("a placeholder inside quotes is quoted for that context, so a hostile branch stays inert", async () => {
        const marker = join(tmpdir(), `gt-inject-quoted-${process.pid}-${Date.now()}.txt`);
        const hostile = { ...main, branch: `$(touch ${marker})` };

        for (const command of [`printf '{"dir":"/v/<branch>"}'`, `printf "%s" "{\\"dir\\":\\"/v/<branch>\\"}"`]) {
            const { output, error } = await runResolver(command, hostile, "test");

            expect(error).toBeUndefined();
            expect(output?.dir).toBe(`/v/$(touch ${marker})`);
        }

        expect(existsSync(marker)).toBe(false);

        if (existsSync(marker)) {
            rmSync(marker, { force: true });
        }
    });

    it("refuses a placeholder inside a command substitution nested in double quotes", async () => {
        const { output, error } = await runResolver(`echo "$(printf '%s' '<branch>')"`, main, "test");

        expect(output).toBeUndefined();
        expect(error).toContain("cannot be quoted safely");
    });

    it("refuses a placeholder in a heredoc body, where quotes are literal, and nothing executes", async () => {
        const marker = join(tmpdir(), `gt-inject-heredoc-${process.pid}-${Date.now()}.txt`);
        const hostile = { ...main, branch: `$(touch ${marker})` };
        const { output, error } = await runResolver(`cat <<EOF\n{"dir":"/v/<branch>"}\nEOF`, hostile, "test");

        expect(output).toBeUndefined();
        expect(error).toContain("heredoc");
        expect(existsSync(marker)).toBe(false);

        if (existsSync(marker)) {
            rmSync(marker, { force: true });
        }
    });

    it("still fills a placeholder after a <<< here-string, which is an ordinary word", () => {
        // Checked on the filled text only: `<<<` is a bash feature, and `sh` on ubuntu (dash)
        // rejects it with "redirection unexpected", so running it proved nothing about the scan.
        expect(fillPlaceholders(`cat <<< '{"dir":"/v/'<branch>'"}'`)).toBe(
            `cat <<< '{"dir":"/v/'"\${GT_RESOLVER_BRANCH}"'"}'`
        );
    });

    it("refuses a placeholder inside a ${…} expansion nested in double quotes", async () => {
        const { output, error } = await runResolver(`echo "\${GT_UNSET_X:-<branch>}"`, main, "test");

        expect(output).toBeUndefined();
        expect(error).toContain("cannot be quoted safely");
    });

    it("refuses resolver warnings that are not a list of strings", async () => {
        const bad = await runResolver(`printf '{"dir":"/v","warnings":"not-a-list"}'`, main, "test");
        const mixed = await runResolver(`printf '{"dir":"/v","warnings":["ok",3]}'`, main, "test");
        const good = await runResolver(`printf '{"dir":"/v","warnings":["ok"]}'`, main, "test");

        expect(bad.error).toContain("not a list of strings");
        expect(mixed.error).toContain("not a list of strings");
        expect(good.output?.warnings).toEqual(["ok"]);
    });
});
