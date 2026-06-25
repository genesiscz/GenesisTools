import { isResponsesShapedBody } from "@app/ai-proxy/lib/translators/formats/openai/detect";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";

export { isResponsesShapedBody } from "@app/ai-proxy/lib/translators/formats/openai/detect";

export function detectCursorRequest(req: Request, bodyText: string): boolean {
    const userAgent = req.headers.get("User-Agent") ?? "";
    const looksLikeCursor = /cursor/i.test(userAgent);

    try {
        const parsed = SafeJSON.parse(bodyText);
        return looksLikeCursor || isResponsesShapedBody(parsed);
    } catch (err) {
        logger.debug({ err, userAgent }, "ai-proxy: detectCursorRequest parse failed");
        return looksLikeCursor;
    }
}
