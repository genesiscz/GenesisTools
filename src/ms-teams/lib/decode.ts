/**
 * Teams IndexedDB strings often arrive as a Python-bytes repr of Latin-1 code
 * points (`b'Nab\\xeddky 2.0'` → `Nabídky 2.0`), or as already-decoded text.
 * Always run user-facing fields through this before compare or export.
 */
export function decodeTeamsString(input: unknown): string {
    if (input === null || input === undefined) {
        return "";
    }

    if (typeof input !== "string") {
        if (typeof input === "number" || typeof input === "boolean") {
            return String(input);
        }

        return "";
    }

    const trimmed = input.trim();

    if (trimmed === "" || trimmed === "<Undefined>" || trimmed === "undefined") {
        return "";
    }

    const repr = matchPythonBytesRepr(trimmed);

    if (repr !== null) {
        return unescapePythonString(repr);
    }

    return unescapePythonString(input);
}

function matchPythonBytesRepr(value: string): string | null {
    if (value.length >= 3 && value.startsWith("b'") && value.endsWith("'")) {
        return value.slice(2, -1);
    }

    if (value.length >= 3 && value.startsWith('b"') && value.endsWith('"')) {
        return value.slice(2, -1);
    }

    return null;
}

function unescapePythonString(value: string): string {
    let out = "";

    for (let i = 0; i < value.length; i++) {
        const ch = value[i];

        if (ch !== "\\") {
            out += ch;
            continue;
        }

        const next = value[i + 1];

        if (next === undefined) {
            out += "\\";
            break;
        }

        if (next === "x" && i + 3 < value.length) {
            const hex = value.slice(i + 2, i + 4);

            if (/^[0-9a-fA-F]{2}$/.test(hex)) {
                out += String.fromCharCode(Number.parseInt(hex, 16));
                i += 3;
                continue;
            }
        }

        if (next === "u" && i + 5 < value.length) {
            const hex = value.slice(i + 2, i + 6);

            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
                out += String.fromCharCode(Number.parseInt(hex, 16));
                i += 5;
                continue;
            }
        }

        const simple: Record<string, string> = {
            n: "\n",
            r: "\r",
            t: "\t",
            "\\": "\\",
            "'": "'",
            '"': '"',
            a: "\u0007",
            b: "\b",
            f: "\f",
            v: "\v",
        };

        if (simple[next] !== undefined) {
            out += simple[next];
            i += 1;
            continue;
        }

        out += next;
        i += 1;
    }

    return out;
}

/** Case-fold and strip diacritics for name matching. */
export function foldTeamsText(input: unknown): string {
    return decodeTeamsString(input).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}
