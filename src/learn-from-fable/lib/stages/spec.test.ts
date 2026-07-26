import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner, RunnerCall, RunnerResult } from "../runners";
import { buildSpecUser, type SpecCandidate, synthesizeSpec } from "./spec";

function principle(text: string, confidence?: number): SpecCandidate {
    return {
        sessionStem: "8a4faba3-aaaa",
        minedBy: "test",
        principle: text,
        why: "because",
        finalConfidence: confidence,
    };
}

function fakeRunner(reply: string | ((call: RunnerCall, n: number) => string), seen: RunnerCall[] = []): Runner {
    return {
        id: "test-runner",
        async call(input: RunnerCall): Promise<RunnerResult> {
            seen.push(input);
            const text = typeof reply === "string" ? reply : reply(input, seen.length);
            return { text, elapsedMs: 1 };
        },
    };
}

function specFile(contents: string): string {
    const path = join(mkdtempSync(join(tmpdir(), "lff-spec-")), "FABLE-SPEC.md");
    writeFileSync(path, contents);
    return path;
}

describe("spec stage", () => {
    test("feeds principles highest-confidence first and states both budgets", () => {
        const user = buildSpecUser("# spec", [principle("high one", 95), principle("low one", 60)], 200, "batch 1/2");

        expect(user).toContain("high one");
        expect(user).toContain("200 lines maximum");
        // the per-bullet cap is the other half of the budget: a line budget alone is
        // satisfied by gluing every mined clause onto an existing bullet
        expect(user).toContain("420 characters maximum per bullet");
        expect(user).toContain("batch 1/2");
    });

    test("marks vetted vs unvetted so the writer can be stricter with raw candidates", () => {
        const user = buildSpecUser("# spec", [principle("voted", 88), principle("raw")], 200);

        expect(user).toContain("[88% vetted] voted");
        expect(user).toContain("[unvetted] raw");
    });

    test("filters by minConfidence and reports what was fed", async () => {
        const seen: RunnerCall[] = [];
        const result = await synthesizeSpec(
            fakeRunner("# Fable Operating Spec\n\n- existing bullet\n- new bullet\n", seen),
            specFile("# Fable Operating Spec\n\n- existing bullet\n"),
            [principle("keep me", 90), principle("too weak", 50)],
            { maxLines: 200, minConfidence: 70 }
        );

        expect(result.principlesFed).toBe(1);
        expect(result.vettedFed).toBe(1);
        expect(seen[0].user).toContain("keep me");
        expect(seen[0].user).not.toContain("too weak");
        expect(result.beforeLines).toBe(4);
        expect(result.markdown).toContain("new bullet");
    });

    test("the confidence floor never drops unvetted candidates — they have no vote to fail", async () => {
        const seen: RunnerCall[] = [];
        const result = await synthesizeSpec(
            fakeRunner("# spec\n\n- bullet\n", seen),
            specFile("# spec\n"),
            [principle("raw candidate"), principle("weak vetted", 10)],
            { maxLines: 200, minConfidence: 70 }
        );

        expect(result.principlesFed).toBe(1);
        expect(result.unvettedFed).toBe(1);
        expect(seen[0].user).toContain("raw candidate");
        expect(seen[0].user).not.toContain("weak vetted");
    });

    test("batches large corpora, each pass merging into the previous draft", async () => {
        const seen: RunnerCall[] = [];
        const runner = fakeRunner((_call, n) => `# spec\n\n- merged pass ${n}\n`, seen);
        const many = Array.from({ length: 5 }, (_, i) => principle(`p${i}`, 80));

        const result = await synthesizeSpec(runner, specFile("# spec\n"), many, {
            maxLines: 50,
            minConfidence: 0,
            batchSize: 2,
        });

        expect(result.batches).toBe(3);
        expect(seen.length).toBe(3);
        // pass 2 must see pass 1's output as its CURRENT SPEC, not the original file
        expect(seen[1].user).toContain("- merged pass 1");
        expect(result.markdown).toContain("- merged pass 3");
    });

    test("rejects a pass that erodes the draft instead of merging into it", async () => {
        // Real failure mode, 2026-07-25: an unguarded 10-pass run went 84 -> 73 -> 58
        // -> 42 bullets, compressing the spec away one pass at a time.
        const fat = `# spec\n\n${Array.from({ length: 10 }, (_, i) => `- bullet ${i}`).join("\n")}\n`;
        const runner = fakeRunner((_call, n) => (n === 1 ? fat : "# spec\n\n- only one left\n"));
        const many = Array.from({ length: 4 }, (_, i) => principle(`p${i}`, 80));

        const result = await synthesizeSpec(runner, specFile("# spec\n"), many, {
            maxLines: 50,
            minConfidence: 0,
            batchSize: 2,
        });

        expect(result.rejectedPasses).toBe(1);
        expect(result.afterBullets).toBe(10);
        expect(result.markdown).toContain("bullet 9");
        expect(result.markdown).not.toContain("only one left");
    });

    test("accepts a modest fold — a couple of duplicates merged while the content grows", async () => {
        const wide = `# spec\n\n${Array.from({ length: 10 }, (_, i) => `- short bullet ${i}`).join("\n")}\n`;
        const folded = `# spec\n\n${Array.from({ length: 9 }, (_, i) => `- merged bullet ${i} ${"with substance ".repeat(4)}`).join("\n")}\n`;
        expect(folded.length).toBeGreaterThan(wide.length);

        const runner = fakeRunner((_call, n) => (n === 1 ? wide : folded));
        const many = Array.from({ length: 4 }, (_, i) => principle(`p${i}`, 80));

        const result = await synthesizeSpec(runner, specFile("# spec\n"), many, {
            maxLines: 200,
            minConfidence: 0,
            batchSize: 2,
        });

        expect(result.rejectedPasses).toBe(0);
        expect(result.markdown).toContain("merged bullet");
    });

    test("rejects blob-ification — sections folded into a few giant bullets", async () => {
        // 2026-07-25 v5: a pass produced 26 bullets holding 59_199 chars. Content was
        // growing, so a content-only guard waved it through while the document stopped
        // being a list of principles.
        const wide = `# spec\n\n${Array.from({ length: 20 }, (_, i) => `- bullet ${i} ${"detail ".repeat(6)}`).join("\n")}\n`;
        const blob = `# spec\n\n${Array.from({ length: 4 }, (_, i) => `- giant ${i} ${"detail ".repeat(80)}`).join("\n")}\n`;
        expect(blob.length).toBeGreaterThan(wide.length);

        const runner = fakeRunner((_call, n) => (n === 1 ? wide : blob));
        const many = Array.from({ length: 4 }, (_, i) => principle(`p${i}`, 80));

        const result = await synthesizeSpec(runner, specFile("# spec\n"), many, {
            maxLines: 200,
            minConfidence: 0,
            batchSize: 2,
        });

        expect(result.rejectedPasses).toBe(1);
        expect(result.markdown).not.toContain("giant");
    });

    test("catches a slow leak — every pass is judged against the high-water mark", async () => {
        // 2026-07-25 v4: six passes each losing under 15% took 90 bullets down to 33,
        // because 0.85^6 is 0.38. Every one of those steps passed a comparison against
        // its immediate predecessor.
        const line = "- a substantial bullet carrying real content\n";
        const big = `# spec\n\n${line.repeat(20)}`;
        const slightlySmaller = `# spec\n\n${line.repeat(18)}`;
        const smallerStill = `# spec\n\n${line.repeat(16)}`;
        const runner = fakeRunner((_call, n) => (n === 1 ? big : n === 2 ? slightlySmaller : smallerStill));
        const many = Array.from({ length: 6 }, (_, i) => principle(`p${i}`, 80));

        const result = await synthesizeSpec(runner, specFile("# spec\n"), many, {
            maxLines: 200,
            minConfidence: 0,
            batchSize: 2,
        });

        // pass 2 stays within 15% of the high-water mark; pass 3 does not
        expect(result.rejectedPasses).toBe(1);
        expect(result.afterBullets).toBe(18);
    });

    test("retries an eroding pass once with the failure named, so its candidates still land", async () => {
        const fat = `# spec\n\n${Array.from({ length: 10 }, (_, i) => `- bullet ${i}`).join("\n")}\n`;
        const seen: RunnerCall[] = [];
        // pass 1 builds the draft, pass 2 erodes, its retry behaves
        const runner = fakeRunner((_call, n) => {
            if (n === 1) {
                return fat;
            }

            return n === 2 ? "# spec\n\n- only one left\n" : `${fat}- from the retry\n`;
        }, seen);
        const many = Array.from({ length: 4 }, (_, i) => principle(`p${i}`, 80));

        const result = await synthesizeSpec(runner, specFile("# spec\n"), many, {
            maxLines: 50,
            minConfidence: 0,
            batchSize: 2,
        });

        expect(seen.length).toBe(3);
        expect(seen[2].user).toContain("CORRECTION");
        expect(result.rejectedPasses).toBe(0);
        expect(result.markdown).toContain("from the retry");
    });

    test("a pass that throws keeps the previous draft instead of killing the run", async () => {
        // 2026-07-25: pass 4 of 6 hit the runner's no-output budget, the error escaped
        // the loop, and three already-merged passes were lost with it.
        const runner: Runner = {
            id: "flaky",
            async call(input) {
                // batch 2 fails on both its attempt and its retry
                if (input.label?.startsWith("spec-2of2")) {
                    throw new Error("model produced no output: no output for 90000ms");
                }

                return { text: "# spec\n\n- survived\n", elapsedMs: 1 };
            },
        };
        const many = Array.from({ length: 4 }, (_, i) => principle(`p${i}`, 80));

        const result = await synthesizeSpec(runner, specFile("# spec\n"), many, {
            maxLines: 50,
            minConfidence: 0,
            batchSize: 2,
        });

        expect(result.rejectedPasses).toBe(1);
        expect(result.markdown).toContain("- survived");
    });

    test("a batch that comes back empty twice keeps the previous draft", async () => {
        // batch 2 is empty on both its attempt and its retry
        const runner = fakeRunner((call, n) =>
            call.label?.startsWith("spec-2of2") ? "   " : `# spec\n\n- pass ${n}\n`
        );
        const many = Array.from({ length: 4 }, (_, i) => principle(`p${i}`, 80));

        const result = await synthesizeSpec(runner, specFile("# spec\n"), many, {
            maxLines: 50,
            minConfidence: 0,
            batchSize: 2,
        });

        expect(result.rejectedPasses).toBe(1);
        expect(result.markdown).toContain("- pass 1");
    });

    test("strips a whole-document code fence", async () => {
        const result = await synthesizeSpec(
            fakeRunner("```markdown\n# spec\n\n- bullet\n```"),
            specFile("# spec\n"),
            [principle("p", 90)],
            { maxLines: 50, minConfidence: 0 }
        );

        expect(result.markdown.startsWith("# spec")).toBe(true);
        expect(result.markdown).not.toContain("```");
    });

    test("an empty synthesis over an empty spec is an error, never a silent empty spec", async () => {
        expect(
            synthesizeSpec(fakeRunner("   "), specFile(""), [principle("p", 90)], { maxLines: 50, minConfidence: 0 })
        ).rejects.toThrow("empty");
    });

    test("every pass discarded is an error, not a copy of the current spec", async () => {
        // 2026-07-25: the Grok token expired, all 15 passes failed in the same second,
        // and the stage wrote a byte-for-byte copy of the canonical spec as a proposal.
        const runner: Runner = {
            id: "dead",
            async call() {
                throw new Error("POST /chat/completions 502 (grok_auth_expired)");
            },
        };

        expect(
            synthesizeSpec(runner, specFile("# spec\n\n- bullet\n"), [principle("p", 90)], {
                maxLines: 50,
                minConfidence: 0,
            })
        ).rejects.toThrow("every one of the");
    });

    test("splices tightened bullets in place, leaving every other line untouched", async () => {
        // 2026-07-25 v6: 55 of 78 bullets were over 400 chars and the worst held 4_363,
        // because "MERGE, don't append" under a LINE budget is satisfied by gluing every
        // mined clause onto a bullet that already exists.
        const piled = `# spec\n\n- giant ${"clause and another ".repeat(40)} *(8a4faba3)*\n- small one *(6666b2cb)*\n`;
        const seen: RunnerCall[] = [];
        const runner = fakeRunner(
            (call) =>
                call.label?.startsWith("spec-tighten")
                    ? `### 1\n- first half ${"clause ".repeat(30)} *(8a4faba3)*\n- second half ${"clause ".repeat(30)} *(8a4faba3)*`
                    : piled,
            seen
        );

        const result = await synthesizeSpec(runner, specFile("# spec\n"), [principle("p", 90)], {
            maxLines: 200,
            minConfidence: 0,
        });

        expect(result.tightened).toBe(true);
        expect(result.afterOverCap).toBe(0);
        expect(result.afterBullets).toBe(3);
        // the bullet that was already principle-sized was never sent and never rewritten
        expect(result.markdown).toContain("- small one *(6666b2cb)*");
        expect(seen[1].user).not.toContain("small one");
    });

    test("a tightening reply that fragments one bullet into many is rejected", async () => {
        // 2026-07-25: the first tightening prompt turned 44 piled bullets into 266
        // fragments that each repeated the same why — 306 bullets became 528 with 484
        // near-duplicate pairs, longer and less useful than the pile it replaced.
        const piled = `# spec\n\n- giant ${"clause and another ".repeat(30)} *(8a4faba3)*\n`;
        const fragments = Array.from({ length: 8 }, () => "- tiny fragment repeating the same why *(8a4faba3)*").join(
            "\n"
        );
        const runner = fakeRunner((call) => (call.label?.startsWith("spec-tighten") ? `### 1\n${fragments}` : piled));

        const result = await synthesizeSpec(runner, specFile("# spec\n"), [principle("p", 90)], {
            maxLines: 200,
            minConfidence: 0,
        });

        expect(result.tightened).toBe(false);
        expect(result.afterBullets).toBe(1);
    });

    test("keeps a tightened bullet that overshoots the cap but is genuinely shorter", async () => {
        // 2026-07-25: 51 replacements were thrown away for landing at 421-511 against a
        // 420 cap, every one of them shorter than the pile it replaced. Round two
        // re-attacks whatever is still over, so taking the improvement converges.
        const piled = `- giant ${"clause and another ".repeat(30)} *(8a4faba3)*`;
        const nearMiss = `- tightened but still a touch long ${"clause ".repeat(55)} *(8a4faba3)*`;
        expect(nearMiss.length).toBeGreaterThan(420);
        expect(nearMiss.length).toBeLessThan(420 * 1.25);
        // and it keeps enough of the original that the content guards are satisfied
        expect(nearMiss.length / piled.length).toBeGreaterThan(0.6);

        const runner = fakeRunner((call) =>
            call.label?.startsWith("spec-tighten") ? `### 1\n${nearMiss}` : `# spec\n\n${piled}\n`
        );

        const result = await synthesizeSpec(runner, specFile("# spec\n"), [principle("p", 90)], {
            maxLines: 200,
            minConfidence: 0,
        });

        expect(result.tightened).toBe(true);
        expect(result.markdown).toContain("tightened but still a touch long");
    });

    test("round one tightens a bullet that is over the cap but inside the re-send tolerance", async () => {
        // The tolerance exists to stop later rounds re-attacking near-misses forever.
        // It must not mean a draft bullet in that band never gets an attempt at all:
        // 420 is what the prompt calls a hard limit, so round one targets the real cap.
        const overCap = `- over the cap but not by much ${"clause ".repeat(58)} *(8a4faba3)*`;
        expect(overCap.length).toBeGreaterThan(420);
        expect(overCap.length).toBeLessThan(420 * 1.25);

        // Shorter, but still enough of the original that the erosion guards accept it.
        const tightened = `- short enough now ${"clause ".repeat(38)} *(8a4faba3)*`;
        expect(tightened.length).toBeLessThan(420);
        expect(tightened.length / overCap.length).toBeGreaterThan(0.6);

        const runner = fakeRunner((call) =>
            call.label?.startsWith("spec-tighten") ? `### 1\n${tightened}` : `# spec\n\n${overCap}\n`
        );

        const result = await synthesizeSpec(runner, specFile("# spec\n"), [principle("p", 90)], {
            maxLines: 200,
            minConfidence: 0,
        });

        expect(result.tightened).toBe(true);
        expect(result.afterOverCap).toBe(0);
        expect(result.markdown).toContain("short enough now");
    });

    test("a tightened bullet that loses its citation is rejected, keeping the original", async () => {
        const piled = `# spec\n\n- giant ${"clause and another ".repeat(40)} *(8a4faba3)*\n- keep me\n`;
        const runner = fakeRunner((call) =>
            call.label?.startsWith("spec-tighten") ? `### 1\n- tight now, source forgotten` : piled
        );

        const result = await synthesizeSpec(runner, specFile("# spec\n"), [principle("p", 90)], {
            maxLines: 200,
            minConfidence: 0,
        });

        expect(result.tightened).toBe(false);
        expect(result.markdown).toContain("keep me");
        expect(result.markdown).toContain("*(8a4faba3)*");
    });

    test("a tightening batch that throws costs only its own bullets", async () => {
        const piled = `# spec\n\n- giant ${"clause and another ".repeat(40)} *(8a4faba3)*\n- keep me\n`;
        const runner: Runner = {
            id: "half-broken",
            async call(input) {
                if (input.label?.startsWith("spec-tighten")) {
                    throw new Error("upstream reset");
                }

                return { text: piled, elapsedMs: 1 };
            },
        };

        const result = await synthesizeSpec(runner, specFile("# spec\n"), [principle("p", 90)], {
            maxLines: 200,
            minConfidence: 0,
        });

        expect(result.tightened).toBe(false);
        expect(result.markdown).toContain("keep me");
    });

    test("rejects a pass that drops a whole section while growing the bullet count", async () => {
        // 2026-07-25 v9: "Judgment calls (when to ask vs proceed)" — eight principles
        // about the hardest call there is — vanished from a 306-bullet proposal that
        // looked healthy on both other axes, because nothing checked headings.
        const base = "# spec\n\n## Planning\n\n- plan bullet\n\n## Judgment calls\n\n- ask bullet\n";
        const wider = `# spec\n\n## Planning\n\n${Array.from({ length: 12 }, (_, i) => `- plan bullet ${i}`).join("\n")}\n`;
        expect(wider.length).toBeGreaterThan(base.length);

        const runner = fakeRunner((_call, n) => (n === 1 ? base : wider));
        const many = Array.from({ length: 4 }, (_, i) => principle(`p${i}`, 80));

        const result = await synthesizeSpec(runner, specFile("# spec\n"), many, {
            maxLines: 200,
            minConfidence: 0,
            batchSize: 2,
            tighten: false,
        });

        expect(result.rejectedPasses).toBe(1);
        expect(result.markdown).toContain("## Judgment calls");
    });

    test("--no-tighten leaves the merged draft alone", async () => {
        const piled = `# spec\n\n- giant ${"clause and another ".repeat(40)}\n`;
        const seen: RunnerCall[] = [];

        const result = await synthesizeSpec(fakeRunner(piled, seen), specFile("# spec\n"), [principle("p", 90)], {
            maxLines: 200,
            minConfidence: 0,
            tighten: false,
        });

        expect(seen.length).toBe(1);
        expect(result.tightened).toBe(false);
        expect(result.afterOverCap).toBe(1);
    });

    test("tightening bloated bullets does not read as erosion", async () => {
        // The two guards used to contradict each other: raw character count let bloat
        // raise the high-water mark, so the pass that tightened those bullets back to
        // principle size looked like a 50% content loss and was discarded.
        // 720-char piles tightened to 280-char principles: half the bytes, same principles
        const bloated = `# spec\n\n${Array.from({ length: 10 }, (_, i) => `- bullet ${i} ${"padding ".repeat(90)}`).join("\n")}\n`;
        const tight = `# spec\n\n${Array.from({ length: 10 }, (_, i) => `- bullet ${i} ${"padding ".repeat(34)}`).join("\n")}\n`;
        expect(tight.length).toBeLessThan(bloated.length * 0.5);

        const runner = fakeRunner((_call, n) => (n === 1 ? bloated : tight));
        const many = Array.from({ length: 4 }, (_, i) => principle(`p${i}`, 80));

        const result = await synthesizeSpec(runner, specFile("# spec\n"), many, {
            maxLines: 200,
            minConfidence: 0,
            batchSize: 2,
            tighten: false,
        });

        expect(result.rejectedPasses).toBe(0);
        expect(result.afterOverCap).toBe(0);
        expect(result.markdown).toContain("bullet 9");
    });

    test("no candidates at all is an error, not an empty proposal", async () => {
        expect(
            synthesizeSpec(fakeRunner("# spec"), specFile("# spec\n"), [], { maxLines: 50, minConfidence: 0 })
        ).rejects.toThrow("no principle candidates");
    });
});
