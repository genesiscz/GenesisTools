import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "@genesiscz/utils/paths";
import {
    checkoutsAt,
    discoverCheckouts,
    projectRefFromUrl,
    rankCheckouts,
    remoteUrlFromConfig,
} from "./local-checkouts";

const base = makeTempDir("local-checkouts-");

afterAll(() => {
    rmSync(base, { recursive: true, force: true });
});

function write(path: string, text: string): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
}

/** A main checkout plus one linked worktree, laid out the way git writes them. */
function fakeRepo({ root, remote, branch }: { root: string; remote: string; branch: string }): void {
    const git = join(root, ".git");
    write(join(git, "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/*\n`);
    write(join(git, "HEAD"), `ref: refs/heads/${branch}\n`);
}

function fakeWorktree({ main, wt, name, branch }: { main: string; wt: string; name: string; branch: string }): void {
    const admin = join(main, ".git", "worktrees", name);
    write(join(admin, "gitdir"), `${join(wt, ".git")}\n`);
    write(join(admin, "HEAD"), `ref: refs/heads/${branch}\n`);
    write(join(admin, "commondir"), "../..\n");
    write(join(wt, ".git"), `gitdir: ${admin}\n`);
}

const app = join(base, "projects", "app");
const appWt = join(base, "worktrees", "app-feat");
const other = join(base, "projects", "group", "other");

fakeRepo({ root: app, remote: "git@gitlab.internal.example:group/app.git", branch: "main" });
fakeWorktree({ main: app, wt: appWt, name: "app-feat", branch: "feat/login" });
fakeRepo({ root: other, remote: "https://github.com/o/r.git", branch: "master" });
mkdirSync(join(base, "projects", "node_modules", "hidden", ".git"), { recursive: true });

describe("projectRefFromUrl", () => {
    it("normalizes remote and web URLs to one project", () => {
        const expected = { host: "gitlab.internal.example", path: "group/app" };
        expect(projectRefFromUrl("git@gitlab.internal.example:group/app.git")).toEqual(expected);
        expect(projectRefFromUrl("ssh://git@gitlab.internal.example:2222/group/app.git")).toEqual(expected);
        expect(projectRefFromUrl("https://gitlab.internal.example/Group/App")).toEqual(expected);
    });

    it("returns null without a project path", () => {
        expect(projectRefFromUrl("https://github.com/")).toBeNull();
    });

    it("returns null for a remote it cannot parse instead of throwing", () => {
        expect(projectRefFromUrl("git@host.example:team/100%.git")).toBeNull();
        expect(projectRefFromUrl("git@bad host.example:team/app.git")).toBeNull();
    });
});

describe("remoteUrlFromConfig", () => {
    it("prefers origin, else the first remote", () => {
        const config = '[remote "upstream"]\n\turl = u\n[remote "origin"]\n\turl = o\n';
        expect(remoteUrlFromConfig(config)).toBe("o");
        expect(remoteUrlFromConfig('[remote "fork"]\n url = f\n')).toBe("f");
        expect(remoteUrlFromConfig("[core]\n")).toBeNull();
    });
});

describe("discoverCheckouts", () => {
    const found = discoverCheckouts({ roots: [join(base, "projects")] });

    it("finds main checkouts and their linked worktrees, skipping node_modules", () => {
        const roots = found.map((checkout) => checkout.root).sort();
        expect(roots).toEqual([app, other, appWt].sort());
    });

    it("reads each checkout's branch", () => {
        const wt = found.find((checkout) => checkout.root === appWt);
        expect(wt?.branch).toBe("feat/login");
        expect(wt?.isMain).toBe(false);
    });

    it("finds the same repo from a worktree folder", () => {
        expect(checkoutsAt(appWt).map((checkout) => checkout.root)).toEqual([app, appWt]);
    });

    it("ranks the worktree on the requested branch first, then the main checkout", () => {
        const project = { host: "gitlab.internal.example", path: "group/app" };
        const onBranch = rankCheckouts({ project, checkouts: found, branch: "feat/login" });
        expect(onBranch.map((checkout) => checkout.root)).toEqual([appWt, app]);
        const noBranch = rankCheckouts({ project, checkouts: [...found, ...found] });
        expect(noBranch.map((checkout) => checkout.root)).toEqual([app, appWt]);
    });
});
