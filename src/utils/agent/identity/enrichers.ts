import { accountEnvVar, accountOfEnv } from "@genesiscz/utils/ai/account-env";
import { harnessOfRuntimeAgent } from "@genesiscz/utils/ai/providers/harness-index";
import { logger } from "@genesiscz/utils/logger";
import { t3codeCallerEnricher } from "@genesiscz/utils/t3code/caller-enricher";
import {
    type CallerTerminals,
    readTerminalInto,
    TERMINAL_ENRICHERS,
    TERMINAL_ENV_KEYS,
    TERMINAL_IDS,
} from "./terminals";
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
    envKeys: (caller) => {
        const harness = harnessOfRuntimeAgent(caller.agent);
        return harness ? [accountEnvVar(harness)] : [];
    },
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
 * Every terminal of `TERMINAL_ENRICHERS` the environment names, each read on its own: a failed reader leaves the
 * other terminals.
 */
export const terminalCallerEnricher: ContextEnricher<"terminal"> = {
    id: "terminal",
    envKeys: () => TERMINAL_ENV_KEYS,
    enrich: ({ env }) => {
        const terminals: CallerTerminals = {};

        for (const id of TERMINAL_IDS) {
            try {
                readTerminalInto(id, env, terminals);
            } catch (error) {
                log.debug(
                    { error, terminal: id },
                    "agent-context: a terminal reader failed; the other terminals stand"
                );
            }
        }

        return Object.keys(terminals).length > 0 ? terminals : undefined;
    },
};

/**
 * Every enricher, one per subject, in a static table: no discovery, no registration. Each writes only its own slot
 * (`place`), so no enricher can touch the caller's harness or session. The terminals are one enricher over their own
 * table (`TERMINAL_ENRICHERS`), so cmux and tmux sit side by side and a new terminal is a row there.
 * A custom-env enricher (named fields from the caller's env, validated, never a dump of entries) would be one more
 * entry here; none is built yet.
 */
const ENRICHERS: { readonly [Id in EnricherId]: ContextEnricher<Id> } = {
    terminal: terminalCallerEnricher,
    t3code: t3codeCallerEnricher,
    account: accountCallerEnricher,
};

/** Every variable an enricher reads for this caller, each once: what a remote caller's process env is read for. */
export function callerEnvKeys(caller: EnricherView["caller"]): string[] {
    const ids = Object.keys(ENRICHERS) as EnricherId[];
    return [...new Set(ids.flatMap((id) => ENRICHERS[id].envKeys(caller)))];
}

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
    terminal: {
        field: "terminal",
        put: (identity, value) => {
            identity.terminal = { ...identity.terminal, ...value };

            for (const id of TERMINAL_IDS) {
                if (value[id] !== undefined) {
                    identity.sources[`terminal.${id}`] = TERMINAL_ENRICHERS[id].source;
                }
            }
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
