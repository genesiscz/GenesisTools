import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scanShell } from "../scan";
import { biomeRules, biomeUnsafeDeletesComments } from "./biome";
import { detectShellViolations, renderViolation, renderViolations, ruleById, SHELL_RULES } from "./index";
import { swiftpmRules, swiftpmStalePlan } from "./swiftpm";

/** The repository root: a rule that reads the project resolves its `wrong` example against it. */
const REPO_ROOT = resolve(import.meta.dir, "../../../..");

describe("the registry", () => {
    it("has unique, kebab-case ids", () => {
        const ids = SHELL_RULES.map((r) => r.id);

        expect(new Set(ids).size).toBe(ids.length);

        for (const id of ids) {
            expect(id).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
        }
    });

    it("every rule is self-explaining: title, causal why, wrong, right, evidence, severity", () => {
        for (const rule of SHELL_RULES) {
            expect(rule.title.length).toBeGreaterThan(20);
            expect(rule.why.length).toBeGreaterThan(80);
            expect(rule.wrong.length).toBeGreaterThan(5);
            expect(rule.right.length).toBeGreaterThan(5);
            expect(rule.evidence?.length ?? 0).toBeGreaterThan(20);
            expect(["block", "context", "warn"]).toContain(rule.severity);
            expect(["misread", "destructive"]).toContain(rule.kind);
        }
    });

    it("every rule's own `wrong` example trips that rule, and its `right` example does not", () => {
        for (const rule of SHELL_RULES) {
            const wrong = detectShellViolations(rule.wrong, [rule], { cwd: REPO_ROOT });
            const right = detectShellViolations(rule.right, [rule], { cwd: REPO_ROOT });

            expect(wrong.map((v) => v.ruleId)).toEqual([rule.id]);
            expect(right).toEqual([]);
        }
    });

    it("ruleById finds a rule and returns undefined otherwise", () => {
        expect(ruleById("rg-replace-cluster")?.severity).toBe("block");
        expect(ruleById("nope")).toBeUndefined();
    });

    it("ruleById round-trips every registered rule", () => {
        for (const rule of SHELL_RULES) {
            expect(ruleById(rule.id)?.id).toBe(rule.id);
        }
    });

    it("holds the twenty-two general rules; personal ones load from guard.customRules", () => {
        expect(SHELL_RULES.map((r) => r.id).sort()).toEqual(
            [
                "bare-log-command",
                "biome-unsafe-deletes-comments",
                "dd-skip-silent-short-read",
                "docker-volume-destroy",
                "exit-code-after-grep",
                "exit-code-after-pipeline",
                "exit-code-after-pipeline-checked",
                "find-from-root",
                "git-checkout-in-fresh-worktree",
                "git-checkout-overwrites-file",
                "git-checkout-overwrites-saved-file",
                "git-push-force-without-lease",
                "pipestatus-index-mismatch",
                "pipestatus-under-zsh",
                "rg-replace-cluster",
                "search-from-root",
                "stderr-discarded-then-counted",
                "stderr-discarded-then-counted-covered",
                "stderr-discarded-then-counted-scratch",
                "stderr-discarded-then-read",
                "swiftpm-stale-plan",
                "zsh-glob-qualifier",
            ].sort()
        );
    });
});

describe("detectShellViolations: the array", () => {
    it("returns an empty array for a clean command", () => {
        expect(detectShellViolations("git status --short")).toEqual([]);
        expect(detectShellViolations("")).toEqual([]);
    });

    it("returns one violation per rule that fired, each with matched and index into the ORIGINAL command", () => {
        const command = "git checkout -- a.ts; ls x 2>/dev/null | head; cmd | tail; echo $?";
        const violations = detectShellViolations(command);

        expect(violations.map((v) => v.ruleId)).toEqual([
            "git-checkout-overwrites-file",
            "exit-code-after-pipeline",
            "stderr-discarded-then-read",
        ]);

        for (const v of violations) {
            expect(command.slice(v.index, v.index + v.matched.length)).toBe(v.matched);
        }

        expect(violations[0]).toMatchObject({ severity: "block", matched: "git checkout -- a.ts", index: 0 });
        expect(violations[1]).toMatchObject({
            severity: "block",
            matched: "cmd | tail",
            index: command.indexOf("cmd | tail"),
        });
        expect(violations[2]).toMatchObject({
            severity: "context",
            matched: "ls x 2>/dev/null | head",
            index: command.indexOf("ls x"),
        });
    });

    it("orders blocks first, then warns, then context, and by index within a severity", () => {
        const command = "ls a 2>/dev/null | head; rg -rn foo; git checkout -- x";
        const violations = detectShellViolations(command);

        expect(violations.map((v) => `${v.severity}:${v.ruleId}@${v.index}`)).toEqual([
            "block:rg-replace-cluster@28",
            "block:git-checkout-overwrites-file@37",
            "context:stderr-discarded-then-read@0",
        ]);
    });

    it("carries the rule's static fields onto every violation", () => {
        const [v] = detectShellViolations("ls x 2>/dev/null | wc -l");
        const rule = ruleById("stderr-discarded-then-counted");

        expect(v.title).toBe(rule?.title ?? "");
        expect(v.why).toBe(rule?.why ?? "");
        expect(v.wrong).toBe(rule?.wrong ?? "");
        expect(v.right).toBe(rule?.right ?? "");
        expect(v.evidence).toBe(rule?.evidence);
    });

    it("offers the caller's command corrected as `suggestion` only when derivable", () => {
        expect(detectShellViolations("ls x 2>/dev/null | wc -l")[0].suggestion).toBe("ls x | wc -l");
        expect(detectShellViolations("rg -rn foo src")[0].suggestion).toBe("rg -n foo src");
        expect(detectShellViolations("ls *.log(N)")[0].suggestion).toBeUndefined();
        expect(detectShellViolations("docker volume prune -f")[0].suggestion).toBeUndefined();
    });

    it("the suggestion is never applied: the array is data, the command is untouched", () => {
        const command = "ls x 2>/dev/null | wc -l";
        const before = command;

        detectShellViolations(command);

        expect(command).toBe(before);
    });

    it("never throws, even on a rule that crashes", () => {
        const broken = {
            id: "broken",
            kind: "misread" as const,
            title: "a rule that throws",
            severity: "block" as const,
            why: "x".repeat(100),
            wrong: "x",
            right: "y",
            detect() {
                throw new Error("boom");
            },
        };

        expect(detectShellViolations("ls", [broken])).toEqual([]);
        expect(detectShellViolations("cmd | tail; echo $?", [broken, ...SHELL_RULES]).map((v) => v.ruleId)).toEqual([
            "exit-code-after-pipeline",
        ]);
    });

    it("handles garbage input", () => {
        const garbage = Array.from({ length: 3000 }, (_, i) => String.fromCharCode(i % 256)).join("");

        expect(() => detectShellViolations(garbage)).not.toThrow();
        expect(() => detectShellViolations(")))((( | tail ; echo $? $(((")).not.toThrow();
    });

    it("keeps literal violations after escaped or quoted commands, substitutions, and comments", () => {
        const prefixes = [
            String.raw`r\g -rn foo`,
            'r""g -rn foo',
            '"rg" -rn foo',
            "'rg' -rn foo",
            String.raw`g\it checkout -- file.ts`,
            '"git" checkout -- file.ts',
            String.raw`f\ind / -name x`,
            'f""d pattern /',
            String.raw`ls a 2>/dev/n\ull | wc -l`,
            'ls a 2>"/dev/null" | wc -l',
            'ls a 2>/dev/""null | wc -l',
            String.raw`echo $(r\g -rn foo)`,
            "echo $(printf '%s' \"$(date)\")",
            "bash -c 'printf harmless'",
            "# rg -rn ignored; git checkout -- ignored",
            "printf '%s' 'rg -rn ignored; docker volume prune'",
        ];
        const targets = [
            "rg -rn foo",
            "find / -name fixture",
            "fd fixture /",
            "git checkout -- fixture.ts",
            "git push --force",
            "log show",
            "rg -l token ~",
            "docker volume prune -f",
            "ls a 2>/dev/null | wc -l",
            "ls a 2>/dev/null | head",
        ];

        for (const prefix of prefixes) {
            for (const target of targets) {
                const separator = `${prefix}\n`;
                const expected = detectShellViolations(target).map(({ suggestion: _suggestion, ...violation }) => ({
                    ...violation,
                    index: separator.length + violation.index,
                }));
                const actual = detectShellViolations(separator + target).map(
                    ({ suggestion: _suggestion, ...violation }) => violation
                );

                expect(expected.length).toBeGreaterThan(0);
                expect(actual).toEqual(expected);
            }
        }
    });

    it("keeps command-shaped quoted data and comments quiet while scanning executable shell bodies", () => {
        const quoted = [
            "echo 'rg -rn foo; git checkout -- fixture.ts'",
            'printf "%s" "docker volume prune; php artisan migrate:fresh"',
            "# find / -name fixture; log show\nprintf harmless",
            "echo 'ls a 2>/dev/null | wc -l'",
        ];

        for (const command of quoted) {
            expect(detectShellViolations(command)).toEqual([]);
        }

        for (const command of [
            "echo $(echo $(rg -rn foo))",
            "bash -c 'rg -rn foo'",
            "bash -c 'bash -c \"rg -rn foo\"'",
        ]) {
            expect(detectShellViolations(command).map((violation) => violation.ruleId)).toEqual(["rg-replace-cluster"]);
        }
    });

    it("scans a 5000-line script with every rule in well under the hook budget", () => {
        const lines: string[] = [];

        for (let i = 0; i < 5000; i++) {
            lines.push(`echo "line ${i} $(date) $HOME" | sed 's/x/y/' > /tmp/out-${i}.txt 2>&1`);
        }

        lines.push("final | tail; echo $?");
        // CPU time, not wall time: on 2026-09-16 the same call measured 85 ms and
        // 2.7 s in consecutive runs on a machine with a load average of 256. The
        // scheduler is not what this test measures.
        const started = process.cpuUsage();
        const result = detectShellViolations(lines.join("\n"));
        const used = process.cpuUsage(started);
        const cpuMs = (used.user + used.system) / 1000;

        expect(result.map((v) => v.ruleId)).toEqual(["exit-code-after-pipeline"]);
        expect(cpuMs).toBeLessThan(400);
    });
});

describe("rendering", () => {
    it("renders one violation with what, where, why, wrong, right and the corrected command", () => {
        const [v] = detectShellViolations("ls ~/Downloads/*.har 2>/dev/null | wc -l");
        const text = renderViolation(v);

        expect(text).toContain(
            "[block] 2>/dev/null then a count: a failure reads as 0 or a blank (rule stderr-discarded-then-counted)"
        );
        expect(text).toContain("matched (offset 0): ls ~/Downloads/*.har 2>/dev/null | wc -l");
        expect(text).toContain("why: stderr is discarded");
        expect(text).toContain("wrong: ls ~/Downloads/*.har 2>/dev/null | wc -l");
        expect(text).toContain("right: ls ~/Downloads/*.har | wc -l");
        expect(text).toContain("your command, corrected:\nls ~/Downloads/*.har | wc -l");
    });

    it("omits the corrected line when there is no suggestion", () => {
        const [v] = detectShellViolations("docker volume prune -f");

        expect(renderViolation(v)).not.toContain("your command, corrected");
    });

    it("renders a heading plus every violation, and nothing for an empty array", () => {
        const violations = detectShellViolations("cmd | tail; echo $?; ls x 2>/dev/null | wc -l");
        const text = renderViolations(violations, "Blocked:");

        expect(text.startsWith("Blocked:\n[block]")).toBe(true);
        expect(text.split("\n[block]").length).toBe(3);
        expect(renderViolations([], "Blocked:")).toBe("");
    });

    it("never clips: a long matched excerpt and the whole corrected command are rendered in full", () => {
        const command = `${"x".repeat(1000)} 2>/dev/null | wc -l`;
        const text = renderViolation(detectShellViolations(command)[0]);

        expect(text).toContain(`matched (offset 0): ${command}`);
        expect(text).toContain(`your command, corrected:\n${"x".repeat(1000)} | wc -l`);
    });
});

describe("swiftpm-stale-plan", () => {
    // Two packages side by side: `app` uses `kit` by path, `kit` has no local dependency.
    const root = mkdtempSync(join(tmpdir(), "swiftpm-rule-"));
    const app = join(root, "app");
    const kit = join(root, "kit");
    const named = join(root, "named");
    mkdirSync(app);
    mkdirSync(kit);
    mkdirSync(named);
    writeFileSync(
        join(app, "Package.swift"),
        'let package = Package(name: "App", dependencies: [.package(path: "../kit")])\n'
    );
    writeFileSync(join(kit, "Package.swift"), 'let package = Package(name: "Kit", targets: [.target(name: "Kit")])\n');
    writeFileSync(
        join(named, "Package.swift"),
        'let package = Package(name: "Named", dependencies: [.package(name: "Kit", path: "../kit")])\n'
    );

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    function fires(command: string, cwd = root): boolean {
        return detectShellViolations(command, swiftpmRules, { cwd }).length > 0;
    }

    it("fires for a package with a path dependency and inserts the flag after the subcommand", () => {
        const [violation] = detectShellViolations(
            `swift test --package-path ${app} --filter WidgetTests`,
            swiftpmRules,
            {
                cwd: root,
            }
        );

        expect(violation?.severity).toBe("block");
        expect(violation?.suggestion).toBe(
            `swift test --disable-build-manifest-caching --package-path ${app} --filter WidgetTests`
        );
        expect(fires("swift build --package-path app")).toBe(true);
        expect(fires(`swift run --package-path=${app} App --samples`)).toBe(true);
        expect(fires("/usr/bin/swift build --package-path ./app")).toBe(true);
        expect(fires("swift build", app)).toBe(true);
        expect(fires("swift test", named)).toBe(true);
    });

    it("never throws on a quoted subcommand, which the cleaned text blanks, and leaves it alone", () => {
        const scan = scanShell(`swift "test" --package-path ${app}`, root);

        expect(() => swiftpmStalePlan.detect(scan)).not.toThrow();
        expect(swiftpmStalePlan.detect(scan)).toBeNull();
    });

    it("follows a cd earlier in the same command", () => {
        const [violation] = detectShellViolations(`cd ${app} && swift test 2>&1 | tail -5`, swiftpmRules, { cwd: kit });

        expect(violation?.suggestion).toBe(`cd ${app} && swift test --disable-build-manifest-caching 2>&1 | tail -5`);
        expect(fires(`cd ${kit} && swift build`, app)).toBe(false);
    });

    it("stays quiet with the flag, without a path dependency, or when nothing builds", () => {
        expect(fires(`swift test --package-path ${app} --disable-build-manifest-caching`)).toBe(false);
        expect(fires(`swift test --package-path ${kit}`)).toBe(false);
        expect(fires("swift build --show-bin-path", app)).toBe(false);
        expect(fires("swift package describe --type json", app)).toBe(false);
        expect(fires('cd "$PACKAGE" && swift test')).toBe(false);
        expect(fires(`swift test --package-path ${join(root, "missing")}`)).toBe(false);
    });
});

describe("biome-unsafe-deletes-comments", () => {
    const fired = (command: string) =>
        detectShellViolations(command, biomeRules).map((violation) => violation.suggestion ?? violation.ruleId);
    const SKIP = "--skip=correctness/noUnusedImports";

    it("blocks the unsafe fix through every runner and keeps --unsafe with noUnusedImports skipped", () => {
        expect(fired("bunx biome check --write --unsafe src/alza/lib/pc-build.ts")).toEqual([
            `bunx biome check --write --unsafe ${SKIP} src/alza/lib/pc-build.ts`,
        ]);
        expect(fired("cd app && npx @biomejs/biome check --fix --unsafe .")).toEqual([
            `cd app && npx @biomejs/biome check --fix --unsafe ${SKIP} .`,
        ]);
        expect(fired("bun x biome check --write --unsafe a.ts | tail -3")).toEqual([
            `bun x biome check --write --unsafe ${SKIP} a.ts | tail -3`,
        ]);
    });

    it("drops --unsafe when --only names noUnusedImports itself, since the run is that rule", () => {
        expect(fired("bunx biome lint --only=correctness/noUnusedImports --write --unsafe src")).toEqual([
            "bunx biome lint --only=correctness/noUnusedImports --write src",
        ]);
        expect(fired("bunx biome lint --only lint/correctness/noUnusedImports --write --unsafe src")).toEqual([
            "bunx biome lint --only lint/correctness/noUnusedImports --write src",
        ]);
        expect(fired("bunx biome lint --only=noUnusedImports --write --unsafe src")).toEqual([
            "bunx biome lint --only=noUnusedImports --write src",
        ]);
        expect(
            fired(
                "bunx biome check --write --unsafe --only=style/useBlockStatements --only=correctness/noUnusedImports a.ts"
            )
        ).toEqual(["bunx biome check --write --only=style/useBlockStatements --only=correctness/noUnusedImports a.ts"]);
    });

    it("edits a call once when a double-quoted -c body shows its $(…) a second time", () => {
        expect(fired('bash -c "x=$(bunx biome lint --only=correctness/noUnusedImports --write --unsafe src)"')).toEqual(
            ['bash -c "x=$(bunx biome lint --only=correctness/noUnusedImports --write src)"']
        );
        expect(fired('bash -c "x=$(bunx biome check --write --unsafe src)"')).toEqual([
            `bash -c "x=$(bunx biome check --write --unsafe ${SKIP} src)"`,
        ]);
    });

    it.each(["correctness", "lint/correctness", "lint"])(
        "blocks --only=%s, a group that holds noUnusedImports",
        (group) => {
            expect(fired(`bunx biome lint --only=${group} --write --unsafe src`)).toEqual([
                `bunx biome lint --only=${group} --write --unsafe ${SKIP} src`,
            ]);
        }
    );

    it.each([
        "bunx biome lint --write --unsafe --only lint/style/useBlockStatements src/rm/lib/approve.ts && bunx biome format --write src",
        "./node_modules/.bin/biome check --write --unsafe --only=lint/style/useBlockStatements src/utils/rm/config.ts",
        "bunx biome lint --only=style/useBlockStatements --write --unsafe src/alza/lib/pc-build.ts 2>&1 | tail -3",
        "bunx biome lint --only=style/useBlockStatements --only=complexity/useOptionalChain --write --unsafe src",
    ])("allows %j: --only limits the run to rules that never touch imports", (command) => {
        expect(fired(command)).toEqual([]);
    });

    it("reads a quoted --only or --skip value as typed", () => {
        expect(fired('bunx biome lint --only "style/useBlockStatements" --write --unsafe src')).toEqual([]);
        expect(fired("bunx biome check --write --unsafe --skip 'correctness/noUnusedImports' src")).toEqual([]);
        expect(fired("bunx biome lint --only='correctness/noUnusedImports' --write --unsafe src")).toEqual([
            "bunx biome lint --only='correctness/noUnusedImports' --write src",
        ]);
    });

    it.each([
        `bunx biome check --write --unsafe ${SKIP} src`,
        "bunx biome check --write --unsafe --skip=lint/correctness/noUnusedImports src",
        "bunx biome lint --write --unsafe --skip correctness/noUnusedImports src",
        "bunx biome check --write --unsafe --skip=correctness src",
        "bunx biome check --write --unsafe --skip=lint/correctness src",
        "bunx biome check --write --unsafe --skip=noUnusedImports src",
        `bunx biome lint --only=correctness --write --unsafe ${SKIP} src`,
        `bunx biome lint --only=correctness/noUnusedImports --write --unsafe ${SKIP} src`,
    ])("allows %j: a --skip covers noUnusedImports", (command) => {
        expect(fired(command)).toEqual([]);
    });

    it.each([
        [
            "(bunx biome lint --write --unsafe src --only correctness/noUnusedImports)",
            "(bunx biome lint --write src --only correctness/noUnusedImports)",
        ],
        [
            "(bunx biome lint --write --unsafe src --only=correctness/noUnusedImports)",
            "(bunx biome lint --write src --only=correctness/noUnusedImports)",
        ],
        [
            "bunx biome lint --write --unsafe src --only correctness/noUnusedImports|tail -3",
            "bunx biome lint --write src --only correctness/noUnusedImports|tail -3",
        ],
        [
            "bunx biome lint --write --unsafe src --only correctness/noUnusedImports;echo done",
            "bunx biome lint --write src --only correctness/noUnusedImports;echo done",
        ],
        [
            "bunx biome lint --write --unsafe src --only correctness/noUnusedImports&&git diff",
            "bunx biome lint --write src --only correctness/noUnusedImports&&git diff",
        ],
        [
            "bash -c 'bunx biome lint --write --unsafe src --only correctness/noUnusedImports'",
            "bash -c 'bunx biome lint --write src --only correctness/noUnusedImports'",
        ],
        [
            "bunx biome lint --write --unsafe src --only=correctness>/tmp/x.log",
            `bunx biome lint --write --unsafe ${SKIP} src --only=correctness>/tmp/x.log`,
        ],
        ["bunx biome check --write src --unsafe; echo", `bunx biome check --write src --unsafe ${SKIP}; echo`],
        [
            "bunx biome check --write src --unsafe>/tmp/x.log",
            `bunx biome check --write src --unsafe ${SKIP}>/tmp/x.log`,
        ],
    ])("reads %j as the shell does: a glued operator ends the value", (command, expected) => {
        expect(fired(command)).toEqual([expected]);
        expect(fired(expected)).toEqual([]);
    });

    it.each([
        "bunx biome lint --write --unsafe src --only style/useBlockStatements|tail -3",
        "(bunx biome lint --write --unsafe src --only=style/useBlockStatements)",
        "bunx biome lint --write --unsafe src --only=style/useBlockStatements>/tmp/x.log",
    ])("allows %j: the value without the operator is another rule", (command) => {
        expect(fired(command)).toEqual([]);
    });

    it.each([
        [
            "R=correctness/noUnusedImports; bunx biome lint --only=$R --write --unsafe src",
            "R=correctness/noUnusedImports; bunx biome lint --only=$R --write src",
        ],
        ['bunx biome lint --only "$RULE" --write --unsafe src', 'bunx biome lint --only "$RULE" --write src'],
        ["bunx biome lint --only=$(cat rule) --write --unsafe src", "bunx biome lint --only=$(cat rule) --write src"],
        [
            "bunx biome lint --only=style/useBlockStatements --only=`cat rule` --write --unsafe src",
            "bunx biome lint --only=style/useBlockStatements --only=`cat rule` --write src",
        ],
    ])("blocks %j: an --only value only the shell knows can name noUnusedImports", (command, expected) => {
        expect(fired(command)).toEqual([expected]);
    });

    it.each([
        [
            "bunx biome check --write --unsafe a.ts && bunx biome check --write --unsafe b.ts",
            `bunx biome check --write --unsafe ${SKIP} a.ts && bunx biome check --write --unsafe ${SKIP} b.ts`,
        ],
        [
            "bunx biome lint --only=noUnusedImports --write --unsafe a.ts; bunx biome check --write --unsafe b.ts",
            `bunx biome lint --only=noUnusedImports --write a.ts; bunx biome check --write --unsafe ${SKIP} b.ts`,
        ],
        [
            "bunx biome check --write a.ts && bunx biome check --write --unsafe b.ts",
            `bunx biome check --write a.ts && bunx biome check --write --unsafe ${SKIP} b.ts`,
        ],
    ])("corrects every unsafe biome call in %j, so the suggestion passes", (command, expected) => {
        expect(fired(command)).toEqual([expected]);
        expect(fired(expected)).toEqual([]);
    });

    it("a --skip of another rule does not cover noUnusedImports", () => {
        expect(fired("bunx biome check --write --unsafe --skip=style/useBlockStatements src")).toEqual([
            `bunx biome check --write --unsafe ${SKIP} --skip=style/useBlockStatements src`,
        ]);
    });

    it.each([
        ["bunx biome check --write --unsafe --unsafe src", `bunx biome check --write --unsafe --unsafe ${SKIP} src`],
        ["bunx biome check --write --unsafe src --unsafe", `bunx biome check --write --unsafe src --unsafe ${SKIP}`],
        [
            "bunx biome check --write --unsafe=true src --unsafe=false",
            `bunx biome check --write --unsafe=true src --unsafe=false ${SKIP}`,
        ],
        [
            "cd app && bunx biome check --write --unsafe 'src/with space' --verbose --unsafe 2>&1 | tail -3",
            `cd app && bunx biome check --write --unsafe 'src/with space' --verbose --unsafe ${SKIP} 2>&1 | tail -3`,
        ],
    ])("adds the --skip once and preserves every other argument in %s", (command, expected) => {
        const suggestions = fired(command);
        expect(suggestions).toEqual([expected]);
        expect(fired(expected)).toEqual([]);
    });

    it.each([
        ["./node_modules/.bin/biome check --apply-unsafe src", "./node_modules/.bin/biome check --apply src"],
        ["bunx biome check --apply-unsafe --unsafe src", "bunx biome check --apply src"],
        [
            "bunx biome check src --apply-unsafe --unsafe --apply-unsafe --verbose",
            "bunx biome check src --apply --apply --verbose",
        ],
        [
            "bunx biome check --apply-unsafe=true src --unsafe --apply-unsafe=false",
            "bunx biome check --apply=true src --apply=false",
        ],
    ])("turns Biome 1.x's --apply-unsafe into its safe form in %s", (command, expected) => {
        const suggestions = fired(command);
        expect(suggestions).toEqual([expected]);
        expect(suggestions[0]).not.toMatch(/--(?:unsafe|apply-unsafe)(?:[=\s]|$)/);
        expect(fired(expected)).toEqual([]);
    });

    it.each([
        "yarn exec",
        "pnpm exec",
        "npm exec",
        "npm exec --",
        "pnpm -C pkg exec",
        "pnpm --filter=a exec",
        "pnpm -r exec",
        "yarn --cwd pkg exec",
        "npm --prefix pkg exec",
        "npx -y",
        "bunx --bun",
    ])("blocks unsafe Biome fixes through %s", (runner) => {
        expect(fired(`${runner} biome lint --write --unsafe src`)).toEqual([
            `${runner} biome lint --write --unsafe ${SKIP} src`,
        ]);
        expect(fired(`${runner} @biomejs/biome check src --apply-unsafe --unsafe`)).toEqual([
            `${runner} @biomejs/biome check src --apply`,
        ]);
        expect(fired(`${runner} eslint --fix --unsafe src`)).toEqual([]);
        expect(fired(`${runner} biome check --write src`)).toEqual([]);
    });

    it("leaves the safe fixes and other tools alone", () => {
        expect(fired("bunx biome check --write src")).toEqual([]);
        expect(fired("bunx biome lint --only=correctness/noUnusedImports src")).toEqual([]);
        expect(fired("bunx eslint --fix --unsafe src")).toEqual([]);
        expect(fired('rg -n "biome --unsafe" docs')).toEqual([]);
    });

    describe("explicit files whose imports carry no comment", () => {
        const root = mkdtempSync(join(tmpdir(), "biome-rule-"));
        const files: Record<string, string[]> = {
            // n=14: plain one-line imports, a comment only after a blank line.
            "plain.ts": [
                'import { homedir } from "node:os";',
                'import { join } from "node:path";',
                "",
                "// OAuth constants",
                'export const home = join(homedir(), "x");',
            ],
            // n=21 and n=25: multi-name and multi-line imports with type specifiers, a doc comment after a blank line.
            "multi.ts": [
                'import { existsSync, readFileSync, statSync } from "node:fs";',
                'import type { TranscriptParser } from "./parts";',
                'import { type FocusTarget, isUnambiguous } from "./focus";',
                "import {",
                "    type ParsedTurn,",
                "    type TranscriptTurn,",
                '} from "./types";',
                "",
                "/** Loaded on first use. */",
                "export const x = 1;",
            ],
            // A shebang, a comment right below the last import, and a dynamic import are all kept.
            "after.ts": [
                "#!/usr/bin/env bun",
                'import { a } from "./a";',
                'import data from "./data.json" with { type: "json" };',
                "// lazily",
                'export const c = await import("./c");',
            ],
            // n=44: a doc header directly above `import type {`.
            "header.ts": ["/**", " * The header.", " */", "import type {", "    A,", '} from "./a";'],
            "spaced.ts": ["// A whitespace-only line still joins the header.", "    ", 'import { a } from "./a";'],
            "between.ts": ['import { a } from "./a";', "// why b", 'import { b } from "./b";'],
            "braces.ts": ["import {", "    a, // why a", "    b,", '} from "./a";'],
            "trailing.ts": ["import {", "    a,", '} from "./a"; // why'],
            "leading.ts": ['/* why */ import { a } from "./a";'],
            // Two adjacent imports removed take every comment above them, across empty lines too.
            "parted.ts": [
                "/**",
                " * The header.",
                " */",
                "",
                'import { homedir } from "node:os";',
                'import { join } from "node:path";',
            ],
            "section.ts": ['import { a } from "./a";', "", "// section", "", 'import { b } from "./b";'],
            "split.ts": ["#!/usr/bin/env bun", 'import { a } from "./a";', "// header", "", 'import { b } from "./b";'],
            "blockhide.ts": ["/*", "  Header text.", "  import everything from here", "*/", 'import { a } from "./a";'],
            "multiblock.ts": ["/* a long", '   comment */ import { a } from "./a";'],
            "attrs.ts": ['import data from "./data.json" with {', '    type: "json",', "}; // why"],
            "sameline.ts": ['const y = 1; import { a } from "./a"; // why'],
            "importcomment.ts": ["import // why", '    { a } from "./a";'],
            "strname.ts": ["import {", '    "a-b" as ab,', "    c, // why c", '} from "./x";'],
            "cr.ts": ['// header\rimport { a } from "./a";'],
            "ff.ts": ["// header", "\f", 'import { a } from "./a";'],
            "nbsp.ts": ["// header", '\u00a0import { a } from "./a";'],
            "notes.json": ["{}"],
        };
        mkdirSync(join(root, "sub"));
        for (const [name, lines] of Object.entries(files)) {
            writeFileSync(join(root, name), `${lines.join("\n")}\n`);
        }
        writeFileSync(join(root, "sub", "plain.ts"), `${files["plain.ts"].join("\n")}\n`);
        writeFileSync(
            join(root, "huge.ts"),
            `${files["plain.ts"].join("\n")}\n${"export const y = 1;\n".repeat(60_000)}`
        );

        afterAll(() => {
            rmSync(root, { recursive: true, force: true });
        });

        const firedIn = (command: string, cwd = root) =>
            detectShellViolations(command, biomeRules, { cwd }).map(
                (violation) => violation.suggestion ?? violation.ruleId
            );

        it.each([
            "bunx biome check --write --unsafe plain.ts multi.ts after.ts",
            "bunx biome check --write --unsafe ./plain.ts 2>&1 | tail -1",
            "bunx biome check --write --unsafe plain.ts > /tmp/x.log 2>&1",
            "bunx biome lint --only correctness/noUnusedImports --write --unsafe multi.ts",
            "bunx biome check --write --unsafe sub/plain.ts",
            "cd sub && bunx biome check --write --unsafe plain.ts",
            "cd sub; S=/tmp/cc/x; bunx biome check --write --unsafe plain.ts 2>&1 | tail -1; echo done",
            "cd sub && NO_COLOR=1 bunx biome check --write --unsafe plain.ts",
            "npx biome check --write --unsafe plain.ts",
            "yarn exec biome check --write --unsafe plain.ts",
            "pnpm exec biome check --write --unsafe plain.ts",
            "pnpm exec -- biome check --write --unsafe plain.ts",
        ])("allows %j: no import has a comment the fix could delete", (command) => {
            expect(firedIn(command)).toEqual([]);
        });

        it("follows a literal leading cd from any folder, and reads absolute paths without one", () => {
            expect(firedIn(`cd ${root} && bunx biome check --write --unsafe plain.ts`, "/")).toEqual([]);
            expect(fired(`bunx biome check --write --unsafe ${join(root, "multi.ts")}`)).toEqual([]);
        });

        it.each([
            "header.ts",
            "spaced.ts",
            "between.ts",
            "braces.ts",
            "trailing.ts",
            "leading.ts",
            "parted.ts",
            "section.ts",
            "split.ts",
            "blockhide.ts",
            "multiblock.ts",
            "attrs.ts",
            "sameline.ts",
            "importcomment.ts",
            "strname.ts",
            "cr.ts",
            "ff.ts",
            "nbsp.ts",
        ])("blocks %s: a comment before the end of the last import, which the fix can delete", (name) => {
            expect(firedIn(`bunx biome check --write --unsafe plain.ts ${name}`)).toEqual([
                `bunx biome check --write --unsafe ${SKIP} plain.ts ${name}`,
            ]);
        });

        it.each([
            ["a folder", "bunx biome check --write --unsafe sub"],
            ["a glob", "bunx biome check --write --unsafe *.ts"],
            ["a parameter", "FILES=plain.ts; bunx biome check --write --unsafe $FILES"],
            ["a split parameter", 'F="plain.ts multi.ts"; bunx biome check --write --unsafe ${=F}'],
            ["a missing file", "bunx biome check --write --unsafe plain.ts missing.ts"],
            ["a file biome does not read as a script", "bunx biome check --write --unsafe notes.json"],
            ["a file over 1 MB", "bunx biome check --write --unsafe huge.ts"],
            ["more than 50 files", `bunx biome check --write --unsafe ${"plain.ts ".repeat(51)}`],
            ["no target, which is the whole folder", "bunx biome check --write --unsafe"],
            ["--staged, which replaces the paths", "bunx biome check --write --unsafe --staged plain.ts"],
            ["--changed, which replaces the paths", "bunx biome check --write --unsafe --changed plain.ts"],
            ["an earlier write to the target", "printf '' > plain.ts && bunx biome check --write --unsafe plain.ts"],
            ["a cd in a subshell", "(cd sub) && bunx biome check --write --unsafe plain.ts"],
            ["a folder only the shell knows", 'cd "$DIR" && bunx biome check --write --unsafe plain.ts'],
            ["a -c body", "bash -c 'bunx biome check --write --unsafe plain.ts'"],
            ["paths after --", "bunx biome check --write --unsafe -- plain.ts"],
            ["env -C, which moves the folder", "env -C sub bunx biome check --write --unsafe plain.ts"],
            ["sudo -D, which moves the folder", "sudo -n -D sub bunx biome check --write --unsafe plain.ts"],
            ["xargs, which adds targets", "xargs bunx biome check --write --unsafe plain.ts < notes.json"],
            ["yarn, which starts biome in the package root", "yarn biome check --write --unsafe plain.ts"],
            ["pnpm biome, which runs a package script named biome first", "pnpm biome check --write --unsafe plain.ts"],
            ["pnpx biome, which downloads the npm package biome", "pnpx biome check --write --unsafe plain.ts"],
            ["pnpm -C, which moves the folder", "pnpm -C sub exec biome check --write --unsafe plain.ts"],
            [
                "pnpm --filter, which starts in the package",
                "pnpm --filter=a exec biome check --write --unsafe plain.ts",
            ],
            ["pnpm -r, which runs in every package", "pnpm -r exec biome check --write --unsafe plain.ts"],
            ["yarn --cwd, which moves the folder", "yarn --cwd sub exec biome check --write --unsafe plain.ts"],
            ["a zsh >| that hides a target", "bunx biome check --write --unsafe plain.ts >| out.log header.ts"],
            ["a zsh 2>| that hides a target", "bunx biome check --write --unsafe plain.ts 2>| e.log header.ts"],
            ["an output process substitution", "bunx biome check --write --unsafe plain.ts > >(cat) header.ts"],
            ["an input process substitution", "bunx biome check --write --unsafe plain.ts <(true) header.ts"],
        ])("blocks %s, which the guard cannot read", (_shape, command) => {
            expect(firedIn(command)).toHaveLength(1);
        });

        it("reads a long prefix and a file of many statement starts without backtracking", () => {
            writeFileSync(
                join(root, "blocks.ts"),
                `import { a } from "./a";\n${"/**/ ".repeat(40)}export const z = a;\n${`;${" ".repeat(60)}\n`.repeat(2000)}`
            );
            const prefix = scanShell(
                `${"cd sub\n \n \n".repeat(2000)}echo; bunx biome check --write --unsafe plain.ts`,
                root
            );
            const file = scanShell("bunx biome check --write --unsafe blocks.ts", root);
            const started = performance.now();

            expect(biomeUnsafeDeletesComments.detect(prefix)).not.toBeNull();
            expect(biomeUnsafeDeletesComments.detect(file)).toBeNull();
            // Each takes about 1 ms; the backtracking this guards against took 2.9 s.
            expect(performance.now() - started).toBeLessThan(100);
        });

        it("blocks a relative path when the folder is unknown", () => {
            expect(fired("bunx biome check --write --unsafe plain.ts")).toEqual([
                `bunx biome check --write --unsafe ${SKIP} plain.ts`,
            ]);
        });

        it("corrects only the call that can delete a comment, and the correction passes", () => {
            const command = "bunx biome check --write --unsafe plain.ts && bunx biome check --write --unsafe header.ts";
            const expected = `bunx biome check --write --unsafe plain.ts && bunx biome check --write --unsafe ${SKIP} header.ts`;

            expect(firedIn(command)).toEqual([expected]);
            expect(firedIn(expected)).toEqual([]);
        });
    });
});
