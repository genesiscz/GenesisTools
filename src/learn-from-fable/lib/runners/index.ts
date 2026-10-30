import { AiProxyRunner } from "./AiProxyRunner";
import { ClaudeCodeRunner } from "./ClaudeCodeRunner";
import { GrokRunner } from "./GrokRunner";
import type { Runner, RunnerSpec } from "./types";

export type { ReasoningEffort, Runner, RunnerCall, RunnerResult, RunnerSpec } from "./types";
export { AiProxyRunner, ClaudeCodeRunner, GrokRunner };

/** One factory per runner backend; a new backend is one entry here. */
const RUNNER_FACTORIES: Record<NonNullable<RunnerSpec["backend"]>, (spec: RunnerSpec) => Runner> = {
    "ai-proxy": (spec) => new AiProxyRunner(spec.model, { effort: spec.effort }),
    "claude-code": (spec) => new ClaudeCodeRunner(spec.ccProfile ?? "", spec.model),
    grok: (spec) => new GrokRunner(spec.model, { binPath: spec.grokBin, poolSize: spec.grokPoolSize }),
};

export function createRunner(spec: RunnerSpec): Runner {
    return RUNNER_FACTORIES[spec.backend ?? "ai-proxy"](spec);
}
