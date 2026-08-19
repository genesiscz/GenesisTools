import { describe, expect, test } from "bun:test";
import { checkSource, pluginsDisabledFor } from "./lint-rules";

/**
 * These pin the behaviour of the six GritQL plugins this checker replaced.
 *
 * Every POSITIVE case was verified to be flagged by the original plugins, and
 * every NEGATIVE case to be left alone by them, before the plugins were removed
 * from biome.json. The negatives matter more than the positives here: a first
 * cut of this checker tested string literals without their context and
 * condemned 317 lines of correct code, 158 of them the sanctioned
 * `join(env.tools.getHome(), ".genesis-tools", …)`.
 */

function rules(source: string, file = "src/example.ts"): string[] {
    return checkSource(file, source).map((f) => f.rule);
}

describe("no-hardcoded-tmp", () => {
    test("flags a /tmp literal in the binding contexts GritQL enumerated", () => {
        expect(rules('const p = "/tmp/x";')).toContain("no-hardcoded-tmp");
        expect(rules('foo("/tmp/x");')).toContain("no-hardcoded-tmp");
        expect(rules('return "/tmp/x";')).toContain("no-hardcoded-tmp");
    });

    test("also flags contexts GritQL could not reach — the reason it missed real bugs", () => {
        // An object property. `videoOut: "/tmp/run.mp4"` sat in the repo
        // unflagged because no GritQL pattern covered this position.
        expect(rules('const plan = { videoOut: "/tmp/run.mp4" };')).toContain("no-hardcoded-tmp");
        expect(rules('const p = process.env.X ?? "/tmp/db.sqlite";')).toContain("no-hardcoded-tmp");
    });

    test("leaves bare /tmp and other paths alone", () => {
        expect(rules('const p = "/tmp";')).toEqual([]);
        expect(rules('const p = "/var/tmp/x";')).toEqual([]);
    });

    test("honours the suppression comment", () => {
        expect(rules('// lint-rules-ignore: fixture\nconst p = "/tmp/x";')).toEqual([]);
        expect(rules('const p = "/tmp/x"; // lint-rules-ignore: fixture')).toEqual([]);
    });

    test("does NOT honour biome's own marker, which biome would then call unused", () => {
        expect(rules('// biome-ignore lint/plugin: stale\nconst p = "/tmp/x";')).toContain("no-hardcoded-tmp");
    });
});

describe("no-hardcoded-user-paths", () => {
    test("flags an absolute /Users path", () => {
        expect(rules('const p = "/Users/martin/Projects/x";')).toContain("no-hardcoded-user-paths");
    });

    test("reports it as a warning, matching the original severity", () => {
        const [finding] = checkSource("src/example.ts", 'const p = "/Users/martin/x";');
        expect(finding.severity).toBe("warn");
    });

    test("leaves a bare /Users prefix alone", () => {
        expect(rules('const p = "/UsersGuide";')).toEqual([]);
    });
});

describe("no-homedir-genesis-tools", () => {
    test("flags the data directory reached through homedir()", () => {
        expect(rules('const d = join(homedir(), ".genesis-tools", "daemon");')).toContain("no-homedir-genesis-tools");
    });

    test("flags a template that builds the same path", () => {
        expect(rules("const d = `${homedir()}/.genesis-tools/daemon`;")).toContain("no-homedir-genesis-tools");
    });

    test("LEAVES the sanctioned env.tools.getHome() form alone", () => {
        // 158 sites use this. Flagging it would condemn the correct code and
        // make the rule unusable.
        expect(rules('const d = join(env.tools.getHome(), ".genesis-tools", "daemon");')).toEqual([]);
    });

    test("LEAVES LaunchAgent plist names alone", () => {
        // `com.genesis-tools.daemon.plist` contains the string but is not the
        // data directory, and homedir() is correct for ~/Library/LaunchAgents.
        expect(
            rules('const p = join(homedir(), "Library", "LaunchAgents", "com.genesis-tools.daemon.plist");')
        ).toEqual([]);
    });
});

describe("no-direct-prompt-backend", () => {
    test("flags a direct backend call", () => {
        expect(rules("await inquirerBackend.select({});")).toContain("no-direct-prompt-backend");
        expect(rules("await clackBackend.confirm({});")).toContain("no-direct-prompt-backend");
    });

    test("leaves the p facade and unrelated methods alone", () => {
        expect(rules("await p.select({});")).toEqual([]);
        expect(rules("await inquirerBackend.dispose();")).toEqual([]);
    });
});

describe("no-mock-module-prompts", () => {
    test("flags a mocked prompt module", () => {
        expect(rules('mock.module("@genesiscz/utils/prompts/p", () => ({}));')).toContain("no-mock-module-prompts");
        expect(rules('mock.module("inquirer/prompts", () => ({}));')).toContain("no-mock-module-prompts");
    });

    test("leaves other mocked modules alone", () => {
        expect(rules('mock.module("node:fs", () => ({}));')).toEqual([]);
    });
});

describe("the biome.json override that disabled plugins for tests", () => {
    /**
     * biome.json carries `{"includes": ["**\/*.test.ts", …], "plugins": []}`, so
     * the GritQL rules never ran on tests. Test files legitimately hardcode
     * /tmp paths and call prompt backends directly; without this the checker
     * reported 300+ findings the originals allowed by design.
     */
    test("skips the same files", () => {
        expect(pluginsDisabledFor("src/foo.test.ts")).toBe(true);
        expect(pluginsDisabledFor("src/foo.test.tsx")).toBe(true);
        expect(pluginsDisabledFor("src/__tests__/foo.ts")).toBe(true);
        expect(pluginsDisabledFor("src/foo.data.ts")).toBe(true);
        expect(pluginsDisabledFor("src/foo.ts")).toBe(false);
    });

    test("a /tmp literal in a test file is not reported", () => {
        expect(rules('const p = "/tmp/x";', "src/foo.test.ts")).toEqual([]);
    });
});

describe("tsx and plain js", () => {
    test("parses .tsx", () => {
        expect(rules('const C = () => <div data-p="/tmp/x" />;', "src/c.tsx")).toContain("no-hardcoded-tmp");
    });

    test("parses every extension the file lister passes in", () => {
        // langFor and targetFiles must agree: a tracked .mts or .cts that one
        // accepts and the other never lists bypasses all six rules.
        for (const file of ["src/a.ts", "src/a.tsx", "src/a.mts", "src/a.cts", "src/a.js", "src/a.mjs", "src/a.cjs"]) {
            expect(rules('const p = "/tmp/x";', file)).toContain("no-hardcoded-tmp");
        }
    });

    test("ignores non-source files", () => {
        expect(rules('const p = "/tmp/x";', "README.md")).toEqual([]);
    });
});
