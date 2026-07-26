import { AiProxyRunner } from "./AiProxyRunner";
import { ClaudeCodeRunner } from "./ClaudeCodeRunner";
import { GrokRunner } from "./GrokRunner";
import type { Runner, RunnerSpec } from "./types";

export type { ReasoningEffort, Runner, RunnerCall, RunnerResult, RunnerSpec } from "./types";
export { AiProxyRunner, ClaudeCodeRunner, GrokRunner };

export function createRunner(spec: RunnerSpec): Runner {
    switch (spec.backend ?? "ai-proxy") {
        case "ai-proxy":
            return new AiProxyRunner(spec.model, { effort: spec.effort });
        case "claude-code":
            return new ClaudeCodeRunner(spec.ccProfile ?? "", spec.model);
        case "grok":
            return new GrokRunner(spec.model, { binPath: spec.grokBin, poolSize: spec.grokPoolSize });
    }
}
