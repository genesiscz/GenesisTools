import qrcode from "qrcode-terminal";

export interface QrOptions {
    /** Error correction level. 'L' = ~7%, 'M' = ~15%, 'Q' = ~25%, 'H' = ~30%. Default 'L' for compactness. */
    level?: "L" | "M" | "Q" | "H";
    /** Render in half-block (small) mode. Default true — looks good in modern terminals. */
    small?: boolean;
}

/**
 * Render a QR code for `input` as a string of unicode block characters,
 * suitable for printing to a terminal. Synchronous despite the underlying
 * library's callback API — qrcode-terminal invokes the callback synchronously.
 */
export function renderQr(input: string, opts: QrOptions = {}): string {
    let out = "";
    // `errorLevel` is honored by qrcode-terminal at runtime but is missing
    // from the upstream type definitions. Widen via a local interface so
    // we can pass it without an `any` cast.
    interface GenerateOpts {
        small?: boolean;
        errorLevel?: "L" | "M" | "Q" | "H";
    }
    const generateOpts: GenerateOpts = {
        small: opts.small ?? true,
        errorLevel: opts.level ?? "L",
    };
    qrcode.generate(input, generateOpts as Parameters<typeof qrcode.generate>[1], (rendered: string) => {
        out = rendered;
    });
    return out;
}
