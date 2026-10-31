import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { parseByteRange } from "@genesiscz/utils/http/range";
import { SafeJSON } from "@genesiscz/utils/json";

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

    const parsed = parseByteRange(range, size);

    if (parsed.kind !== "range") {
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
