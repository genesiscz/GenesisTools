import { Api } from "@app/azure-devops/api";
import { formatJSON } from "@app/azure-devops/cache";
import { isInvertedWindow, localDay, parseDayBoundary } from "@app/azure-devops/lib/activity-days";
import { type RequestedUser, resolveRequestedUser } from "@app/azure-devops/lib/current-user";
import { DEFAULT_MAX_CANDIDATES, findMentions, TooManyCandidatesError } from "@app/azure-devops/lib/mentions";
import { requireConfig } from "@app/azure-devops/utils";
import * as p from "@clack/prompts";
import { suggestCommand } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import pc from "picocolors";

export interface MentionsOptions {
    user?: string;
    from?: string;
    to?: string;
    maxCandidates?: string;
    output: string;
}

const DEFAULT_WINDOW_DAYS = 7;
const OUTPUT_FORMATS = ["table", "json"];

interface MentionRow {
    workItemId: number;
    title: string;
    commentId: number;
    author: string;
    date: string;
    text: string;
}

export async function handleHistoryMentions(options: MentionsOptions): Promise<void> {
    const output = options.output ?? "table";

    if (!OUTPUT_FORMATS.includes(output)) {
        out.error(`Unknown output format '${output}'. Possible values: ${OUTPUT_FORMATS.join(", ")}`);
        out.println(
            suggestCommand("tools azure-devops history mentions", {
                add: ["-o", "json"],
                subcommand: ["history", "mentions"],
            })
        );
        process.exitCode = 1;
        return;
    }

    const quiet = output === "json";
    const config = requireConfig();
    const api = new Api(config);
    const from = options.from ? parseDayBoundary(options.from) : defaultFrom();
    const to = options.to ? parseDayBoundary(options.to, { endOfDay: true }) : undefined;

    if (Number.isNaN(from.getTime())) {
        out.error(`Invalid --from '${options.from}': expected a date such as 2026-09-07`);
        process.exitCode = 1;
        return;
    }

    if (to && Number.isNaN(to.getTime())) {
        out.error(`Invalid --to '${options.to}': expected a date such as 2026-09-14`);
        process.exitCode = 1;
        return;
    }

    if (isInvertedWindow(from, to)) {
        out.error(`--to '${options.to}' is before --from '${options.from}', so the window matches nothing.`);
        process.exitCode = 1;
        return;
    }

    // `Number.parseInt` stops at the first non-digit, so `--max-candidates 12abc` passed the check
    // below as 12 while its message promises a whole number.
    const maxCandidates = options.maxCandidates === undefined ? DEFAULT_MAX_CANDIDATES : Number(options.maxCandidates);

    if (!Number.isInteger(maxCandidates) || maxCandidates < 1) {
        out.error(`Invalid --max-candidates '${options.maxCandidates}': expected a whole number of 1 or more`);
        process.exitCode = 1;
        return;
    }

    let requested: RequestedUser;

    try {
        requested = await resolveRequestedUser({
            user: options.user ?? "@me",
            teamMembers: () => api.getTeamMembers(),
        });
    } catch (err) {
        out.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
    }

    const userName = requested.name;

    if (!quiet) {
        // Naming only the start read as an open-ended search even when --to had bounded it.
        const window = to ? `${localDay(from)} → ${localDay(to)}` : `since ${localDay(from)}`;
        p.log.info(`Mentions of ${pc.bold(userName)}, ${pc.bold(window)}`);

        if (!requested.verified) {
            // The index holds the name AS WRITTEN, so a missing accent returns no candidates, and
            // no candidates is indistinguishable from "nobody ever named this person".
            p.log.warn(
                `The team roster did not confirm '${userName}', so the history index is searched ` +
                    `for that exact spelling. A different one, a missing accent for instance, finds nothing.`
            );
        }
    }

    let result: Awaited<ReturnType<typeof findMentions>>;

    try {
        result = await findMentions({
            userName,
            from,
            to,
            maxCandidates,
            runWiql: async (wiql) => {
                const response = await api.runWiql(wiql);

                return response.workItems.map((item) => item.id);
            },
            fetchComments: (ids) => api.batchGetComments(ids),
        });
    } catch (err) {
        if (!(err instanceof TooManyCandidatesError)) {
            throw err;
        }

        out.error(err.message);
        out.println(
            suggestCommand("tools azure-devops history mentions", {
                add: ["--max-candidates", String(err.candidateCount)],
                subcommand: ["history", "mentions"],
            })
        );
        process.exitCode = 1;
        return;
    }

    const titles = await loadTitles({
        api,
        ids: [...new Set(result.mentions.map((mention) => mention.workItemId))],
    });
    const rows: MentionRow[] = result.mentions.map((mention) => ({
        ...mention,
        title: titles.get(mention.workItemId) ?? "",
    }));

    if (output === "json") {
        out.println(
            formatJSON({
                user: userName,
                // The table door prints a warning for this; clack writes to stdout, so the JSON
                // door cannot, and carries the same fact as a field instead.
                userVerified: requested.verified,
                from: from.toISOString(),
                to: to?.toISOString() ?? null,
                candidates: { count: result.candidateIds.length, ids: result.candidateIds },
                mentions: rows,
            })
        );
        return;
    }

    renderMentions({ rows, candidates: result.candidateIds.length, userName });
}

function defaultFrom(): Date {
    const from = new Date();
    from.setDate(from.getDate() - DEFAULT_WINDOW_DAYS);
    from.setHours(0, 0, 0, 0);

    return from;
}

async function loadTitles({ api, ids }: { api: Api; ids: number[] }): Promise<Map<number, string>> {
    const titles = new Map<number, string>();

    if (ids.length === 0) {
        return titles;
    }

    // `batchGetFullWorkItems` expands every field and every relation, and the only thing read here
    // is the title. Same number of requests, a fraction of the payload.
    const items = await api.getWorkItemFields(ids, ["System.Title"]);

    for (const [id, fields] of items) {
        const title = fields["System.Title"];

        if (typeof title === "string") {
            titles.set(id, title);
        }
    }

    logger.debug(`[mentions] resolved ${titles.size}/${ids.length} work item titles`);

    return titles;
}

function renderMentions({
    rows,
    candidates,
    userName,
}: {
    rows: MentionRow[];
    candidates: number;
    userName: string;
}): void {
    renderCliHeader("Mentions", userName);

    if (rows.length === 0) {
        out.println(
            pc.dim(`  No comment named this person in the window. ${candidates} candidate(s) came off the index.`)
        );
        return;
    }

    const table = createBoxTable(["WORK ITEM", "WHEN", "BY", "COMMENT"]);

    for (const row of rows) {
        table.push([
            `${pc.white(`#${row.workItemId}`)}\n${pc.dim(truncateDisplay(row.title, 34))}`,
            pc.dim(row.date.slice(0, 16).replace("T", " ")),
            truncateDisplay(row.author, 20),
            truncateDisplay(row.text, 60),
        ]);
    }

    out.println(table.toString());

    const itemCount = new Set(rows.map((row) => row.workItemId)).size;
    const indexOnly = candidates - itemCount;
    out.println(
        pc.dim(
            `  ${rows.length} mention(s) in ${itemCount} work item(s) · ` +
                `${candidates} index candidate(s), ${indexOnly} of them index-only`
        )
    );
}
