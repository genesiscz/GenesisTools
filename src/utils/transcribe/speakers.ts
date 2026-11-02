import type { Participant } from "./types";

export function speakerLabel(participants: Participant[], speakerId: number | undefined): string {
    const named = participants.find((p) => p.speakerId === speakerId);

    if (named) {
        return named.name;
    }

    return speakerId === undefined ? "Unknown" : `Speaker ${speakerId}`;
}

export function firstName(name: string): string {
    return name.split(/\s+/)[0] ?? name;
}
