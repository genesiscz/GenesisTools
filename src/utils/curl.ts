export interface ParsedCurl {
    url: string;
    method: string;
    headers: Record<string, string>;
    cookies: Record<string, string>;
    body: string | null;
}

/**
 * Tokenize a shell command string, respecting single/double quotes and backslash escapes.
 * Handles multi-line continuation with trailing `\`.
 */
function tokenize(input: string): string[] {
    // Join continuation lines (trailing backslash + newline)
    const joined = input.replace(/\\\r?\n\s*/g, " ");

    const tokens: string[] = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;
    let isEscaped = false;

    for (let i = 0; i < joined.length; i++) {
        const ch = joined[i];

        if (isEscaped) {
            // In double quotes, only certain chars are special after backslash
            if (inDouble && ch !== '"' && ch !== "\\" && ch !== "$" && ch !== "`") {
                current += "\\";
            }
            current += ch;
            isEscaped = false;
            continue;
        }

        if (ch === "\\" && !inSingle) {
            isEscaped = true;
            continue;
        }

        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
            continue;
        }

        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            continue;
        }

        if (!inSingle && !inDouble && /\s/.test(ch)) {
            if (current.length > 0) {
                tokens.push(current);
                current = "";
            }
            continue;
        }

        current += ch;
    }

    if (current.length > 0) {
        tokens.push(current);
    }

    return tokens;
}

/**
 * Parse a semicolon-separated cookie string into key-value pairs.
 * Handles values with `=` in them (e.g. base64).
 */
function parseCookieString(cookieStr: string): Record<string, string> {
    const cookies: Record<string, string> = {};

    for (const part of cookieStr.split(";")) {
        const trimmed = part.trim();

        if (!trimmed) {
            continue;
        }

        const eqIdx = trimmed.indexOf("=");

        if (eqIdx === -1) {
            cookies[trimmed] = "";
        } else {
            const key = trimmed.slice(0, eqIdx).trim();
            const value = trimmed.slice(eqIdx + 1).trim();
            cookies[key] = value;
        }
    }

    return cookies;
}

/**
 * Parse a cURL command string into structured components.
 *
 * Handles:
 * - Multi-line commands with `\` continuations
 * - Single and double quoted values
 * - `-X`/`--request` for method
 * - `-H`/`--header` for headers (including `Cookie:` header)
 * - `-b`/`--cookie` for cookies
 * - `--data-raw`, `--data`, `-d` for request body
 * - `--url` or positional argument for URL
 * - `--compressed`, `--insecure`, `-k`, `-L`, `-v`, `-s` flags (ignored)
 * - Default method: GET (POST if body present)
 */
export function parseCurl(curlString: string): ParsedCurl {
    const tokens = tokenize(curlString.trim());

    if (tokens.length === 0) {
        throw new Error("Empty cURL command");
    }

    // Strip leading 'curl' if present
    let startIdx = 0;

    if (tokens[0] === "curl") {
        startIdx = 1;
    }

    let url = "";
    let method = "";
    const headers: Record<string, string> = {};
    let cookies: Record<string, string> = {};
    let body: string | null = null;

    // Flags that take no argument
    const noArgFlags = new Set([
        "--compressed",
        "--insecure",
        "-k",
        "-L",
        "--location",
        "-v",
        "--verbose",
        "-s",
        "--silent",
        "-S",
        "--show-error",
        "-f",
        "--fail",
        "-I",
        "--head",
        "-N",
        "--no-buffer",
        "--http2",
        "--http1.1",
        "--http1.0",
        "--tr-encoding",
        "--globoff",
        "-g",
    ]);

    for (let i = startIdx; i < tokens.length; i++) {
        const token = tokens[i];

        if (noArgFlags.has(token)) {
            if (token === "-I" || token === "--head") {
                method = method || "HEAD";
            }
            continue;
        }

        if (token === "-X" || token === "--request") {
            i++;

            if (i < tokens.length) {
                method = tokens[i].toUpperCase();
            }
            continue;
        }

        if (token === "-H" || token === "--header") {
            i++;

            if (i < tokens.length) {
                const headerStr = tokens[i];
                const colonIdx = headerStr.indexOf(":");

                if (colonIdx !== -1) {
                    const key = headerStr.slice(0, colonIdx).trim();
                    const value = headerStr.slice(colonIdx + 1).trim();

                    // Check for Cookie header
                    if (key.toLowerCase() === "cookie") {
                        cookies = { ...cookies, ...parseCookieString(value) };
                    } else {
                        headers[key] = value;
                    }
                }
            }
            continue;
        }

        if (token === "-b" || token === "--cookie") {
            i++;

            if (i < tokens.length) {
                cookies = { ...cookies, ...parseCookieString(tokens[i]) };
            }
            continue;
        }

        if (token === "--data-raw" || token === "--data" || token === "-d" || token === "--data-binary") {
            i++;

            if (i < tokens.length) {
                body = tokens[i];
            }
            continue;
        }

        if (token === "--data-urlencode") {
            i++;

            if (i < tokens.length) {
                body = (body ? `${body}&` : "") + tokens[i];
            }
            continue;
        }

        if (token === "--url") {
            i++;

            if (i < tokens.length) {
                url = tokens[i];
            }
            continue;
        }

        // Skip flags that take an argument but we don't care about
        if (
            token === "-o" ||
            token === "--output" ||
            token === "-u" ||
            token === "--user" ||
            token === "--connect-timeout" ||
            token === "--max-time" ||
            token === "-m" ||
            token === "--retry" ||
            token === "-A" ||
            token === "--user-agent" ||
            token === "-e" ||
            token === "--referer" ||
            token === "--resolve" ||
            token === "--cacert" ||
            token === "--cert" ||
            token === "--key" ||
            token === "-w" ||
            token === "--write-out" ||
            token === "--proxy" ||
            token === "-x"
        ) {
            i++;
            continue;
        }

        // Positional argument = URL (if it looks like a URL)
        if (!token.startsWith("-") && !url) {
            url = token;
        }
    }

    // Default method
    if (!method) {
        method = body !== null ? "POST" : "GET";
    }

    if (!url) {
        throw new Error("No URL found in cURL command");
    }

    return { url, method, headers, cookies, body };
}
