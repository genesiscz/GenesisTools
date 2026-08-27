import { describe, expect, test } from "bun:test";
import { buildLaunchCommand, paneTitle } from "@app/claude/lib/cmux/command";
import type { PlannedSession } from "@app/claude/lib/cmux/types";

function session(overrides: Partial<PlannedSession["candidate"]> = {}, extra: Partial<PlannedSession> = {}) {
    return {
        candidate: {
            sessionId: "8b6e69bf-0efc-4990-ba3e-b77262498421",
            cwd: "/Users/me/Projects/App",
            project: "App",
            branch: "master",
            title: null,
            lastPrompt: null,
            limitStop: null,
            subdir: null,
            mtimeMs: 0,
            account: null,
            model: null,
            pinned: false,
            ...overrides,
        },
        account: null,
        model: null,
        ...extra,
    } satisfies PlannedSession;
}

describe("buildLaunchCommand", () => {
    test("resumes through claude's own flag, after the passthrough separator", () => {
        const command = buildLaunchCommand(session());

        // Before `--`, `--resume <id>` would hit the LOCAL session search and prompt.
        expect(command).toBe(
            "cd -- '/Users/me/Projects/App' && tools claude start -- --resume '8b6e69bf-0efc-4990-ba3e-b77262498421'"
        );
    });

    test("names the pinned account and model", () => {
        const command = buildLaunchCommand(session({}, { account: "max-primary", model: "opus" }));

        expect(command).toContain("tools claude start 'max-primary' -m 'opus' --");
    });

    test("only autopicks when there is no account to name", () => {
        expect(buildLaunchCommand(session(), { autopick: true })).toContain("tools claude start -a --");
        expect(buildLaunchCommand(session({}, { account: "work" }), { autopick: true })).toContain(
            "tools claude start 'work' --"
        );
    });

    describe("a session pinned with no account ran on the plain keychain", () => {
        // `pinned: true, account: null` is the hook reporting "TOOLS_CLAUDE_ACCOUNT
        // was unset" — a real answer. `pinned: false` is "nobody recorded this".
        // Collapsing them resumes a keychain session billed to a token account.
        test("resumes as a bare claude, never through the account picker", () => {
            const command = buildLaunchCommand(session({ pinned: true }));

            expect(command).toBe(
                "cd -- '/Users/me/Projects/App' && claude --resume '8b6e69bf-0efc-4990-ba3e-b77262498421'"
            );
            expect(command).not.toContain("tools claude start");
        });

        test("is never autopicked onto a token account", () => {
            const command = buildLaunchCommand(session({ pinned: true }), { autopick: true });

            expect(command).not.toContain("-a");
            expect(command).not.toContain("tools claude start");
        });

        test("spells the model claude's way, not the wrapper's", () => {
            expect(buildLaunchCommand(session({ pinned: true }, { model: "opus" }))).toContain("--model 'opus'");
        });

        test("an UNPINNED session still goes through the wrapper", () => {
            expect(buildLaunchCommand(session({ pinned: false }), { autopick: true })).toContain(
                "tools claude start -a --"
            );
        });

        test("a pinned session that names an account still goes through the wrapper", () => {
            expect(buildLaunchCommand(session({ pinned: true }, { account: "work" }))).toContain(
                "tools claude start 'work' --"
            );
        });
    });

    test("quotes paths and account names containing quotes or spaces", () => {
        const command = buildLaunchCommand(session({ cwd: "/tmp/it's here" }, { account: "a b" }));

        expect(command).toContain("cd -- '/tmp/it'\\''s here'");
        expect(command).toContain("'a b'");
    });

    test("leaves the pane in the session's directory (no subshell, no exec)", () => {
        const command = buildLaunchCommand(session());

        expect(command.startsWith("cd -- ")).toBe(true);
        expect(command).not.toContain("exec ");
    });
});

describe("buildLaunchCommand auth modes", () => {
    test("a --keychain session resumes through --keychain, not the token path", () => {
        const command = buildLaunchCommand(
            session({ pinned: true, auth: "keychain", authSource: "launch-env" }, { account: "work" })
        );

        expect(command).toContain("tools claude start 'work' --keychain --");
    });

    test("a token session stays on the token path", () => {
        const command = buildLaunchCommand(session({ pinned: true, auth: "token" }, { account: "work" }));

        expect(command).toContain("tools claude start 'work' --");
        expect(command).not.toContain("--keychain");
    });

    test("a pin written before auth was recorded keeps the token path it always used", () => {
        const command = buildLaunchCommand(session({ pinned: true }, { account: "work" }));

        expect(command).not.toContain("--keychain");
    });

    test("a pre-fix hook pin that claimed keychain because the OAuth env was stripped resumes on the token path", () => {
        const command = buildLaunchCommand(
            session({ pinned: true, auth: "keychain" }, { account: "work" })
        );

        expect(command).toContain("tools claude start 'work' --");
        expect(command).not.toContain("--keychain");
    });

    test("a --keychain launch recorded via TOOLS_CLAUDE_AUTH still resumes with --keychain", () => {
        const command = buildLaunchCommand(
            session(
                { pinned: true, auth: "keychain", authSource: "launch-env" },
                { account: "work" }
            )
        );

        expect(command).toContain("tools claude start 'work' --keychain --");
    });

    test("a keychain session with no account still resumes as a bare claude", () => {
        const command = buildLaunchCommand(session({ pinned: true, auth: "keychain" }));

        expect(command).toContain("&& claude --resume");
        expect(command).not.toContain("tools claude start");
    });
});

describe("paneTitle", () => {
    test("leads with the session name, since the command line can only carry the id", () => {
        expect(paneTitle(session({ title: "burn the auth callback" }))).toBe("burn the auth callback · 8b6e69bf");
    });

    test("falls back to the project when the session has no name", () => {
        expect(paneTitle(session())).toBe("App · 8b6e69bf");
    });

    test("falls back to the worktree path when there is one and no name", () => {
        expect(paneTitle(session({ subdir: ".worktrees/fix" }))).toBe("App/.worktrees/fix · 8b6e69bf");
    });

    test("cuts a long name but always keeps the id", () => {
        const title = paneTitle(session({ title: "x".repeat(80) }));

        expect(title.endsWith("· 8b6e69bf")).toBe(true);
        expect(title.length).toBeLessThan(48);
    });

    test("collapses newlines, which would break the tab title", () => {
        expect(paneTitle(session({ title: "first line\nsecond line" }))).toBe("first line second line · 8b6e69bf");
    });
});
