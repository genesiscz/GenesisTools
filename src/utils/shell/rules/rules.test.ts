import { describe, expect, it } from "bun:test";

import { detectShellViolations, renderViolation, renderViolations, ruleById, SHELL_RULES } from "./index";

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
            const wrong = detectShellViolations(rule.wrong, [rule]);
            const right = detectShellViolations(rule.right, [rule]);

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

    it("holds the thirteen rules harvested from CLAUDE.md", () => {
        expect(SHELL_RULES.map((r) => r.id).sort()).toEqual(
            [
                "bare-log-command",
                "docker-volume-destroy",
                "exit-code-after-grep",
                "exit-code-after-pipeline",
                "find-from-root",
                "git-checkout-overwrites-file",
                "git-push-force-without-lease",
                "migrate-fresh-outside-testing",
                "pipestatus-under-zsh",
                "rg-replace-cluster",
                "stderr-discarded-then-counted",
                "stderr-discarded-then-read",
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
            "[block] 2>/dev/null then a count: a failure is counted as 0 (rule stderr-discarded-then-counted)"
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
