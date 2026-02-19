/**
 * Debug Postmortem Template
 *
 * Structured postmortem focused on the debugging process.
 * Emphasizes the investigation timeline, dead ends, and prevention —
 * the parts most valuable for avoiding repeated debugging effort.
 */

import { buildMetadataBlock, type PromptTemplate, type TemplateContext } from "./index.ts";

export class DebugPostmortemTemplate implements PromptTemplate {
    name = "debug-postmortem";
    description = "Debugging postmortem with investigation timeline, dead ends, root cause, and prevention strategies";

    systemPrompt = `You are a debugging analyst writing a postmortem report from a Claude Code development session transcript.

Your goal is to document the debugging process in a way that prevents future developers (or AI assistants) from wasting time on the same issue. The most valuable part of a postmortem is often the dead ends — approaches that seemed promising but failed.

Guidelines:
- Focus on the debugging PROCESS, not just the outcome. The journey matters more than the destination.
- Document every approach that was tried, especially the ones that did not work.
- For dead ends, always explain WHY the approach failed — this is what prevents repetition.
- Be specific about symptoms: exact error messages, stack traces, behavioral descriptions.
- Include the diagnostic commands and techniques used (grep patterns, log analysis, debugging flags).
- Document the "aha moment" — what observation or insight led to the correct diagnosis.
- For the fix, explain not just what was changed but why it works at a technical level.
- If the bug resulted from a misunderstanding of an API, library, or system behavior, document the correct mental model.
- Include prevention recommendations that are specific and actionable, not generic advice.
- Do not invent details. Only document what is present in the session transcript.`;

    outputInstructions = `Format as a markdown postmortem document:

# Debug Postmortem: [Brief title describing the bug]

**Date:** [session date]
**Severity:** [Critical/High/Medium/Low — based on impact described in session]
**Time to resolve:** [Estimate based on session length]

## Symptoms Observed
What was wrong — exact error messages, unexpected behavior, failing tests. Be specific enough that someone encountering the same symptoms could find this document.

## Investigation Timeline
Chronological account of the debugging process:
1. **[First approach]** — What was tried, what was observed, what conclusion was drawn
2. **[Second approach]** — ...
3. ...

## Dead Ends
Approaches that did NOT work, and crucially, WHY they failed. This section prevents repeating failed approaches.
- **[Approach name]** — What was tried, why it seemed reasonable, and why it actually did not work
- ...

## Root Cause
The actual underlying issue. Explain at a technical level why the bug occurred. Include the relevant code, configuration, or system state that caused the problem.

## The Fix
What was changed and why it works. Include:
- File paths and specific code changes
- Why this fix addresses the root cause (not just the symptoms)
- Any trade-offs or limitations of the fix

## Prevention
How to avoid this class of bug in the future. Be specific:
- Code patterns to follow or avoid
- Tests to add
- Configuration checks
- Documentation to update`;

    buildUserPrompt(ctx: TemplateContext): string {
        return `${buildMetadataBlock(ctx)}

## Session Content

${ctx.sessionContent}

## Your Task

Analyze this session as a debugging investigation and produce a structured postmortem.

Trace through the session chronologically and identify:
1. **Initial symptoms** — What error messages, unexpected behavior, or failures were observed
2. **Each investigation step** — What was checked, what tools/commands were used, what was learned
3. **Dead ends** — Approaches that were tried but did not lead to the solution, and WHY they failed
4. **The breakthrough** — What observation or insight led to identifying the root cause
5. **Root cause** — The actual technical reason for the bug
6. **The fix** — What code/config changes resolved the issue
7. **Prevention** — Specific steps to avoid this class of issue in the future

Pay special attention to:
- The dead ends section is often the MOST valuable part. When an approach failed, explain exactly why — was it a wrong assumption? A misleading error message? A red herring in the logs?
- The root cause should be explained at a technical level, not just "X was wrong"
- Prevention recommendations should be specific and actionable, tied to the actual root cause

If the session contains multiple debugging efforts, document each one separately under a clear sub-heading.${ctx.customInstructions ? `\n\nAdditional instructions: ${ctx.customInstructions}` : ""}

## Output Format

${this.outputInstructions}`;
    }
}

export default DebugPostmortemTemplate;
