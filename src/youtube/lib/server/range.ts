import { SafeJSON } from "@app/utils/json";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";

/**
 * Serves a file with HTTP Range support (206 partial content), the way
 * `<audio>`/`<video>` seeking requires. No `Range` header → full 200. A
 * malformed or out-of-bounds range → 416. `Accept-Ranges: bytes` is set on
 * BOTH the 200 and 206 responses — omitting it on the 200 is the usual cause
 * of a player that never lets the user seek despite the 206 path working.
 */
export async function serveFileWithRange(req: Request, path: string, contentType: string): Promise<Response> {
    const file = Bun.file(path);

    if (!(await file.exists())) {
        return new Response(SafeJSON.stringify({ error: "not found" }, { strict: true }), {
            status: 404,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
    }

    const size = file.size;
    const range = req.headers.get("Range");

    if (!range) {
        return new Response(file, {
            status: 200,
            headers: {
                ...CORS_HEADERS,
                "Content-Type": contentType,
                "Accept-Ranges": "bytes",
                "Content-Length": String(size),
            },
        });
    }

    const parsed = parseRange(range, size);

    if (!parsed) {
        return new Response(null, {
            status: 416,
            headers: { ...CORS_HEADERS, "Accept-Ranges": "bytes", "Content-Range": `bytes */${size}` },
        });
    }

    const { start, end } = parsed;

    return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: {
            ...CORS_HEADERS,
            "Content-Type": contentType,
            "Accept-Ranges": "bytes",
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Content-Length": String(end - start + 1),
        },
    });
}

function parseRange(header: string, size: number): { start: number; end: number } | null {
    const match = header.match(/^bytes=(\d*)-(\d*)$/);

    if (!match || (match[1] === "" && match[2] === "")) {
        return null;
    }

    let start: number;
    let end: number;

    if (match[1] === "") {
        // Suffix range ("bytes=-500") — last N bytes.
        const suffixLength = Number.parseInt(match[2], 10);
        start = Math.max(0, size - suffixLength);
        end = size - 1;
    } else {
        start = Number.parseInt(match[1], 10);
        end = match[2] === "" ? size - 1 : Number.parseInt(match[2], 10);
    }

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
        return null;
    }

    return { start, end: Math.min(end, size - 1) };
}
