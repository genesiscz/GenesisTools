import { accountOfEnv } from "@genesiscz/utils/ai/account-env";
import { harnessOfRuntimeAgent } from "@genesiscz/utils/ai/providers/harness-index";
import { cmuxCallerEnricher } from "@genesiscz/utils/cmux/caller-enricher";
import { logger } from "@genesiscz/utils/logger";
import { t3codeCallerEnricher } from "@genesiscz/utils/t3code/caller-enricher";
import { tmuxCallerEnricher } from "@genesiscz/utils/tmux/caller-enricher";
import type { AgentIdentity, ContextEnricher, EnricherId, EnricherSlots, EnricherView } from "./types";

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

/** Where each enricher's slot goes in the identity, and the field its source is recorded under. */
const PLACE: {
    readonly [Id in EnricherId]: {
        field: "terminal" | "host" | "account";
        put: (identity: AgentIdentity, value: EnricherSlots[Id]) => void;
    };
} = {
    cmux: {
        field: "terminal",
        put: (identity, value) => {
            identity.terminal = { ...identity.terminal, cmux: value };
        },
    },
    tmux: {
        field: "terminal",
        put: (identity, value) => {
            identity.terminal = { ...identity.terminal, tmux: value };
        },
    },
    t3code: {
        field: "host",
        put: (identity, value) => {
            identity.host = value;
        },
    },
    account: {
        field: "account",
        put: (identity, value) => {
            identity.account = value;
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
        identity.sources[PLACE[id].field] = id;
    }
}

/** Run every enricher over a local caller's identity, in place. */
export function enrichIdentity(identity: AgentIdentity, view: EnricherView): void {
    for (const id of Object.keys(ENRICHERS) as EnricherId[]) {
        runEnricher(id, identity, view);
    }
}
