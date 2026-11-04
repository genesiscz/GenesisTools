import { type DashboardClient, ENDPOINTS, type PreparedPromptDto } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

/** One saved prompt as the Mac lists it (`listPrompts` in `src/hub/lib/prompts.ts`). */
export interface SavedPromptRow {
    name: string;
    description: string | null;
    variables: string[];
    uses: number;
}

export const promptKeys = {
    list: ["prompts", "list"] as const,
    prepare: (name: string, session: string | null, vars: Record<string, string>) =>
        ["prompts", "prepare", name, session, vars] as const,
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** The gateway's prompt list, read defensively: the row is typed `unknown` on the wire. */
export function asPromptRows(value: unknown): SavedPromptRow[] {
    const rows = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.prompts) ? value.prompts : [];
    return rows.filter(isRecord).flatMap((row) =>
        typeof row.name === "string"
            ? [
                  {
                      name: row.name,
                      description: typeof row.description === "string" ? row.description : null,
                      variables: Array.isArray(row.variables)
                          ? row.variables.filter((name): name is string => typeof name === "string")
                          : [],
                      uses: typeof row.uses === "number" ? row.uses : 0,
                  },
              ]
            : []
    );
}

export function promptsQuery(client: DashboardClient) {
    return queryOptions<SavedPromptRow[]>({
        queryKey: promptKeys.list,
        queryFn: async () => asPromptRows(await client.call(ENDPOINTS.gatewayPrompts, {})),
    });
}

/** The prompt rendered for one session on the Mac: each variable's value and source (prompt prepare). */
export function prepareQuery(
    client: DashboardClient,
    input: { name: string; session: string | null; vars: Record<string, string> }
) {
    return queryOptions<PreparedPromptDto>({
        queryKey: promptKeys.prepare(input.name, input.session, input.vars),
        queryFn: () =>
            client.call(ENDPOINTS.gatewayPromptPrepare, {
                name: input.name,
                ...(input.session ? { session: input.session } : {}),
                vars: JSON.stringify(input.vars),
            }),
    });
}
