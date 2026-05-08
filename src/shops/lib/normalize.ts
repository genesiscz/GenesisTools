import { removeDiacritics } from "@app/utils/string";

export function normalizeText(s: string): string {
    return removeDiacritics(s).toLowerCase().replace(/\s+/g, " ").trim();
}
