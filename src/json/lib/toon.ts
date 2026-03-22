import { decode, encode } from "@toon-format/toon";

/** Convert a JS value to TOON format string. */
export function toToon(data: unknown): string {
    return encode(data);
}

/** Parse a TOON format string back to a JS value. */
export function fromToon(toonStr: string): unknown {
    return decode(toonStr);
}
