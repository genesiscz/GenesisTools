import type { TimelyService } from "@app/timely/api/service";
import type { TimelyEvent } from "@app/timely/types/api";
import type { Storage } from "@app/utils/storage";

const CORPUS_TTL = "1 day";
const CORPUS_WINDOW_DAYS = 56; // 8 weeks

export interface CorpusEntry {
    eventId: number;
    day: string;
    daysAgo: number;
    projectId: number;
    projectName: string;
    note: string;
    from: string | null;
    to: string | null;
}

export async function loadEventCorpus(
    storage: Storage,
    service: TimelyService,
    accountId: number,
    today: Date = new Date()
): Promise<CorpusEntry[]> {
    const end = today.toISOString().slice(0, 10);
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - CORPUS_WINDOW_DAYS);
    const start = startDate.toISOString().slice(0, 10);

    const cacheKey = `corpus/events-${start}_${end}.json`;
    const events = await storage.getFileOrPut<TimelyEvent[]>(
        cacheKey,
        () => service.getAllEvents(accountId, { since: start, upto: end }),
        CORPUS_TTL
    );

    return events
        .filter((e) => e.project?.id)
        .map<CorpusEntry>((e) => {
            const dayDate = new Date(`${e.day}T00:00:00`);
            const daysAgo = Math.floor((today.getTime() - dayDate.getTime()) / 86_400_000);
            return {
                eventId: e.id,
                day: e.day,
                daysAgo,
                projectId: e.project!.id,
                projectName: e.project!.name,
                note: e.note ?? "",
                from: e.from ?? null,
                to: e.to ?? null,
            };
        });
}
