---
status: Accepted
date: 2026-11-24
---

# Give every instruction for an agent one shape

A command that tells an agent what to do next prints it with `outputAgentInstructions` from
`src/utils/ai/agent-instructions.ts`. A library or a REPL method throws `AgentInstructionsError` instead. The block
starts with `==== FOR AGENTS ... ====`. A stop ends with "Ask the user, and proceed only after the user confirms.",
so an agent that keeps only the last line still reads it, and the command exits non-zero. Under `--json` the
instruction is `{ agentInstructions: { severity, stop, text } }`. A sentence written for each refusal reads
differently in every tool, and an agent cannot tell an instruction from an ordinary failure to retry.

Martin's decision D443 (2026-11-24): an agent's `voices add` and `voices enroll` ask the user in the confirmation
window, and they instruct the agent through this util.
