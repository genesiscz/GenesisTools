import { type DashboardClient, ENDPOINTS, type SnapReceiptDto, type UploadReceipt } from "@dd/contract";
import naclUtil from "tweetnacl-util";

/** A finger stroke on the photo, in canvas points. */
export interface Stroke {
    points: Array<{ x: number; y: number }>;
}

/** An SVG path for a stroke (Skia's `Path` takes the same string). */
export function strokePath(stroke: Stroke): string {
    const [first, ...rest] = stroke.points;

    if (!first) {
        return "";
    }

    return [`M ${first.x.toFixed(1)} ${first.y.toFixed(1)}`, ...rest.map((point) => `L ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)].join(" ");
}

/** Uploads the marked-up photo (JPEG bytes as base64) and attaches it to the session's draft on the Mac. */
export async function snapToSession(
    client: DashboardClient,
    input: { jpegBase64: string; provider: string; sessionId: string; name?: string; idempotencyKey: string }
): Promise<SnapReceiptDto> {
    const bytes = naclUtil.decodeBase64(input.jpegBase64);
    // A copy owns a plain ArrayBuffer, which the upload body takes (a view's buffer may be shared).
    const data = Uint8Array.from(bytes).buffer;
    const upload: UploadReceipt = await client.call(
        ENDPOINTS.gatewayUpload,
        {},
        { rawBody: { data, contentType: "image/jpeg" }, idempotencyKey: `${input.idempotencyKey}-upload` }
    );
    return client.call(
        ENDPOINTS.snap,
        { path: upload.path, provider: input.provider, sessionId: input.sessionId, ...(input.name ? { name: input.name } : {}) },
        { idempotencyKey: input.idempotencyKey }
    );
}
