import { afterEach, describe, expect, test } from "bun:test";
import { TestRepo } from "@genesiscz/utils/git/test-repo";
import { skip } from "@genesiscz/utils/test/skip";

const created: TestRepo[] = [];

async function makeRepo(branch: string): Promise<TestRepo> {
    const repo = await TestRepo.create({ branch, prefix: "gt-repo-template-collision-" });
    created.push(repo);

    return repo;
}

afterEach(() => {
    for (const repo of created.splice(0)) {
        repo.cleanup();
    }
});

describe.skipIf(skip.onWindows)("TestRepo template cache", () => {
    /**
     * 🛑 The cache directory name is derived from the shape, and the derivation used to be
     * `shape.replace(/[^a-z0-9]+/gi, "-")`. That collapses BOTH `/` and `-` to the same
     * character, so `feature/a::true` and `feature-a::true` named one directory.
     *
     * The in-process `repoTemplates` Map keys on the full shape, so the second branch missed
     * the cache, rebuilt, and then `cpSync`'d itself over the FIRST branch's template. Every
     * later `feature/a` request was a cache hit on a template that now held `feature-a`, and
     * the caller silently received a repo on the wrong branch.
     *
     * Raised by CodeRabbit on PR #392.
     */
    test("branch names that sanitise alike do not share one template directory", async () => {
        const slash = await makeRepo("feature/a");
        expect((await slash.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature/a");

        // Populates the colliding path. Before the fix this overwrote the template above.
        const dash = await makeRepo("feature-a");
        expect((await dash.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature-a");

        // A cache HIT for the first shape. It must still be the branch that was cached.
        const again = await makeRepo("feature/a");
        expect((await again.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature/a");
    }, 60_000);

    /**
     * The negative control: the cache must still BE a cache. A second repo of an identical
     * shape has to come back correct, or a "fix" that simply disabled caching would pass the
     * case above while quietly making every suite slower.
     */
    test("a repeated shape is served from the template and is still correct", async () => {
        const first = await makeRepo("release/2026");
        const second = await makeRepo("release/2026");

        expect((await second.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("release/2026");
        // The seed commit is copied with the template, so both carry it.
        expect((await second.git(["log", "--oneline"])).trim()).toContain("seed");
        expect(second.dir).not.toBe(first.dir);
    }, 60_000);
});
