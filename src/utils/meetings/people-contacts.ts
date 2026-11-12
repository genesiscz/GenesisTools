import { meetingsConfigSetCommand } from "@genesiscz/utils/genesis-tools/tools/system";
import { logger } from "@genesiscz/utils/logger";
import { createIdleCloser, DarwinKit, type IdleCloser } from "@genesiscz/utils/macos/darwinkit";
import { describeResponsibleIdentity } from "@genesiscz/utils/macos/genesis-app";
import type { PeopleQuery, PeopleSource, SourceAnswer, SourcePerson } from "./people-directory";

/** How long a Contacts call may take; the first call can wait on the macOS access dialog. */
const CONTACTS_TIMEOUT_MS = 30_000;

/** One contact as darwinkit answers it: the names, the organization and the addresses the directory reads. */
export interface ContactCard {
    given_name: string;
    family_name: string;
    organization_name: string;
    email_addresses: Array<{ value: string }>;
}

interface ContactsAccess {
    status: string;
    authorized: boolean;
}

/** Existing injected readers remain supported; the native reader uses an atomic query below. */
export interface ContactsReader {
    authorized(): Promise<ContactsAccess>;
    search(query: string, limit: number): Promise<ContactCard[]>;
    list(limit: number): Promise<ContactCard[]>;
}

/** Authorization and its fetch belong to one native client generation. */
interface ContactsQueryReader {
    read(query: PeopleQuery): Promise<{ access: ContactsAccess; cards: ContactCard[] }>;
}

interface ContactsClient {
    contacts: {
        authorized(options: { timeout: number }): Promise<ContactsAccess>;
        search(
            query: { query: string; limit: number },
            options: { timeout: number }
        ): Promise<{ contacts: ContactCard[] }>;
        list(query: { limit: number }, options: { timeout: number }): Promise<{ contacts: ContactCard[] }>;
    };
    close(): Promise<void>;
}

interface ContactsGeneration {
    client: ContactsClient;
    closer: IdleCloser;
    closed: Promise<void>;
    retired: boolean;
}

let sharedContactsReader: ContactsQueryReader | undefined;

/**
 * Contacts owns its helper: native authorization can stay stale after either grant change. Completed reads retire
 * their generation; overlapping reads share it until their leases finish. Short-lived directories share this owner.
 */
export function darwinkitContacts(options: { createClient?: () => ContactsClient } = {}): ContactsQueryReader {
    if (options.createClient) {
        return createContactsReader(options.createClient);
    }

    sharedContactsReader ??= createContactsReader(() => new DarwinKit({ timeout: 60_000, logger, logLevel: "warn" }));
    return sharedContactsReader;
}

function createContactsReader(createClient: () => ContactsClient): ContactsQueryReader {
    let current: ContactsGeneration | undefined;
    let acquiring: Promise<ContactsGeneration> | undefined;
    let closing: Promise<void> | undefined;

    function createGeneration(): ContactsGeneration {
        const client = createClient();
        let closeClient = () => {};
        const closed = new Promise<void>((resolve, reject) => {
            closeClient = () => {
                Promise.resolve()
                    .then(() => client.close())
                    .then(resolve, reject);
            };
        });
        return { client, closer: createIdleCloser(closeClient), closed, retired: false };
    }

    async function acquire(): Promise<{ generation: ContactsGeneration; release: () => void }> {
        if (current) {
            return { generation: current, release: current.closer.lease() };
        }

        acquiring ??= (async () => {
            // A completed generation may still have another query's fetch in flight. Do not accumulate helpers.
            await closing;
            current = createGeneration();
            return current;
        })().finally(() => {
            acquiring = undefined;
        });
        const generation = await acquiring;
        return { generation, release: generation.closer.lease() };
    }

    function retire(generation: ContactsGeneration): void {
        if (generation.retired) {
            return;
        }

        generation.retired = true;
        current = undefined;
        closing = generation.closed;
        // Close failure remains observable on the next acquisition; never spawn over a helper that failed to close.
        void closing.catch(() => undefined);
        generation.closer.closeWhenIdle();
    }

    return {
        async read(query) {
            const { generation, release } = await acquire();
            const { contacts } = generation.client;
            try {
                const access = await contacts.authorized({ timeout: CONTACTS_TIMEOUT_MS });

                if (!access.authorized) {
                    return { access, cards: [] };
                }

                const result = query.text
                    ? await contacts.search({ query: query.text, limit: query.limit }, { timeout: CONTACTS_TIMEOUT_MS })
                    : await contacts.list({ limit: query.limit }, { timeout: CONTACTS_TIMEOUT_MS });
                return { access, cards: result.contacts };
            } finally {
                retire(generation);
                release();
            }
        },
    };
}

/** A contact as a person: the full name (else the organization) and the first email. */
export function contactPerson(card: ContactCard): SourcePerson | undefined {
    const name = `${card.given_name} ${card.family_name}`.trim() || card.organization_name.trim();

    if (!name) {
        return undefined;
    }

    const email = card.email_addresses.map((address) => address.value.trim()).find((value) => value.length > 0);
    const organization = card.organization_name.trim();
    return {
        name,
        ...(email ? { email } : {}),
        ...(organization && organization !== name ? { organization } : {}),
    };
}

/**
 * The address book (R23, R24). A query searches it; an empty query lists the first contacts. Access that is not
 * granted answers `refused` with the fix, never an empty list, so a picker can say why Contacts is missing.
 */
export class ContactsPeopleSource implements PeopleSource {
    readonly kind = "contacts" as const;

    constructor(private readonly reader: ContactsReader | ContactsQueryReader = darwinkitContacts()) {}

    async people(query: PeopleQuery): Promise<SourceAnswer> {
        const { access, cards } =
            "read" in this.reader ? await this.reader.read(query) : await readLegacyContacts(this.reader, query);

        if (!access.authorized) {
            const host = describeResponsibleIdentity();
            return {
                state: "refused",
                reason: `Contacts access is ${access.status} for ${host}. Turn it on in System Settings > Privacy & Security > Contacts, or turn the source off: ${meetingsConfigSetCommand()} global.people.sources.contacts false`,
            };
        }

        return { state: "ok", people: cards.flatMap((card) => contactPerson(card) ?? []) };
    }
}

/** Keep previously injected readers compatible without splitting the native generation's lease. */
async function readLegacyContacts(reader: ContactsReader, query: PeopleQuery) {
    const access = await reader.authorized();
    const cards = !access.authorized
        ? []
        : query.text
          ? await reader.search(query.text, query.limit)
          : await reader.list(query.limit);
    return { access, cards };
}
