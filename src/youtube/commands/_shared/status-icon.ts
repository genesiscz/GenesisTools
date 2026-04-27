import type { JobStatus } from "@app/youtube/lib/types";
import pc from "picocolors";

export function statusIcon(status: JobStatus): string {
    switch (status) {
        case "pending":
            return pc.dim("◌");
        case "running":
            return pc.cyan("▶");
        case "completed":
            return pc.green("✓");
        case "failed":
            return pc.red("✗");
        case "cancelled":
            return pc.dim("⨯");
        case "interrupted":
            return pc.yellow("⚡");
    }
}

export function freshnessLabel(cachedAtIso: string | null, ttlDays: number): string {
    if (!cachedAtIso) {
        return pc.dim("—");
    }

    const ageMs = Date.now() - new Date(cachedAtIso).getTime();
    const days = ageMs / 86_400_000;

    if (days >= ttlDays) {
        return pc.red(`expired (${days.toFixed(1)}d)`);
    }

    if (days > ttlDays * 0.66) {
        return pc.yellow(`${days.toFixed(1)}d`);
    }

    return pc.green(`${days.toFixed(1)}d`);
}
