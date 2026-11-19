import { nameKey, type RoomDevice, rosterAccountKey } from "@genesiscz/utils/meetings/people";
import { mappedMicrophone, withoutEmptyRemoteSeats } from "@genesiscz/utils/meetings/room-people";
import { type MeetingSeats, microphoneSide, type SeatSpan, seatSpan } from "@genesiscz/utils/meetings/seats";
import type { LineEvidence } from "@genesiscz/utils/transcribe/evidence";

export interface LineSpan {
    index: number;
    fromSec: number;
    toSec: number;
}

export interface ChannelReading {
    side: "mic" | "call" | "mixed" | "unknown";
    strong: boolean;
    source?: ChannelSource;
}

type Shares = Pick<LineEvidence, "micShare" | "energyMic">;
type ChannelSource = "segments" | "energy" | "both" | "none";
type ResolvedChannel = ChannelReading & { source: ChannelSource };

/** Segment overlap and calibrated energy measure different things. Neither breaks a disagreement. */
export function channelFor({ micShare, energyMic }: Shares): ResolvedChannel {
    const usable = (share: number | undefined): share is number => share !== undefined && share >= 0 && share <= 1;
    const segment = usable(micShare);
    const energy = usable(energyMic);
    const source = segment && energy ? "both" : segment ? "segments" : energy ? "energy" : "none";
    const shares = [micShare, energyMic].filter(usable);
    if (!shares.length) {
        return { side: "unknown", strong: false, source };
    }
    if (shares.every((share) => share < 0.5)) {
        return { side: "call", strong: shares.every((share) => share <= 0.35), source };
    }
    if (shares.every((share) => share > 0.5)) {
        return { side: "mic", strong: shares.every((share) => share >= 0.65), source };
    }
    return { side: "mixed", strong: false, source };
}

export function isPredominantlyCall(channel: ChannelReading): boolean {
    return channel.side === "call";
}

export function isStrongCallForNaming(channel: ChannelReading): boolean {
    return isPredominantlyCall(channel) && channel.strong;
}

/** Only a predominantly call line can exclude a transmitting account from its full-span mute. */
export function mutedAccountsFor(channel: ChannelReading, muted: readonly string[] | undefined): readonly string[] {
    return isPredominantlyCall(channel) ? (muted ?? []) : [];
}

type SpeakingFacts = Pick<LineEvidence, "speaking" | "speakingUnknown"> & { ignoredIndicator?: boolean };
export type SpeakingState = { kind: "speaking"; names: string[] } | { kind: "empty" | "unknown" | "ignored" };

export function speakingStateFor(facts: SpeakingFacts): SpeakingState {
    if (facts.ignoredIndicator) {
        return { kind: "ignored" };
    }
    if (facts.speakingUnknown) {
        return { kind: "unknown" };
    }
    const names = Object.keys(facts.speaking).filter((name) => facts.speaking[name]! > 0);
    return names.length ? { kind: "speaking", names } : { kind: "empty" };
}

type Stay = { fromSec: number; toSec?: number };
type Coverage = "full" | "partial" | "none";
export interface SpeakerFacts extends Shares, SpeakingFacts {
    seats?: MeetingSeats;
    selfName?: string;
    /** Meeting-local candidates, including guests with no people-book entry. */
    people?: readonly string[];
    /** Owner-confirmed roster accounts in the people book, including devices with no seat in this meeting. */
    devices?: readonly RoomDevice[];
    callStays?: ReadonlyArray<Stay & { name: string }>;
    /** Explicitly identified input for this line, by saved group id or device account. */
    endpoint?: string;
    /** C6's full-line mute coverage from lineEvidence, including resets and expiry. */
    muted?: readonly string[];
}

export interface Eligibility {
    channel: ChannelReading;
    choices: string[];
    excluded: Array<{ person: string; reason: string }>;
    reviewOnly: boolean;
}

/** Half-open intervals. Touching or overlapping rows cover a line only if there is no gap. */
function coverage(line: LineSpan, stays: readonly Stay[]): Coverage {
    const overlap = stays.filter(
        (stay) =>
            (stay.toSec ?? Infinity) > stay.fromSec &&
            stay.fromSec < line.toSec &&
            (stay.toSec ?? Infinity) > line.fromSec
    );
    if (!overlap.length) {
        return "none";
    }
    let end = line.fromSec;
    for (const stay of overlap.sort((a, b) => a.fromSec - b.fromSec)) {
        if (stay.fromSec > end) {
            break;
        }
        end = Math.max(end, stay.toSec ?? Infinity);
        if (end >= line.toSec) {
            return "full";
        }
    }
    return "partial";
}

function coverageByPerson(line: LineSpan, rows: ReadonlyArray<string | SeatSpan>): Map<string, Coverage> {
    const byPerson = new Map<string, Stay[]>();
    for (const row of rows) {
        const { name, fromSec = 0, toSec } = seatSpan(row);
        const key = nameKey(name);
        const stays = byPerson.get(key) ?? [];
        stays.push({ fromSec, toSec });
        byPerson.set(key, stays);
    }
    return new Map([...byPerson].map(([key, stays]) => [key, coverage(line, stays)]));
}

/** Physical occupancy and account attendance are independent clocks. A mapped call input transmits its
 * occupants through the device's account, even when an occupant's personal laptop is muted or offline. */
export function speakersFor(line: LineSpan, facts: SpeakerFacts): Eligibility {
    const { selfName, callStays = [] } = facts;
    const seats = withoutEmptyRemoteSeats(facts.seats);
    const channel = channelFor(facts);
    const speaking = speakingStateFor(facts);
    const shown = speaking.kind === "speaking" ? speaking.names : [];
    const mappings = new Map(facts.devices?.map((row) => [rosterAccountKey(row.account), row]));
    const human = (name: string) => !mappings.has(rosterAccountKey(name));
    const roomSeats = (seats?.room ?? []).filter((row) => human(seatSpan(row).name));
    const room = coverageByPerson(line, roomSeats);
    const remote = coverageByPerson(
        line,
        (seats?.remote ?? []).filter((row) => human(row.name))
    );
    const call = coverageByPerson(
        line,
        callStays.filter((row) => human(row.name))
    );
    const mutedAccounts = mutedAccountsFor(channel, facts.muted);
    const muted = new Set(mutedAccounts.filter(human).map(nameKey));
    const people = new Set(facts.people?.map(nameKey));
    const speakingKeys = new Set(shown.filter(human).map(nameKey));
    const micId = channel.side === "mic" ? (facts.endpoint ?? "self") : "self";
    const micMapping = mappings.get(rosterAccountKey(micId));
    const mic = micMapping
        ? seats?.microphones?.find((row) => row.id === micMapping.group)
        : mappedMicrophone(seats, micId);
    const micMembers = mic && new Set(mic.people.map(nameKey));
    const roomInput =
        seats && mic ? microphoneSide(seats, mic) === "room" : micMapping ? !micMapping.group : micId === "self";
    // A group id identifies a selected input. Only deviceId maps a roster account to that input.
    const deviceAccounts = new Map(
        (seats?.microphones ?? []).flatMap((group) =>
            group.deviceId ? [[rosterAccountKey(group.deviceId), group] as const] : []
        )
    );
    const indicated = facts.endpoint ?? (shown.length === 1 ? shown[0] : undefined);
    const localGroup =
        facts.endpoint !== undefined
            ? mappedMicrophone(seats, facts.endpoint)
            : indicated
              ? deviceAccounts.get(rosterAccountKey(indicated))
              : undefined;
    const groupMappings = facts.endpoint ? facts.devices?.filter((row) => row.group === facts.endpoint) : undefined;
    const mapping =
        (indicated ? mappings.get(rosterAccountKey(indicated)) : undefined) ??
        (localGroup?.deviceId ? mappings.get(rosterAccountKey(localGroup.deviceId)) : undefined) ??
        (groupMappings?.length === 1 ? groupMappings[0] : undefined);
    const group = mapping?.group ? seats?.microphones?.find((row) => row.id === mapping.group) : undefined;
    const device = mapping
        ? {
              deviceId: mapping.account,
              people: mapping.group
                  ? group && seats && microphoneSide(seats, group) === "room"
                      ? group.people
                      : []
                  : roomSeats.map((row) => seatSpan(row).name),
          }
        : localGroup;
    const account = device?.deviceId;
    const deviceMuted =
        account !== undefined && mutedAccounts.some((other) => rosterAccountKey(other) === rosterAccountKey(account));
    const deviceStays = account
        ? callStays.filter((row) => rosterAccountKey(row.name) === rosterAccountKey(account))
        : [];
    const accountStay = deviceStays.length ? coverage(line, deviceStays) : undefined;
    const deviceAway = accountStay !== undefined && accountStay !== "full";
    const deviceSide = mapping ? "room" : seats && localGroup ? microphoneSide(seats, localGroup) : undefined;
    const occupants = new Set(device?.people.map(nameKey));
    const names = new Map<string, string>();
    const excluded: Eligibility["excluded"] = [];
    const listedDevices = new Set<string>();
    for (const name of [
        ...(facts.people ?? []),
        ...(seats?.room ?? []).map((row) => seatSpan(row).name),
        ...(seats?.remote ?? []).map((row) => row.name),
        ...callStays.map((stay) => stay.name),
        ...shown,
        ...(selfName ? [selfName] : []),
    ]) {
        const key = nameKey(name);
        if (!human(name)) {
            const id = rosterAccountKey(name);
            if (!listedDevices.has(id)) {
                listedDevices.add(id);
                excluded.push({ person: name, reason: "Mapped room device account." });
            }
            continue;
        }
        if (key && !names.has(key)) {
            names.set(key, name);
        }
    }

    const choices: string[] = [];
    let boundary = false;
    for (const [key, person] of names) {
        const roomCover = room.get(key);
        const remoteCover = remote.get(key);
        const callCover = call.get(key);
        const self = !!selfName && key === nameKey(selfName);
        const atMic = roomCover === "full" || (self && !room.size && !remoteCover);
        const micEligible = atMic && roomInput && (!micMembers || micMembers.has(key));
        const mappedAccount = deviceAccounts.get(rosterAccountKey(person));
        const onlyDevice = mappedAccount && !mappedAccount.people.some((member) => nameKey(member) === key);
        let callReason: string | undefined;
        if (device) {
            if (!occupants.has(key)) {
                callReason = "Not an occupant of the indicated device.";
            } else if (deviceMuted) {
                callReason = "The transmitting device is muted.";
            } else if (deviceAway) {
                callReason = "The transmitting device is outside its call stay.";
            } else if ((deviceSide === "room" ? roomCover : remoteCover) !== "full") {
                callReason = "Device occupancy does not cover the line.";
            }
        } else if (onlyDevice) {
            callReason = "Mapped device account.";
        } else if (muted.has(key)) {
            callReason = "The personal call account is muted.";
        } else if (callCover !== undefined && callCover !== "full") {
            callReason = "Call attendance does not cover the line.";
        } else if (roomCover === "partial" || remoteCover === "partial") {
            callReason = "The line crosses a seat boundary.";
        } else if ((roomCover === "full" || (self && remoteCover !== "full")) && !speakingKeys.has(key)) {
            callReason = "At the room microphone without an indicated call input.";
        } else if (
            remoteCover !== "full" &&
            callCover !== "full" &&
            !speakingKeys.has(key) &&
            (roomCover !== undefined || remoteCover !== undefined || !people.has(key))
        ) {
            callReason = "No call seat or attendance covers the line.";
        }
        boundary ||=
            roomCover === "partial" || remoteCover === "partial" || (channel.side !== "mic" && callCover === "partial");
        if (!onlyDevice && ((channel.side !== "call" && micEligible) || (channel.side !== "mic" && !callReason))) {
            choices.push(person);
        } else {
            excluded.push({
                person,
                reason:
                    channel.side === "mic"
                        ? "Outside this microphone's occupancy."
                        : (callReason ?? "Mapped device account."),
            });
        }
    }

    // A sole survivor on an open roster is still only an elimination. A separate positive identity can be
    // assessed by the naming rule. Here only the confirmed occupancy of an input can stand on its own.
    const knownInput = channel.side === "mic" ? room.size > 0 : device !== undefined && facts.endpoint !== undefined;
    return {
        channel,
        choices,
        excluded,
        reviewOnly: !channel.strong || !knownInput || boundary || choices.length !== 1,
    };
}
