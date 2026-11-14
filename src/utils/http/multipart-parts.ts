/** The boundary a multipart body declares: the `boundary` parameter of its media type, else the body's first line. */
export function multipartBoundary(text: string, mimeType: string | undefined): string | null {
    const declared = /;\s*boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(mimeType ?? "");
    const boundary = declared?.[1] ?? declared?.[2];

    if (boundary) {
        return boundary;
    }

    const first = /^\s*--([^\r\n]+)/.exec(text);

    return first?.[1]?.trimEnd() ?? null;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Calls `redact(fieldName, value)` for every part of a multipart/form-data body. A part's value ends at the line that
 * holds the body's own boundary, never at any line that merely starts with `--`: a secret may contain such a line.
 * `redact` returns the replacement value, or null to keep the part. Without a boundary a part ends at the next `--`
 * line (the body is not valid multipart, so that is the best reading).
 */
export function redactMultipartParts(
    text: string,
    mimeType: string | undefined,
    redact: (name: string, value: string) => string | null
): string {
    const boundary = multipartBoundary(text, mimeType);
    const end = boundary === null ? "--" : `--${escapeRegExp(boundary)}`;
    const part = new RegExp(
        `(content-disposition:[^\\r\\n]*\\bname="([^"]*)"[^\\r\\n]*\\r?\\n(?:[^\\r\\n]+\\r?\\n)*\\r?\\n)([\\s\\S]*?)(?=\\r?\\n${end})`,
        "gi"
    );

    return text.replace(part, (whole, head: string, name: string, value: string) => {
        const masked = redact(name, value);

        return masked === null ? whole : `${head}${masked}`;
    });
}
