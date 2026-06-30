import { logger } from "@app/logger";
import { isObject } from "@app/utils/object";

export function isStreamAbortError(err: unknown): boolean {
    if (err instanceof DOMException && err.name === "AbortError") {
        return true;
    }

    if (err instanceof Error && err.name === "AbortError") {
        return true;
    }

    if (isObject(err) && err.name === "AbortError") {
        return true;
    }

    return false;
}

export function safeStreamControllerError(
    controller: ReadableStreamDefaultController<Uint8Array>,
    err: unknown,
    closed: boolean
): boolean {
    if (closed || isStreamAbortError(err)) {
        return false;
    }

    try {
        controller.error(err);
        return true;
    } catch (controllerErr) {
        logger.debug({ err: controllerErr, originalErr: err }, "ai-proxy: controller.error() threw");

        return false;
    }
}
