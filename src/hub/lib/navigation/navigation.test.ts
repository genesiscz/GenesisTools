import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openHubDb } from "../data-db";
import { hubArgs, hubUrl } from "../open";
import { listNav, navKeep, recordNav, setNavKeep } from "./store";
import { navTargetProblem, navTitle, parseNavInput } from "./target";
import { type NavEntry, normalizeTarget } from "./types";

function entry(id: string, at: number, extra: Partial<NavEntry> = {}): NavEntry {
    return { id, at, actor: "user", title: id, target: { mode: "sessions", session: id }, ...extra };
}

describe("the navigation log", () => {
    it("lists newest first, replaces by id and keeps the agent's note and session", () => {
        const db = openHubDb(":memory:");
        recordNav(db, entry("a", 1));
        recordNav(
            db,
            entry("b", 2, { actor: "agent", note: "the failing run", from: "session-1", target: { pr: "563" } })
        );
        recordNav(db, entry("a", 3, { title: "a again" }));
        const rows = listNav(db);
        expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
        expect(rows[0].title).toBe("a again");
        expect(rows[1]).toMatchObject({
            actor: "agent",
            note: "the failing run",
            from: "session-1",
            target: { pr: "563" },
        });
        db.close();
    });

    it("keeps the newest entries, and a later writer without a cap uses the one the hub stored", () => {
        const db = openHubDb(":memory:");
        expect(navKeep(db)).toBe(200);
        for (let index = 0; index < 5; index++) {
            recordNav(db, entry(`p${index}`, index), { keep: 3 });
        }

        expect(listNav(db).map((row) => row.id)).toEqual(["p4", "p3", "p2"]);
        expect(navKeep(db)).toBe(3);
        recordNav(db, entry("agent", 10, { actor: "agent" }));
        expect(listNav(db).map((row) => row.id)).toEqual(["agent", "p4", "p3"]);
        expect(listNav(db, 1).map((row) => row.id)).toEqual(["agent"]);
        db.close();
    });

    it("reconciles an annotated current place with the CLI row before reloading", () => {
        const db = openHubDb(":memory:");
        recordNav(db, entry("older", 1));
        recordNav(db, entry("shown", 2));
        recordNav(db, entry("cli", 3, { target: { session: "shown" } }));
        recordNav(db, entry("cli", 4, { target: { session: "shown" }, note: "look here" }), { replacing: ["shown"] });
        expect(listNav(db).map((row) => row.id)).toEqual(["cli", "older"]);
        expect(listNav(db)[0].note).toBe("look here");
        db.close();
    });

    it("prunes on a preference change before any new visit and later writers use the cap", () => {
        const db = openHubDb(":memory:");
        for (let index = 0; index < 5; index++) {
            recordNav(db, entry(`p${index}`, index));
        }

        expect(setNavKeep(db, 2)).toEqual({ kept: 2, dropped: 3 });
        expect(navKeep(db)).toBe(2);
        expect(listNav(db).map((row) => row.id)).toEqual(["p4", "p3"]);
        recordNav(db, entry("next", 10));
        expect(listNav(db).map((row) => row.id)).toEqual(["next", "p4"]);
        db.close();
    });

    it("drops unknown target keys and empty values, and reads an unknown actor as user", () => {
        expect(normalizeTarget({ pr: "1", snapshot: "/tmp/x.png", commit: " ", tab: 3 })).toEqual({ pr: "1" });
        const db = openHubDb(":memory:");
        recordNav(db, entry("x", 1));
        db.run(`UPDATE nav_entries SET actor = 'robot', target = '{"pr":"1","menu":"Go/Back"}'`);
        expect(listNav(db)[0]).toMatchObject({ actor: "user", target: { pr: "1" } });
        expect(Object.keys(listNav(db)[0].target)).toEqual(["pr"]);
        db.close();
    });
});

describe("what tools hub nav open names", () => {
    const noFolder = () => false;

    it("reads a hub link in either form with its actor, note and session", () => {
        expect(
            parseNavInput("genesis-tools://hub?pr=owner%2Frepo%23563&commit=0751d8a971&actor=agent&note=why", noFolder)
        ).toEqual({
            target: { pr: "owner/repo#563", commit: "0751d8a971" },
            actor: "agent",
            note: "why",
            from: undefined,
        });
        expect(parseNavInput("https://genesis.example/hub?repo=%2Fsrc%2Fapp&commit=abcdef0&from=s1", noFolder)).toEqual(
            {
                target: { repo: "/src/app", commit: "abcdef0" },
                actor: undefined,
                note: undefined,
                from: "s1",
            }
        );
    });

    it("reads a PR ref, a PR page, a sha and a folder", () => {
        expect(parseNavInput("#563", noFolder)).toEqual({ target: { pr: "#563" } });
        expect(parseNavInput("https://github.com/acme/app/pull/12", noFolder)).toEqual({
            target: { pr: "https://github.com/acme/app/pull/12" },
        });
        expect(parseNavInput("0751d8a971", noFolder)).toEqual({ target: { commit: "0751d8a971" } });
        expect(parseNavInput("/src/app", (path) => path === "/src/app")).toEqual({ target: { worktree: "/src/app" } });
        expect(parseNavInput("./checkout", (path) => path === "./checkout")).toEqual({
            target: { worktree: resolve("./checkout") },
        });
        expect("error" in parseNavInput("not a place", noFolder)).toBe(true);
        expect("error" in parseNavInput("https://example.org/other?pr=1", noFolder)).toBe(true);
    });

    it("refuses what the hub could not open, and names the place in a few words", () => {
        expect(navTargetProblem({})).toContain("name a place");
        expect(navTargetProblem({ commit: "0751d8a971" })).toContain("--pr");
        expect(navTargetProblem({ pr: "nope" })).toContain("--pr takes");
        expect(navTargetProblem({ repo: "/src/app", commit: "0751d8a971" })).toBeUndefined();
        expect(navTitle({ pr: "563", commit: "0751d8a971ff" })).toBe("PR #563 · commit 0751d8a971");
        expect(navTitle({ pr: "https://github.com/acme/app/pull/12" })).toBe("PR acme/app/pull/12");
        expect(navTitle({ repo: "/src/app", commit: "aaaaaaa..bbbbbbb" })).toBe("commit aaaaaaa..bbbbbbb in app");
        expect(navTitle({ worktree: "/src/app-feature" })).toBe("worktree app-feature");
        expect(navTitle({ mode: "inbox" })).toBe("Inbox");
    });

    it("hands the actor, note, session and entry id to the hub as flags and link keys", () => {
        const args = hubArgs({ pr: "563", actor: "agent", note: "why", from: "s1", nav: "id-1" });
        expect(args).toEqual([
            "--hub",
            "--pr",
            "563",
            "--actor",
            "agent",
            "--note",
            "why",
            "--from",
            "s1",
            "--nav",
            "id-1",
        ]);
        expect(hubUrl({ pr: "563", actor: "agent", note: "a b" })).toBe(
            "genesis-tools://hub?pr=563&actor=agent&note=a%20b"
        );
    });
});

describe("hub data.db", () => {
    it("the first open copies an old navigation.db in and renames it aside", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-hub-data-"));
        try {
            const old = openHubDb(join(dir, "navigation.db"));
            recordNav(old, { id: "n1", at: 1, actor: "agent", title: "PR #1", target: { pr: "1" }, note: "why" });
            old.close();
            const db = openHubDb(join(dir, "data.db"));
            expect(listNav(db).map((entry) => entry.id)).toEqual(["n1"]);
            expect(existsSync(join(dir, "navigation.db"))).toBe(false);
            db.close();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
