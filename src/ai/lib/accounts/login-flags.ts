import type { AccountFeatures, LoginFlag } from "@genesiscz/utils/ai/providers/account-features";
import type { ProviderPlugin } from "@genesiscz/utils/ai/providers/plugin-types";
import { pluginsWithAccounts } from "@genesiscz/utils/ai/providers/registry";

/**
 * Whether the provider can bind a credential FILE at all, which is what the core's `--home`,
 * `--auth-file` and `--import-native` do. The door that offers those flags and the `runLogin`
 * check that refuses them both ask this, so `--help` never offers a flag the run can only refuse:
 * anthropic logs in through OAuth and has no file to bind.
 */
export function bindsCredentialFiles(plugin: ProviderPlugin): boolean {
    return plugin.credential.fields.includes("authFile");
}

/** One provider switch as a door declares it. */
export interface DoorFlag {
    flag: LoginFlag;
    /** Parsed for compatibility only, and left out of this door's `--help`. */
    hidden: boolean;
}

/**
 * The provider switches a door declares for one verb, in the order it declares them.
 *
 * A provider's own door shows that provider's switches, then parses, hidden, every other provider's
 * switch marked `acceptedOnEveryDoor`. The provider-neutral door (no `provider`) shows every
 * provider's switches, since only `--provider` at run time decides whose flow reads them.
 */
export function doorFlags(
    provider: string | undefined,
    declared: (features: AccountFeatures) => readonly LoginFlag[]
): DoorFlag[] {
    const owned: DoorFlag[] = [];
    const borrowed: DoorFlag[] = [];
    const names = new Set<string>();

    for (const plugin of pluginsWithAccounts()) {
        const own = provider === undefined || plugin.id === provider;

        for (const flag of plugin.accounts ? declared(plugin.accounts) : []) {
            if (names.has(flag.name) || !(own || flag.acceptedOnEveryDoor)) {
                continue;
            }

            names.add(flag.name);
            (own ? owned : borrowed).push({ flag, hidden: !own });
        }
    }

    return [...owned, ...borrowed];
}

/** Every `login` switch that is another spelling of the default login, by `LoginFlag.name`. */
export function defaultLoginAliases(): string[] {
    const names = pluginsWithAccounts()
        .flatMap((plugin) => plugin.accounts?.loginFlags ?? [])
        .filter((flag) => flag.defaultLoginAlias === true)
        .map((flag) => flag.name);

    return [...new Set(names)];
}

/** The given switches that this provider declared: the only ones its flow is handed. */
export function ownFlags(given: ReadonlySet<string> | undefined, declared: readonly LoginFlag[]): ReadonlySet<string> {
    return new Set(declared.map((flag) => flag.name).filter((name) => given?.has(name) === true));
}
