import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { DiscoveredHome } from "@genesiscz/utils/ai/providers/account-features";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { tryProviderPlugin } from "@genesiscz/utils/ai/providers/registry";
import { logger } from "@genesiscz/utils/logger";
import { AGENT_IDS, AGENT_PLUGIN_IDS, type AgentId } from "./drivers";

/**
 * What every ai-spend command needs before it can attribute a transcript to an
 * account: the enabled accounts of the three coding-agent providers, and — only
 * under `--all-homes` — the homes those providers can find on disk.
 *
 * It lives here rather than in `register.ts` because all THREE doors need it
 * (`monitor`, `series`, and the ccusage reports in `reports/commands.ts`), and a
 * behaviour that exists at one door and not another is exactly what this
 * campaign is undoing.
 *
 * The discovery is awaited HERE so the readers stay synchronous:
 * `buildMonitorReport` is sync end to end and every caller of it would otherwise
 * become async for a lookup that happens once per command.
 */
export interface SpendAccountsContext {
    accounts: AccountEntry[];
    /** Present only under `--all-homes`. */
    discoveredHomes?: Partial<Record<AgentId, DiscoveredHome[]>>;
}

export interface LoadSpendAccountsOptions {
    /** Walk every home on disk, including ones no account claims. */
    allHomes?: boolean;
}

/** ai-spend runs in its own process, so the plugins have to be registered in it. */
async function loadAgentAccounts(): Promise<AccountEntry[]> {
    registerBuiltInPlugins();

    const providers = AGENT_IDS.map((id) => AGENT_PLUGIN_IDS[id]);

    try {
        const store = await AiConfigStore.load();

        return store.accounts({ provider: providers, enabled: true });
    } catch (err) {
        // A missing or unreadable config is not a reason to refuse to report
        // spend: every root simply stays unbound, which is the pre-account
        // behaviour of this tool.
        logger.debug({ err }, "ai-spend: no usable AI config, transcripts stay unattributed");

        return [];
    }
}

async function discoverHomes(accounts: AccountEntry[]): Promise<Partial<Record<AgentId, DiscoveredHome[]>>> {
    const homes: Partial<Record<AgentId, DiscoveredHome[]>> = {};

    for (const agent of AGENT_IDS) {
        const discover = tryProviderPlugin(AGENT_PLUGIN_IDS[agent])?.accounts?.discoverHomes;

        if (!discover) {
            continue;
        }

        try {
            homes[agent] = await discover();
        } catch (err) {
            logger.debug({ err, agent }, "ai-spend: home discovery failed, that agent keeps its default roots");
        }
    }

    logger.debug(
        { accounts: accounts.length, agents: Object.keys(homes) },
        "ai-spend: discovered extra homes for --all-homes"
    );

    return homes;
}

export async function loadSpendAccountsContext(options: LoadSpendAccountsOptions = {}): Promise<SpendAccountsContext> {
    const accounts = await loadAgentAccounts();

    if (!options.allHomes) {
        return { accounts };
    }

    return { accounts, discoveredHomes: await discoverHomes(accounts) };
}
