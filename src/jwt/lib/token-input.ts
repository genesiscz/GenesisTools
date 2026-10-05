import { extractJwt, normalizeTokenText } from "@genesiscz/utils/jwt";
import { logger } from "@genesiscz/utils/logger";

export type TokenSource = "argument" | "clipboard" | "stdin";

export type TokenFailure = "none" | "both" | "clipboard";

export type TokenInput =
    | { ok: true; token: string; source: TokenSource }
    | { ok: false; failure: TokenFailure; error: string; clipboardHasJwt: boolean };

export interface ResolveTokenInputArgs {
    argToken?: string;
    clipboard?: boolean;
    interactive: boolean;
    readClipboard: () => Promise<string>;
    readStdin: () => Promise<string>;
}

async function clipboardHoldsJwt(readClipboard: () => Promise<string>): Promise<boolean> {
    try {
        return extractJwt(await readClipboard()) !== null;
    } catch (err) {
        logger.debug({ err }, "jwt: clipboard peek failed");
        return false;
    }
}

/** The token inside `text` when there is one; else the cleaned text, so `decodeJwt` can say what is wrong with it. */
function tokenFromText(text: string): string {
    return extractJwt(text) ?? normalizeTokenText(text);
}

/**
 * Picks the token from the argument, the clipboard (`--clipboard`) or piped stdin. With no argument on a terminal it
 * reads nothing, but it does look at the clipboard so the usage hint can offer `--clipboard`. Error texts never
 * quote what was read.
 */
export async function resolveTokenInput(args: ResolveTokenInputArgs): Promise<TokenInput> {
    const argToken = args.argToken ? tokenFromText(args.argToken) : "";

    if (args.clipboard && argToken.length > 0) {
        return {
            ok: false,
            failure: "both",
            error: "pass either a token or --clipboard, not both.",
            clipboardHasJwt: false,
        };
    }

    if (args.clipboard) {
        let text: string;
        try {
            text = await args.readClipboard();
        } catch (err) {
            logger.debug({ err }, "jwt: clipboard read failed");
            return { ok: false, failure: "clipboard", error: "could not read the clipboard.", clipboardHasJwt: false };
        }

        const token = extractJwt(text);
        if (token === null) {
            logger.debug({ length: text.length }, "jwt: clipboard holds no token");
            return {
                ok: false,
                failure: "clipboard",
                error: "the clipboard does not hold a JWT.",
                clipboardHasJwt: false,
            };
        }

        return { ok: true, token, source: "clipboard" };
    }

    if (argToken.length > 0) {
        return { ok: true, token: argToken, source: "argument" };
    }

    if (args.interactive) {
        return {
            ok: false,
            failure: "none",
            error: "no token provided.",
            clipboardHasJwt: await clipboardHoldsJwt(args.readClipboard),
        };
    }

    const piped = tokenFromText(await args.readStdin());
    if (piped.length > 0) {
        return { ok: true, token: piped, source: "stdin" };
    }

    return { ok: false, failure: "none", error: "no token provided.", clipboardHasJwt: false };
}
