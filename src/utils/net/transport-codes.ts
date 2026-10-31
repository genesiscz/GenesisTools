/**
 * Error codes that mean the request never got an answer: no DNS, no route, a refused, reset or timed-out
 * connection. Node's `http` and `dns` use the `E*` codes, Bun's `fetch` the camel-case ones (verified on Bun 1.3.13:
 * a refused connection and an unresolvable host both surface as `ConnectionRefused` on some paths), undici the
 * `UND_ERR_*` ones. None of them says anything about the account, the token or the request itself.
 */
export const TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ECONNRESET",
    "ECONNABORTED",
    "ETIMEDOUT",
    "ENETUNREACH",
    "ENETDOWN",
    "EHOSTUNREACH",
    "EHOSTDOWN",
    "EPIPE",
    "ConnectionRefused",
    "ConnectionClosed",
    "FailedToOpenSocket",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
]);
