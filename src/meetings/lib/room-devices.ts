import {
    type DeviceDecision,
    latestDeviceDecisions,
    type RoomDeviceOffer,
    rosterAccountKey,
} from "@genesiscz/utils/meetings/people";
import { type MeetingRecord, type MeetingStore, voiceRootMeeting } from "@genesiscz/utils/meetings/record";
import { withoutEmptyRemoteSeats } from "@genesiscz/utils/meetings/room-people";
import { microphoneSide, seatSpan } from "@genesiscz/utils/meetings/seats";

/** The roster and saved microphone group must identify the same account. A room seat alone proves no device. */
function roomJoins(record: MeetingRecord) {
    const seats = withoutEmptyRemoteSeats(record.seats);
    if (!seats?.microphones?.length) {
        return [];
    }
    const joins = new Map<string, Array<number | undefined>>();
    const selves = new Set(
        [...record.participants, ...(record.attendance?.people ?? [])]
            .filter((row) => row.self)
            .map((row) => rosterAccountKey(row.name))
    );
    function join(name: string, at?: number) {
        const key = rosterAccountKey(name);
        const times = joins.get(key) ?? [];
        times.push(at);
        joins.set(key, times);
    }
    for (const row of record.participants) {
        const roster = row.stays?.filter((stay) => stay.source === "platform-roster" || stay.source === "attendance");
        if (roster?.length) {
            for (const stay of roster) {
                join(row.name, stay.fromSec);
            }
        } else if (row.from.includes("platform-roster")) {
            join(row.name, row.firstSeenSec);
        }
    }
    if (record.attendance && record.attendance.from !== "user") {
        for (const stay of record.attendance.people) {
            if (stay.toSec > stay.fromSec) {
                join(stay.name, stay.fromSec);
            }
        }
    }
    const spans = seats.room.map(seatSpan);
    return seats.microphones.flatMap((group) => {
        if (microphoneSide(seats, group) !== "room") {
            return [];
        }
        return (group.deviceId ? [group.deviceId] : group.people).flatMap((account) => {
            const key = rosterAccountKey(account);
            // The recorder normally belongs to the owner. Count a self account only when it is the named endpoint.
            if (!group.deviceId && selves.has(key)) {
                return [];
            }
            const times = joins.get(key);
            // A deviceId explicitly identifies the endpoint. For a group member require physical presence at join.
            const occupied =
                group.deviceId ||
                times?.some((at) =>
                    spans.some(
                        (span) =>
                            rosterAccountKey(span.name) === key &&
                            (at === undefined
                                ? !span.fromSec && span.toSec === undefined
                                : at >= (span.fromSec ?? 0) && at < (span.toSec ?? Infinity))
                    )
                );
            return times?.length && occupied ? [{ account, group: group.id }] : [];
        });
    });
}

export function roomDeviceOffers(options: {
    store: MeetingStore;
    history: readonly DeviceDecision[];
    minimum: number;
    meeting?: MeetingRecord;
}): RoomDeviceOffer[] {
    const { store, history, minimum, meeting } = options;
    const last = latestDeviceDecisions(history);
    const eligible = (account: string) => {
        const decision = last.get(rosterAccountKey(account));
        return !decision || decision.action === "unmap";
    };
    const here = meeting && roomJoins(meeting).filter((row) => eligible(row.account));
    if (here?.length === 0) {
        return [];
    }
    const candidates = new Map<string, Map<string, { account: string; roots: Set<string> }>>();
    for (const record of store.list()) {
        let root: string | undefined;
        for (const { account, group } of roomJoins(record)) {
            const key = rosterAccountKey(account);
            if (
                !eligible(account) ||
                (here && !here.some((row) => rosterAccountKey(row.account) === key && row.group === group))
            ) {
                continue;
            }
            const groups = candidates.get(key) ?? new Map<string, { account: string; roots: Set<string> }>();
            const evidence = groups.get(group) ?? { account, roots: new Set<string>() };
            root ??= voiceRootMeeting(store, record);
            evidence.roots.add(root);
            groups.set(group, evidence);
            candidates.set(key, groups);
        }
    }
    const offers: RoomDeviceOffer[] = [];
    for (const groups of candidates.values()) {
        const strongest = [...groups]
            .filter(([, row]) => row.roots.size >= minimum)
            .sort(([a, x], [b, y]) => y.roots.size - x.roots.size || a.localeCompare(b))[0];
        if (strongest) {
            const [group, { account, roots }] = strongest;
            offers.push({ account, group, meetings: [...roots].sort(), question: `Is ${account} the room's device?` });
        }
    }
    return offers.sort((a, b) => a.account.localeCompare(b.account));
}
