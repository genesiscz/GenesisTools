import type { Mapping } from "./types";

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function restore(text: string, mapping: Mapping): string {
    const tokens = Object.keys(mapping);
    if (tokens.length === 0) {
        return text;
    }

    const ordered = [...tokens].sort((a, b) => b.length - a.length);
    const re = new RegExp(ordered.map(escapeRegex).join("|"), "g");
    return text.replace(re, (match) => mapping[match] ?? match);
}
