import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexSpec } from "@app/codex/lib/spec";
import { grokSpec } from "@app/grok/lib/spec";
import type { AgentSessionAdapter } from "@genesiscz/utils/agent-sessions/types";
import { logger } from "@genesiscz/utils/logger";
import { WORKER_CAPABILITIES } from "@genesiscz/utils/worker/capabilities";
import type { WorkerDriver, WorkerMeta } from "@genesiscz/utils/worker/driver";
import { WorkerMetaStore } from "@genesiscz/utils/worker/meta-store";
import { Command } from "commander";
import { registerAgentTool } from "./register";
import type { AgentToolSpec } from "./spec";

/**
 * The acceptance test for the whole parity campaign, in Martin's words: "it should be quite
 * easy to create a kimi agent tool which behaves similarly, but of course will have its own
 * specificity".
 *
 * So this builds a fourth coding-agent tool out of nothing but a spec — no command file, no
 * copied flag list — and asserts it answers the same verbs with the same flags as the three
 * real ones. If a later change reintroduces a per-tool command file, this test stops being
 * able to produce a working tool from a spec alone, and fails.
 *
 * ⚠️ One thing it deliberately does NOT prove: the fake spec reuses grok's alias and provider,
 * because a real fourth agent adds a member to `AccountProviderAlias` and a provider plugin.
 * That step is guarded by the compiler instead — every exhaustive `Record<Backend, …>` table
 * fails to build until the new member has a row, which is what Stage 0 of this campaign was
 * for.
 */

function fakeDriver(): WorkerDriver<WorkerMeta> {
    const dir = mkdtempSync(join(tmpdir(), "kimi-"));

    return {
        backend: "grok",
        store: new WorkerMetaStore<WorkerMeta>({
            dir: () => dir,
            metaPath: (name) => join(dir, `${name}.meta.json`),
            firstInvalidField: () => null,
            label: "kimi session",
            title: "Kimi session",
            existsMessage: (name) => `Kimi session '${name}' already exists.`,
            log: logger.child({ component: "kimi:test" }),
        }),
        help: { spawn: "turn 1", steer: "Steer it", read: "its turn report", tail: "Follow it" },
        spawn: async () => ({ kind: "ack", result: {} }),
        steer: async () => ({ kind: "ack", result: {} }),
        liveness: async () => ({ running: false }),
        interruptTurn: async () => undefined,
        readDefault: async () => undefined,
        rowHeaders: ["NAME"],
        row: (meta) => [meta.name],
    };
}

/** Everything a fourth tool has to supply. The provider is real: Kimi would ship a plugin. */
const kimiSpec: AgentToolSpec = {
    alias: "grok",
    provider: "grok-sub",
    description: "A fourth coding agent, built from a spec and nothing else",
    adapter: () => ({ kind: "grok", label: "Kimi" }) as unknown as AgentSessionAdapter,
    launcher: { launch: async () => undefined },
    worker: fakeDriver(),
    processScan: { classify: (args) => (args.includes("kimi") ? "tui" : null) },
};

/**
 * The verbs a spec produces, minus the hidden stubs for the ones its backend declares it
 * lacks. Those are per-backend by design (grok and claude have no approval channel, codex
 * does), so they are the one place where two tools legitimately differ.
 */
function verbsOf(spec: AgentToolSpec): string[] {
    const program = new Command();
    registerAgentTool(program, spec);
    const absent = new Set(Object.keys(WORKER_CAPABILITIES[spec.worker?.backend ?? spec.alias]?.absentVerbs ?? {}));

    return program.commands.map((command) => command.name()).filter((name) => !absent.has(name));
}

function flagsOf(spec: AgentToolSpec, verb: string): string[] {
    const program = new Command();
    registerAgentTool(program, spec);
    const command = program.commands.find((entry) => entry.name() === verb);

    if (!command) {
        throw new Error(`${spec.alias} has no ${verb} verb`);
    }

    return command.options.map((option) => option.long ?? option.short ?? "").sort();
}

test("a fourth tool built from a spec alone answers exactly the verbs its siblings do", () => {
    expect(verbsOf(kimiSpec)).toEqual(verbsOf(grokSpec));

    // Codex adds its own verbs beside the shared ones; it must never be MISSING one.
    for (const verb of verbsOf(kimiSpec)) {
        expect(verbsOf(codexSpec)).toContain(verb);
    }
});

/**
 * The flags each shared verb must carry on EVERY tool. Written out rather than derived, so
 * deleting one from the factory fails here instead of silently agreeing with itself: each of
 * these is a divergence this campaign closed.
 */
const REQUIRED_FLAGS: Record<string, string[]> = {
    run: ["--resume", "--continue", "--model", "--all", "--cwd"],
    resume: ["--account", "--list", "--all", "--limit", "--model"],
    spawn: ["--name", "--prompt", "--prompt-file", "--model", "--cwd", "--account"],
    steer: ["--name", "--prompt", "--prompt-file"],
    status: ["--name", "--json"],
    sessions: ["--json"],
    stop: ["--name"],
    interrupt: ["--name"],
    who: ["--json", "--all"],
    usage: ["--account", "--range", "--json", "--fresh"],
    login: ["--home", "--auth-file", "--import-native"],
};

test("the shared flags are the same on the new tool as on the real ones", () => {
    for (const [verb, required] of Object.entries(REQUIRED_FLAGS)) {
        for (const flag of required) {
            expect(flagsOf(kimiSpec, verb)).toContain(flag);
            expect(flagsOf(grokSpec, verb)).toContain(flag);
            expect(flagsOf(codexSpec, verb)).toContain(flag);
        }
    }

    // A real tool may ADD flags through `extendRun` / `extendSpawn` / `extendSteer`; it may
    // never drop one. Everything the bare spec produces has to be on the real tools too.
    for (const verb of Object.keys(REQUIRED_FLAGS)) {
        for (const flag of flagsOf(kimiSpec, verb)) {
            expect(flagsOf(grokSpec, verb)).toContain(flag);
            expect(flagsOf(codexSpec, verb)).toContain(flag);
        }
    }
});

test("a tool with no worker driver gets no worker verbs, rather than stubs that lie", () => {
    const { worker, ...noWorker } = kimiSpec;

    expect(worker).toBeDefined();
    expect(verbsOf(noWorker)).not.toContain("spawn");
    expect(verbsOf(noWorker)).toContain("run");
});
