import { captureResponseBody } from "@app/ai-proxy/lib/usage/capture-response";

export interface PipelineResult {
    response: Response;
    responseBody: Promise<string>;
}

export function pipelineResult(response: Response, responseBody?: Promise<string> | string): PipelineResult {
    if (responseBody !== undefined) {
        return {
            response,
            responseBody: typeof responseBody === "string" ? Promise.resolve(responseBody) : responseBody,
        };
    }

    const captured = captureResponseBody(response);

    return {
        response: captured.response,
        responseBody: captured.responseBody,
    };
}
