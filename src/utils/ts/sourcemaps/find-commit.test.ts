import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestRepo } from "@genesiscz/utils/git/test-repo";
import { SafeJSON } from "@genesiscz/utils/json";
import { normalizeIdentifiers } from "./align.ts";
import { releaseBuildWorktrees } from "./build.ts";
import { SourcemapCache } from "./cache.ts";
import type { DeployedFile } from "./deployed.ts";
import { type FindCommitEvent, type FindCommitOptions, findDeployedCommit } from "./find-commit.ts";

/**
 * One repository, built once. The "build" copies a tracked file that stands in for a bundler's output, so each
 * commit decides the bundle exactly the way it would under a real bundler, and the map names the one source file.
 *
 *   seed -> first -> second -> tweak -> third -> docs
 *
 * `tweak` changes only a comment and adds a lockfile, so it is indistinguishable from `second` by the strings in
 * the bundle. `docs` changes nothing the bundle holds. The deployment is `second`'s bundle.
 */
const BUILD_CMD = "mkdir -p out && cp web/bundle.js out/app.js && cp web/bundle.js.map out/app.js.map";
const MAP = SafeJSON.stringify({ version: 3, sources: ["webpack:///./web/src/msg.ts"], names: [], mappings: "AAAA" });

function filler(tag: string): string {
    return Array.from(
        { length: 36 },
        (_, i) =>
            `function ${tag}${i}(a,b){return a*${i}+b.${tag}Prop${i}+"${tag} filler string number ${i} for padding"}`
    ).join("");
}

const SECOND_OBJECT = 'var m={title:"Second headline text"';

/**
 * A similarity probe is 64 normalized characters taken every 97. The head is padded so that one probe straddles the
 * place `third` adds a field, which is where a build that is not the deployed commit stops matching.
 */
function paddedHead(): string {
    let head = filler("a");

    while (normalizeIdentifiers(head + SECOND_OBJECT).text.length % 97 !== 32) {
        head += ";";
    }

    return head;
}

const HEAD = paddedHead();
const TAIL = filler("b");

function bundle(message: { title: string; other?: string }): string {
    const other = message.other ? `,other:"${message.other}"` : "";

    return `${HEAD}var m={title:"${message.title}"${other}};${TAIL}`;
}

function source(message: { title: string; other?: string; comment?: string }): string {
    const other = message.other ? `, other: "${message.other}"` : "";

    return `${message.comment ?? ""}export const m = { title: "${message.title}"${other} };\n`;
}

const ENV_KEYS = ["VITE_A", "VITE_B", "VITE_C", "VITE_D", "VITE_E", "VITE_F", "VITE_G"];
const INLINED_ENV = `{NODE_ENV:"production",${ENV_KEYS.map((key) => `${key}:"${key.toLowerCase()}"`).join(",")}}`;
const PASSED_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, key.toLowerCase()]));

let repo: TestRepo;
let cache: SourcemapCache;
let sha: Record<"seed" | "first" | "second" | "tweak" | "third" | "docs", string>;
let deployed: { dir: string; files: DeployedFile[] };
let plain: { dir: string; files: DeployedFile[] };
let minified: string;

function deployment(name: string, code: Record<string, string>): { dir: string; files: DeployedFile[] } {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), `gt-find-commit-${name}-`)));

    for (const [path, text] of Object.entries(code)) {
        writeFileSync(join(dir, path), text);
    }

    return {
        dir,
        files: Object.entries(code).map(([path, text]) => ({ url: `file:///${path}`, path, bytes: text.length })),
    };
}

beforeAll(async () => {
    repo = await TestRepo.create({ prefix: "gt-find-commit-" });
    cache = new SourcemapCache("app", join(repo.root, "cache"));
    const seed = await repo.sha();
    const first = await repo.commitMany({
        files: {
            "web/src/msg.ts": source({ title: "First headline text" }),
            "web/bundle.js": bundle({ title: "First headline text" }),
            "web/bundle.js.map": MAP,
        },
        message: "first headline",
    });
    const second = await repo.commitMany({
        files: {
            "web/src/msg.ts": source({ title: "Second headline text" }),
            "web/bundle.js": bundle({ title: "Second headline text" }),
        },
        message: "second headline",
    });
    const tweak = await repo.commitMany({
        files: {
            "web/src/msg.ts": source({ title: "Second headline text", comment: "// reworded\n" }),
            "bun.lock": "lock v1\n",
        },
        message: "reword a comment",
    });
    const third = await repo.commitMany({
        files: {
            "web/src/msg.ts": source({ title: "Second headline text", other: "Third extra label" }),
            "web/bundle.js": bundle({ title: "Second headline text", other: "Third extra label" }),
        },
        message: "third label",
    });
    const docs = await repo.commit({ file: "README.md", content: "docs\n", message: "docs only" });
    sha = { seed, first, second, tweak, third, docs };

    minified = bundle({ title: "Second headline text" }).replace("var m=", "var b=");
    const shas = [second, first, seed].map((value) => `"${value}"`).join(",");
    deployed = deployment("full", { "app.js": `${minified};var __e=${INLINED_ENV};var __r=[${shas}];` });
    plain = deployment("plain", { "app.js": minified });
});

afterAll(async () => {
    await releaseBuildWorktrees();
});

function find(overrides: Partial<FindCommitOptions> & { range: string }) {
    const events: FindCommitEvent[] = [];

    return findDeployedCommit({
        cache,
        repo: repo.dir,
        buildCmd: BUILD_CMD,
        outputDir: "out",
        deployed,
        onEvent: (event) => events.push(event),
        ...overrides,
    }).then((result) => ({ result, events }));
}

describe("findDeployedCommit, tokens strategy", () => {
    test("ranks the span by the strings the bundle carries and confirms the oldest of the best with one build", async () => {
        const { result, events } = await find({ range: `${sha.seed}..${sha.third}` });

        expect(result.strategy).toBe("tokens");
        expect(result.base.commit).toBe(sha.third);
        // The reference build (third) is ranked too: it carries the extra field the deployment lacks.
        expect(result.ranking.map((entry) => [entry.commit, entry.error])).toEqual([
            [sha.tweak, 0],
            [sha.second, 0],
            [sha.first, 1],
            [sha.third, 2],
        ]);
        expect(result.equivalent).toEqual([sha.tweak, sha.second]);
        expect(result.best).toMatchObject({ commit: sha.second, subject: "second headline", error: 0 });
        expect(result.confidence).toBe("verified");
        expect(result.candidates.map((candidate) => candidate.commit)).toEqual([sha.third, sha.second]);
        expect(result.best?.rate).toBe(result.candidates[1].rate);
        expect(result.candidates[1].rate).toBeGreaterThan(result.candidates[0].rate);
        expect(result.buildsUsed).toBe(2);
        expect(events.map((event) => event.type)).toEqual([
            "hints",
            "build-start",
            "build",
            "ranked",
            "build-start",
            "build",
            "scored",
        ]);
    });

    test("says when a lockfile differs and when the next commit fits almost as well", async () => {
        const { result } = await find({ range: `${sha.seed}..${sha.third}`, firstParent: false });

        expect(result.notes).toContain(
            "a lockfile differs from the reference: dependency code is not ranked, only the build checks it"
        );
        expect(result.notes.some((note) => /^the next commit fits almost as well \(error 0 vs \d+\)/.test(note))).toBe(
            true
        );
        expect(result.best?.commit).toBe(sha.second);
    });

    test("compares every commit the bundle names with what the code evidence says", async () => {
        const { result, events } = await find({ range: `${sha.seed}..${sha.third}` });
        const named = (commit: string) => commit.slice(0, 12);

        expect(result.hints.map((hint) => hint.commit).sort()).toEqual([sha.first, sha.second, sha.seed].sort());
        expect(events[0]).toMatchObject({ type: "hints" });
        expect(result.notes).toContain(`the bundle names commit ${named(sha.second)} 1x; the code evidence agrees`);
        expect(result.notes).toContain(
            `the bundle names commit ${named(sha.first)} 1x, but the code evidence points elsewhere; trust the code`
        );
        expect(result.notes).toContain(`the bundle names commit ${named(sha.seed)} 1x; it is outside the range`);
    });

    test("lists the first six inlined env values to pass and points at the command for the rest", async () => {
        const { result } = await find({ range: `${sha.seed}..${sha.third}` });
        const note = result.notes[0];

        expect(note).toContain("the bundle inlines 7 env value(s) this build did not get the same");
        expect(note).toContain("--env VITE_A=vite_a");
        expect(note).toContain("--env VITE_F=vite_f");
        expect(note).not.toContain("--env VITE_G=vite_g");
        expect(note).toContain("(all of them: tools ts sourcemaps env)");
        expect(result.env.map((value) => value.name)).toEqual(["NODE_ENV", ...ENV_KEYS]);
    });

    test("needs no second build when the reference build is the best fit, and stays quiet about env it was given", async () => {
        const { result, events } = await find({
            range: `${sha.seed}..${sha.third}`,
            base: sha.second,
            env: PASSED_ENV,
        });

        expect(result.base.commit).toBe(sha.second);
        expect(result.confidence).toBe("ranked");
        expect(result.best).toMatchObject({ commit: sha.second, error: 0, rate: result.base.rate });
        expect(result.equivalent).toEqual(expect.arrayContaining([sha.tweak, sha.second]));
        expect(result.buildsUsed).toBe(1);
        expect(result.notes.some((note) => note.startsWith("the bundle inlines"))).toBe(false);
        expect(events.map((event) => event.type)).not.toContain("scored");
    });

    test("--no-verify names the best commit but does not build it", async () => {
        const { result } = await find({ range: `${sha.seed}..${sha.third}`, verify: false });

        expect(result.best?.commit).toBe(sha.second);
        expect(result.confidence).toBe("weak");
        expect(result.notes).toContain("not confirmed by a build (--no-verify)");
        expect(result.buildsUsed).toBe(1);
        expect(result.candidates).toHaveLength(1);
    });

    test("finds nothing to rank when no commit of the span changes a string or a name", async () => {
        const { result, events } = await find({
            range: `${sha.third}..${sha.docs}`,
            deployed: plain,
        });

        expect(result.best).toBeNull();
        expect(result.confidence).toBe("weak");
        expect(result.notes).toContain(
            "no string or property name differs between the candidates; use --strategy rebuild"
        );
        expect(events.find((event) => event.type === "ranked")).toMatchObject({ tokens: 0 });
    });

    test("names the deployed chunks the base build has no counterpart for", async () => {
        const withVendor = deployment("vendor", {
            "app.js": minified,
            "vendor.js": 'var v={vendorKey:"vendor library text"};',
        });
        const { result } = await find({ range: `${sha.seed}..${sha.third}`, deployed: withVendor });

        expect(result.base.deployedOnly).toEqual(["vendor.js"]);
        expect(result.notes).toContain(
            "1 deployed chunk(s) have no counterpart in the base build (the chunk set changed in the range)"
        );
        expect(result.best?.commit).toBe(sha.second);
    });

    test("does not call a commit verified when its build is no closer to the deployment than the reference", async () => {
        // Shifting the deployment moves the probes off the place the two builds differ, so both score alike.
        const shifted = deployment("shifted", { "app.js": `${";".repeat(40)}${minified}` });
        const { result } = await find({ range: `${sha.seed}..${sha.third}`, deployed: shifted });

        expect(result.best?.commit).toBe(sha.second);
        expect(result.confidence).toBe("weak");
        expect(result.candidates[1].rate).toBe(result.candidates[0].rate);
        expect(result.notes.at(-1)).toMatch(
            /^the best-ranked commit builds no closer to the deployment than the reference \(\d+\.\d{3}% vs \d+\.\d{3}%\); check with --strategy rebuild$/
        );
    });

    test("bounds the deployed file's Last-Modified against the commit dates and says how many commits are newer", async () => {
        const secondTime = (await repo.git(["log", "-1", "--format=%cI", sha.second])).trim();
        const files = deployed.files.map((file) => ({ ...file, lastModified: secondTime }));
        const { result } = await find({ range: `${sha.seed}..${sha.third}`, deployed: { dir: deployed.dir, files } });
        const at = new Date(Date.parse(secondTime)).toISOString().slice(0, 16).replace("T", " ");

        expect(result.deployedAt).toBe(new Date(Date.parse(secondTime)).toISOString());
        expect(result.notes).toContain(
            `the deployed JS was last modified ${at} UTC (newest Last-Modified); 2 commit(s) in the range are newer, so they cannot be the build if the server keeps upload times`
        );
        expect(result.notes.some((note) => note.startsWith("the best commit is NEWER"))).toBe(false);
    });

    test("flags a best commit that is newer than the deployed file's Last-Modified", async () => {
        const firstTime = (await repo.git(["log", "-1", "--format=%cI", sha.first])).trim();
        const files = deployed.files.map((file) => ({ ...file, lastModified: firstTime }));
        const { result } = await find({ range: `${sha.seed}..${sha.third}`, deployed: { dir: deployed.dir, files } });

        expect(result.best?.commit).toBe(sha.second);
        expect(result.notes).toContain(
            "the best commit is NEWER than the deployed files: either the server rewrites Last-Modified, or the ranking is wrong; build the oldest commit of the span to check"
        );
    });

    test("records no deployment date when the server sent no Last-Modified", async () => {
        const { result } = await find({ range: `${sha.seed}..${sha.third}`, base: sha.second });

        expect(result.deployedAt).toBeNull();
        expect(result.notes.some((note) => note.includes("last modified"))).toBe(false);
    });
});

describe("findDeployedCommit, rebuild strategy", () => {
    test("traces the differing code to its source file and builds every commit that touched it", async () => {
        const { result, events } = await find({
            range: `${sha.seed}..${sha.third}`,
            strategy: "rebuild",
            deployed: plain,
        });

        expect(result.strategy).toBe("rebuild");
        expect(result.changedFiles).toEqual(["web/src/msg.ts"]);
        expect(result.candidates.map((candidate) => candidate.commit).sort()).toEqual(
            [sha.first, sha.second, sha.tweak, sha.third].sort()
        );
        expect(result.confidence).toBe("rebuilt");
        expect(result.best?.commit).toBe(sha.tweak);
        expect(result.best?.error).toBeNull();
        expect(result.best?.rate).toBe(1);
        expect(result.equivalent).toEqual([sha.tweak]);
        expect(result.notes).toContain(
            `${sha.tweak.slice(0, 12)} and ${sha.second.slice(0, 12)} score the same; the evidence cannot separate them`
        );
        expect(result.buildsUsed).toBe(4);
        expect(events.find((event) => event.type === "changed-files")).toMatchObject({
            files: ["web/src/msg.ts"],
        });
        expect(events.find((event) => event.type === "candidates")).toMatchObject({
            commits: [sha.third, sha.tweak, sha.second, sha.first],
        });
        expect(events.filter((event) => event.type === "scored")).toHaveLength(4);
    });

    test("counts a difference it cannot trace when the build has no source map", async () => {
        const { result } = await find({
            range: `${sha.seed}..${sha.third}`,
            strategy: "rebuild",
            deployed: plain,
            // The worktree is shared between recipes, so a map an earlier build left in out/ must go first.
            buildCmd: "rm -rf out && mkdir out && cp web/bundle.js out/app.js",
        });

        expect(result.unmappedRegions).toBeGreaterThan(0);
        expect(result.changedFiles).toEqual([]);
        expect(result.candidates.map((candidate) => candidate.commit)).toEqual([sha.third]);
    });

    test("counts a difference at the very start of the file as injected code, not as a changed file", async () => {
        const shifted = deployment("injected", { "app.js": `${";".repeat(40)}${minified}` });
        const { result } = await find({ range: `${sha.seed}..${sha.third}`, strategy: "rebuild", deployed: shifted });

        expect(result.unmappedRegions).toBe(1);
        expect(result.changedFiles).toEqual([]);
    });

    test("adds the lockfiles as candidates when the differing code comes from node_modules", async () => {
        const dependencyMap = SafeJSON.stringify({
            version: 3,
            sources: ["webpack:///./node_modules/dep/index.js"],
            names: [],
            mappings: "AAAA",
        });
        const { result } = await find({
            range: `${sha.seed}..${sha.third}`,
            strategy: "rebuild",
            deployed: plain,
            buildCmd: `mkdir -p out && cp web/bundle.js out/app.js && printf '%s' '${dependencyMap}' > out/app.js.map`,
        });

        expect(result.changedFiles).toEqual(["bun.lock"]);
        expect(result.notes).toContain(
            "some differing code comes from node_modules, so lockfile changes count as candidates"
        );
        expect(result.candidates.map((candidate) => candidate.commit).sort()).toEqual([sha.tweak, sha.third].sort());
        expect(result.best?.commit).toBe(sha.tweak);
    });

    test("builds only the newest candidates when more commits touch the files than --max-builds allows", async () => {
        const { result } = await find({
            range: `${sha.seed}..${sha.third}`,
            strategy: "rebuild",
            deployed: plain,
            maxBuilds: 1,
        });

        expect(result.notes).toContain("4 commits touch the changed files; only the newest 1 were built");
        expect(result.candidates.map((candidate) => candidate.commit)).toEqual([sha.third]);
        expect(result.best?.commit).toBe(sha.third);
    });

    test("stops before scoring a candidate when the signal is already aborted", async () => {
        const { result } = await find({
            range: `${sha.seed}..${sha.third}`,
            strategy: "rebuild",
            deployed: plain,
            signal: AbortSignal.abort(),
        });

        expect(result.notes).toContain("stopped early (aborted)");
        expect(result.candidates).toEqual([]);
        expect(result.best).toBeNull();
        expect(result.confidence).toBe("weak");
    });

    test("names the reference build as the answer and traces no file when the deployment matches it", async () => {
        const { result } = await find({
            range: `${sha.seed}..${sha.third}`,
            strategy: "rebuild",
            base: sha.second,
            deployed: plain,
        });

        expect(result.changedFiles).toEqual([]);
        expect(result.candidates.map((candidate) => candidate.commit)).toEqual([sha.second]);
        expect(result.best).toMatchObject({ commit: sha.second, rate: 1 });
        expect(result.candidates[0].rate).toBe(1);
        expect(result.confidence).toBe("rebuilt");
    });
});

describe("findDeployedCommit, bad ranges", () => {
    test("a range without two ends is a usage error naming the input", async () => {
        await expect(find({ range: "nope" })).rejects.toThrow("--range must look like A..B, got 'nope'");
        await expect(find({ range: `${sha.third}..` })).rejects.toThrow("--range must look like A..B");
    });

    test("a range with no commits in it is an error that names the range", async () => {
        await expect(find({ range: `${sha.third}..${sha.third}` })).rejects.toThrow(
            `the range ${sha.third}..${sha.third} has no commits`
        );
    });
});
