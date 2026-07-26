/**
 * Instruct-stages: these commands compute nothing — they print pack data plus
 * instructions for the LLM that ran them (the /learn-from-fable session). The
 * CLI is the stage's front door; the judgment work stays with the model.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { out } from "@genesiscz/utils/logger";
import { FABLE_MODEL, type FableConfig, packPaths } from "../lib/config";
import { readStageRuns } from "../lib/manifest";
import { loadUnconsolidated } from "../lib/stages/consolidate";

function readOr(path: string, fallback: string): string {
    return existsSync(path) ? readFileSync(path, "utf-8") : fallback;
}

export function selfReviewCommand(config: FableConfig): void {
    const paths = packPaths(config);
    const spec = readOr(paths.spec, "(no spec yet)");
    out.print(`# Stage: self-review (instruct)

You are ${FABLE_MODEL === "claude-fable-5" ? "ideally a live Fable 5 session" : "a strong model"} auditing the Fable Pack spec WHILE Fable is still served. This signal expires when the model does.

## Your tasks
1. Read the spec below as its subject: mark principles that are WRONG, overfit to one session, or missing their real why. Rewrite those in place (edit ${paths.spec}).
2. Growth control: propose per-section caps and merge near-duplicates (strengthen, don't multiply). The spec should get sharper as it grows, not longer.
3. Add principles you KNOW you follow that mining hasn't surfaced yet — with the honest why.
4. Note every change in ${paths.changelog} and commit the pack repo (git -C ${paths.pack}).

## FABLE-SPEC.md (current)
${spec}
`);
}

export function hooksCommand(config: FableConfig): void {
    const paths = packPaths(config);
    const spec = readOr(paths.spec, "(no spec yet)");
    const principles = loadUnconsolidated(config);
    out.print(`# Stage: hooks (instruct)

Propose DETERMINISTIC Claude Code hooks from the pack data below. Hooks are the one mechanism that does not depend on the weak model's judgment — pick only rules that can be checked mechanically (PreToolUse/PostToolUse/Stop), e.g. "claimed done without running the promised check", "naked sleep in a wait loop", "force-push without --force-with-lease".

For each proposal output: hook event, matcher, one-line check script sketch, and which spec principle it enforces. 3-7 proposals, ranked. Do NOT write files — present the list to the user for selection.

## Spec principles
${spec}

## Unconsolidated principle candidates (${principles.length})
${principles.map((p) => `- ${p.principle} (why: ${p.why})`).join("\n") || "(none)"}
`);
}

export async function skillCommand(config: FableConfig, options: { maxLines: number; sync?: boolean }): Promise<void> {
    const paths = packPaths(config);

    if (options.sync) {
        const canonical = join(paths.skillDir, "SKILL.md");
        const runtime = join(env.paths.getHome(), ".claude", "skills", "fable-style", "SKILL.md");

        if (!existsSync(canonical)) {
            out.log.error(`No skill to sync at ${canonical}. Generate it first: tools learn-from-fable skill`);
            return;
        }

        await Bun.write(runtime, readFileSync(canonical, "utf-8"));
        out.log.success(`synced ${canonical} → ${runtime}`);
        return;
    }

    const spec = readOr(paths.spec, "(no spec yet)");
    const traces = readOr(paths.goldenTraces, "(no golden traces yet)");
    out.print(`# Stage: skill (instruct)

Regenerate ${join(paths.skillDir, "SKILL.md")} FROM the spec below (the spec is the single source of truth; never hand-edit the skill separately).

- Body budget: <= ${options.maxLines} lines (parameterized — not a hard 150 anymore).
- Frontmatter exactly: name fable-style; description "Work the way Fable 5 works - plan, execute, verify, then report outcome-first. Load when running on Sonnet/Opus/Haiku for nontrivial engineering tasks."
- Content: strongest principles per section (each with its one-line why), 3-5 best golden traces, command idioms. Principle-shaped prose, not MUST-lists.
- Afterwards run: tools learn-from-fable skill --sync
- Then commit the pack repo.

## FABLE-SPEC.md
${spec}

## golden-traces.md
${traces}
`);
}

export function preScoreCommand(config: FableConfig): void {
    const runs = readStageRuns(config).filter((r) => r.stage === "mine").length;
    out.print(`# Stage: pre-score (instruct — deferred implementation)

Rank unmined sessions by expected teachable-episode density BEFORE spending mining calls. Deferred by design (late-stage addition; user may revise after reading mined output — ${runs} mine runs so far).

Interim manual recipe: run \`tools learn-from-fable pre-mine --limit 20\` and prioritize sessions with high fableTurns and many windows; error-recovery-heavy projects first. A model-backed scorer becomes worthwhile once mining cost dominates (>50 sessions/run).
`);
}
