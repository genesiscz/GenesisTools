export interface CapturedResponse {
    response: Response;
    responseBody: Promise<string>;
}

async function readStreamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        text += decoder.decode(value, { stream: true });
    }

    text += decoder.decode();

    return text;
}

export function captureResponseBody(response: Response): CapturedResponse {
    if (!response.body) {
        return {
            response,
            responseBody: Promise.resolve(""),
        };
    }

    const [clientStream, captureStream] = response.body.tee();
    const responseBody = readStreamToText(captureStream);

    return {
        response: new Response(clientStream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        }),
        responseBody,
    };
}
