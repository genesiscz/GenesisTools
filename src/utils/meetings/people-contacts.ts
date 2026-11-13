import { meetingsConfigSetCommand } from "@genesiscz/utils/genesis-tools/tools/system";
import { getDarwinKit } from "@genesiscz/utils/macos/darwinkit";
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

/** What the Contacts source asks of macOS: the access state, and a search or a list. Tests pass a fake. */
export interface ContactsReader {
    authorized(): Promise<{ status: string; authorized: boolean }>;
    search(query: string, limit: number): Promise<ContactCard[]>;
    list(limit: number): Promise<ContactCard[]>;
}

/** Contacts through darwinkit, in this process: the process must hold GenesisTools.app's Contacts grant. */
export function darwinkitContacts(): ContactsReader {
    return {
        authorized: () => getDarwinKit().contacts.authorized({ timeout: CONTACTS_TIMEOUT_MS }),
        search: async (query, limit) =>
            (await getDarwinKit().contacts.search({ query, limit }, { timeout: CONTACTS_TIMEOUT_MS })).contacts,
        list: async (limit) =>
            (await getDarwinKit().contacts.list({ limit }, { timeout: CONTACTS_TIMEOUT_MS })).contacts,
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

    constructor(private readonly reader: ContactsReader = darwinkitContacts()) {}

    async people(query: PeopleQuery): Promise<SourceAnswer> {
        const access = await this.reader.authorized();

        if (!access.authorized) {
            const host = describeResponsibleIdentity();
            return {
                state: "refused",
                reason: `Contacts access is ${access.status} for ${host}. Turn it on in System Settings > Privacy & Security > Contacts, or turn the source off: ${meetingsConfigSetCommand()} global.people.sources.contacts false`,
            };
        }

        const cards = query.text
            ? await this.reader.search(query.text, query.limit)
            : await this.reader.list(query.limit);
        return { state: "ok", people: cards.flatMap((card) => contactPerson(card) ?? []) };
    }
}
