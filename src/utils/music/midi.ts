import { type Score, scoreSchema } from "./types";

const PPQ = 480;

interface Event {
    tick: number;
    order: number;
    bytes: number[];
}

function variable(value: number): number[] {
    const bytes = [value & 0x7f];

    let remaining = Math.floor(value / 128);

    while (remaining > 0) {
        bytes.unshift((remaining & 0x7f) | 0x80);
        remaining = Math.floor(remaining / 128);
    }

    return bytes;
}

function chunk(name: string, bytes: Uint8Array): Buffer {
    const head = Buffer.alloc(8);
    head.write(name, 0);
    head.writeUInt32BE(bytes.length, 4);
    return Buffer.concat([head, bytes]);
}

function track(events: Event[], end: number): Buffer {
    const bytes: number[] = [];
    let previous = 0;

    for (const event of events.sort((a, b) => a.tick - b.tick || a.order - b.order)) {
        bytes.push(...variable(event.tick - previous), ...event.bytes);
        previous = event.tick;
    }

    bytes.push(...variable(Math.max(0, end - previous)), 0xff, 0x2f, 0);
    return chunk("MTrk", Uint8Array.from(bytes));
}

/** Type-1 MIDI, with note-offs ordered before simultaneous note-ons. */
export function encodeMidi(input: Score): Buffer {
    const score = scoreSchema.parse(input);
    const tempo = Math.round(60_000_000 / score.bpm);
    const ticks = (seconds: number) => Math.round((seconds * 1_000_000 * PPQ) / tempo);
    const end = ticks(score.seconds);
    const tracks = [
        track(
            [
                {
                    tick: 0,
                    order: 0,
                    bytes: [0xff, 0x51, 3, (tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255],
                },
            ],
            end
        ),
    ];
    let pitched = 0;

    for (const part of score.parts) {
        let channel = 9;

        if (!part.percussion) {
            if (pitched === 9) {
                pitched++;
            }

            channel = pitched++;
        }
        const events: Event[] = [
            { tick: 0, order: -3, bytes: [0xc0 | channel, part.program] },
            { tick: 0, order: -2, bytes: [0xb0 | channel, 7, part.volume] },
            { tick: 0, order: -1, bytes: [0xb0 | channel, 10, part.pan] },
        ];

        for (const note of part.notes) {
            const start = ticks(note.at);
            events.push(
                { tick: start, order: 1, bytes: [0x90 | channel, note.midi, note.velocity] },
                {
                    tick: Math.max(start + 1, ticks(note.at + note.duration)),
                    order: 0,
                    bytes: [0x80 | channel, note.midi, 0],
                }
            );
        }

        tracks.push(track(events, end));
    }

    const header = Buffer.alloc(6);
    header.writeUInt16BE(1, 0);
    header.writeUInt16BE(tracks.length, 2);
    header.writeUInt16BE(PPQ, 4);
    return Buffer.concat([chunk("MThd", header), ...tracks]);
}
