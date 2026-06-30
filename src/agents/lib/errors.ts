import { out } from "@app/logger";

export class FriendlyError extends Error {
    public readonly hint?: string;

    constructor(message: string, hint?: string) {
        super(message);
        this.name = "FriendlyError";
        this.hint = hint;
    }
}

export async function runWithFriendlyErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        if (err instanceof FriendlyError) {
            out.log.error(err.message);

            if (err.hint) {
                process.stderr.write(`\n${err.hint}\n`);
            }

            process.exit(1);
        }

        const msg = err instanceof Error ? err.message : String(err);
        out.log.error(msg);
        process.exit(1);
    }
}

export function listAvailableNames(records: { agent_name: string }[]): string {
    if (records.length === 0) {
        return "(none registered)";
    }

    return records.map((r) => r.agent_name).join(", ");
}

export function listAvailableIds(records: { agent_id: string; agent_name: string }[]): string {
    const visible = records.filter((r) => r.agent_id !== "");

    if (visible.length === 0) {
        return "(none registered)";
    }

    return visible.map((r) => `${r.agent_id} (${r.agent_name})`).join(", ");
}
