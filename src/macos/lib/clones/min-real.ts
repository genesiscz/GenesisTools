/** `--min-real` is a positive whole number of bytes. `Number.parseInt` alone
 *  accepts `-1` and `12abc`; a negative floor disables the native walk and
 *  turns the advertised large-file scan into a walk and hash of every file
 *  under every root. Returns null for anything that is not a positive integer. */
export function parseMinReal(raw: string): number | null {
    const text = raw.trim();
    if (!/^\d+$/.test(text)) {
        return null;
    }

    const value = Number(text);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}
