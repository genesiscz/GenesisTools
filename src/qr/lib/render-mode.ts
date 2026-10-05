/**
 * The full-size QR is drawn with ANSI background colours, so without a colour terminal it comes
 * out as escape codes (a pipe, a file, an agent) or as blank lines (NO_COLOR). The half-block
 * mode is plain Unicode and reads anywhere. An explicit `--small` always wins.
 */
export function useSmallRendering(input: { small: boolean | undefined; isTTY: boolean; noColor: boolean }): boolean {
    if (input.small !== undefined) {
        return input.small;
    }

    return !input.isTTY || input.noColor;
}
