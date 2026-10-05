const MAX_LEN = 40;

/** Strip control characters and cap the length of an operator name sent by a board client. */
export function sanitizeOperator(name: string): string {
    const printable = [...name]
        .filter((ch) => {
            const code = ch.codePointAt(0) ?? 0;
            return code >= 0x20 && code !== 0x7f;
        })
        .slice(0, MAX_LEN)
        .join("");

    return printable.trim();
}
