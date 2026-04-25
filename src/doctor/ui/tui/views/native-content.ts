import { RGBA, type TextTableContent } from "@opentui/core";
import type { Row } from "./types";

// text_table packs cell chunks via Bun FFI, which expects RGBA instances
// for fg/bg (it reads `.buffer` as a Float32Array). Hex strings would hit
// `BigInt(val)` inside the pointer packer → "Failed to parse String to
// BigInt". Convert at the drawer boundary.

const rgbaCache = new Map<string, RGBA>();

export function toRgba(color: string | undefined): RGBA | undefined {
    if (color === undefined) {
        return undefined;
    }

    const cached = rgbaCache.get(color);

    if (cached) {
        return cached;
    }

    const rgba = RGBA.fromHex(color);
    rgbaCache.set(color, rgba);
    return rgba;
}

export function toNativeContent(rows: Row[]): TextTableContent {
    return rows.map((row) =>
        row.map((cell) =>
            cell.map((chunk) => ({
                text: chunk.text,
                fg: toRgba(chunk.fg),
                bg: toRgba(chunk.bg),
            }))
        )
    ) as unknown as TextTableContent;
}
