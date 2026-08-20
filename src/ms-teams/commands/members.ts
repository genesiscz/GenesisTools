import { openCache } from "@app/ms-teams/lib/cache";
import { printPeople } from "@app/ms-teams/lib/display";
import { parseShowQuery } from "@app/ms-teams/lib/query";
import { resolveConversation } from "@app/ms-teams/lib/resolve-chat";
import type { Person } from "@app/ms-teams/lib/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

export function registerMembersCommand(program: Command): void {
    program
        .command("members [query...]")
        .description("Show the roster of a conversation")
        .option("--id <threadId>", "Exact conversation id")
        .option("--json", "Machine-readable JSON")
        .action((queryParts: string[], opts: { id?: string; json?: boolean }) => {
            const cache = openCache();

            try {
                const resolved = resolveConversation(cache, {
                    ...parseShowQuery((queryParts ?? []).join(" ")),
                    id: opts.id,
                });

                if (resolved.status !== "exact") {
                    out.println("Could not resolve a single conversation. Pass --id.");
                    return;
                }

                let members: Person[] = [];

                try {
                    members = SafeJSON.parse(resolved.conversation.membersJson);
                } catch {
                    members = [];
                }

                if (opts.json) {
                    out.result(members);
                    return;
                }

                printPeople(
                    members.map((m) => ({
                        mri: m.mri,
                        displayName: m.displayName,
                        email: m.email,
                        upn: m.email,
                    }))
                );
            } finally {
                cache.close();
            }
        });
}
