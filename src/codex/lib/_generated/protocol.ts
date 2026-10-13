// GENERATED CODE SNAPSHOT — codex-cli 0.162.1 (`codex app-server generate-ts`, plus `--experimental` for the
// fields marked below). Trimmed to the types GenesisTools imports: an omitted field or union variant is not sent
// or not read here. Fields the server fills with `#[serde(default)]` are written optional, as in its JSON schema.

export const CODEX_SCHEMA_VERSION = "0.162.1";

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

export interface ClientInfo {
    name: string;
    title: string | null;
    version: string;
}

export interface InitializeCapabilities {
    /** Opt into receiving experimental API methods and fields. */
    experimentalApi?: boolean;
    /** Opt into `attestation/generate` requests for upstream `x-oai-attestation`. */
    requestAttestation?: boolean;
    /** Exact notification method names that should be suppressed for this connection. */
    optOutNotificationMethods?: string[] | null;
}

export interface InitializeParams {
    clientInfo: ClientInfo;
    capabilities: InitializeCapabilities | null;
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
    /** Experimental: the Codex Desktop project this thread belongs to. Needs the `experimentalApi` capability. */
    projectId?: string | null;
}

/** Only the text variant; 0.162.1 also has image, localImage, audio, localAudio, skill and mention inputs. */
export type UserInput = {
    type: "text";
    text: string;
    text_elements: [];
};

/** Any non-empty effort name the model accepts (`low`, `medium`, `high`, `xhigh`, …). */
export type ReasoningEffort = string;

export interface TurnStartParams {
    threadId: string;
    input: UserInput[];
    model?: string | null;
    effort?: ReasoningEffort | null;
}

export interface TurnInterruptParams {
    threadId: string;
    turnId: string;
}

/**
 * Replace a paginated thread's durable history with the prefix before one turn.
 * This only changes persisted conversation history. It does not revert local file changes.
 */
export interface ThreadRevertParams {
    threadId: string;
    /** Turn excluded from the replacement history, together with every later turn. */
    beforeTurnId: string;
}

export type SortDirection = "asc" | "desc";
export type TurnItemsView = "notLoaded" | "summary" | "full";
export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export interface Turn {
    id: string;
    status: TurnStatus;
}

export interface ThreadTurnsListParams {
    threadId: string;
    cursor?: string | null;
    limit?: number | null;
    /** Defaults to descending: the newest turn first. */
    sortDirection?: SortDirection | null;
    /** Defaults to summary. */
    itemsView?: TurnItemsView | null;
}

export interface ThreadTurnsListResponse {
    data: Turn[];
    /** Null when there are no more turns to return. */
    nextCursor: string | null;
    backwardsCursor: string | null;
}

export interface ThreadReadParams {
    threadId: string;
    includeTurns?: boolean;
}

export interface ThreadUnsubscribeParams {
    threadId: string;
}

export type ReviewTarget =
    | { type: "uncommittedChanges" }
    | { type: "baseBranch"; branch: string }
    | { type: "commit"; sha: string; title: string | null }
    | { type: "custom"; instructions: string };

export type ReviewDelivery = "inline" | "detached";

export interface ReviewStartParams {
    threadId: string;
    target: ReviewTarget;
    delivery?: ReviewDelivery | null;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
