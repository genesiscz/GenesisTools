// GENERATED CODE SNAPSHOT — codex-cli 0.144.5 (`codex app-server generate-ts`).

export const CODEX_SCHEMA_VERSION = "0.144.5";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type AskForApproval =
    | "untrusted"
    | "on-request"
    | {
          granular: {
              sandbox_approval: boolean;
              rules: boolean;
              skill_approval: boolean;
              request_permissions: boolean;
              mcp_elicitations: boolean;
          };
      }
    | "never";

export interface InitializeParams {
    clientInfo: {
        name: string;
        title: string | null;
        version: string;
    };
    capabilities: null;
}

export interface ThreadStartParams {
    model?: string | null;
    cwd?: string | null;
    approvalPolicy?: AskForApproval | null;
    sandbox?: SandboxMode | null;
    config?: Record<string, JsonValue> | null;
    serviceName?: string | null;
    baseInstructions?: string | null;
    developerInstructions?: string | null;
    ephemeral?: boolean | null;
}

export type UserInput = {
    type: "text";
    text: string;
    text_elements: [];
};

export interface TurnStartParams {
    threadId: string;
    input: UserInput[];
    model?: string | null;
    effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | null;
}

export interface TurnInterruptParams {
    threadId: string;
    turnId: string;
}

export interface ThreadRollbackParams {
    threadId: string;
    numTurns: number;
}

export interface ThreadReadParams {
    threadId: string;
    includeTurns: boolean;
}

export interface ThreadUnsubscribeParams {
    threadId: string;
}

export type ReviewTarget =
    | { type: "uncommittedChanges" }
    | { type: "baseBranch"; branch: string }
    | { type: "commit"; sha: string; title: string | null }
    | { type: "custom"; instructions: string };

export interface ReviewStartParams {
    threadId: string;
    target: ReviewTarget;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
