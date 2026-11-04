import { accountOfEnv } from "@genesiscz/utils/ai/account-env";
import { harnessOfRuntimeAgent } from "@genesiscz/utils/ai/providers/harness-index";
import { cmuxCallerEnricher } from "@genesiscz/utils/cmux/caller-enricher";
import { logger } from "@genesiscz/utils/logger";
import { t3codeCallerEnricher } from "@genesiscz/utils/t3code/caller-enricher";
import { tmuxCallerEnricher } from "@genesiscz/utils/tmux/caller-enricher";
import type {
    AgentIdentity,
    CallerHost,
    ContextEnricher,
    EnricherId,
    EnricherSlots,
    EnricherView,
    IdentityField,
} from "./types";

const { log } = logger.scoped("agent-context");

/**
 * The account a local caller's harness bills, from its launcher's stamp (`accountEnvVar(alias)` of the caller's own
 * harness, so a Codex caller reads the Codex stamp). An unknown caller or Copilot has no alias and gets no key, never
 * a borrowed one. The stamp keeps whether it names an account or a proxy target (`accountFromEnv`).
 */
export const accountCallerEnricher: ContextEnricher<"account"> = {
    id: "account",
    enrich: ({ caller, env }) => {
        const harness = harnessOfRuntimeAgent(caller.agent);

        if (!harness) {
            return undefined;
        }

        const live = accountOfEnv(env, harness);
        return live.account === null && live.proxyTarget === null ? undefined : { harness, ...live };
    },
};

/**
 * Every enricher, one per subject, in a static table: no discovery, no registration. Each writes only its own slot
 * (`place`), so cmux and tmux sit side by side and neither can touch the caller's harness or session.
 * A custom-env enricher (named fields from the caller's env, validated, never a dump of entries) would be one more
 * entry here; none is built yet.
 */
const ENRICHERS: { readonly [Id in EnricherId]: ContextEnricher<Id> } = {
    cmux: cmuxCallerEnricher,
    tmux: tmuxCallerEnricher,
    t3code: t3codeCallerEnricher,
    account: accountCallerEnricher,
};

/** Whether a host slot carries more than its env thread id: the details only the host's own store gives. */
function hasHostDetails(host: CallerHost): boolean {
    return Object.keys(host).some((key) => key !== "app" && key !== "threadId");
}

/**
 * Where each enricher's slot goes in the identity, and the source it records there. `field` is the identity field
 * the slot fills: an override of that field wins, so its enricher does not run. Each observation records its own
 * source path, so a cmux surface and a tmux pane in one `terminal` keep their own provenance.
 */
const PLACE: {
    readonly [Id in EnricherId]: {
        field: Extract<IdentityField, "terminal" | "host" | "account">;
        put: (identity: AgentIdentity, value: EnricherSlots[Id]) => void;
    };
} = {
    cmux: {
        field: "terminal",
        put: (identity, value) => {
            identity.terminal = { ...identity.terminal, cmux: value };
            identity.sources["terminal.cmux"] = "cmux";
        },
    },
    tmux: {
        field: "terminal",
        put: (identity, value) => {
            identity.terminal = { ...identity.terminal, tmux: value };
            identity.sources["terminal.tmux"] = "tmux";
        },
    },
    t3code: {
        field: "host",
        put: (identity, value) => {
            identity.host = value;
            identity.sources["host.threadId"] = "t3code";

            if (hasHostDetails(value)) {
                identity.sources["host.details"] = "t3code-store";
            }
        },
    },
    account: {
        field: "account",
        put: (identity, value) => {
            identity.account = value;
            identity.sources.account = "account";
        },
    },
};

function runEnricher<Id extends EnricherId>(id: Id, identity: AgentIdentity, view: EnricherView): void {
    let value: EnricherSlots[Id] | undefined;

    try {
        value = ENRICHERS[id].enrich(view);
    } catch (error) {
        log.debug({ error, enricher: id }, "agent-context: an enricher failed; the other facts stand");
        return;
    }

    log.debug({ enricher: id, found: value !== undefined }, "agent-context: enricher");

    if (value !== undefined) {
        PLACE[id].put(identity, value);
    }
}

/**
 * Run every enricher over a local caller's identity, in place. A field the caller of `whoIsCalling` gave (`given`,
 * the override keys) is an answer already: its enricher does not run, so it neither replaces the value nor reads.
 */
export function enrichIdentity(identity: AgentIdentity, view: EnricherView, given: ReadonlySet<IdentityField>): void {
    for (const id of Object.keys(ENRICHERS) as EnricherId[]) {
        if (!given.has(PLACE[id].field)) {
            runEnricher(id, identity, view);
        }
    }
}
