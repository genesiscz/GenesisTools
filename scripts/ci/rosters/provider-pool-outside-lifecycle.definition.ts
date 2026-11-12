import { callTo, defineRoster } from "./define";

/** C14 and C16: each model door took a provider from the pool and built its "unavailable" answer itself. */
export default defineRoster({
    name: "roster-provider-pool-outside-lifecycle",
    candidate: "C16",
    message:
        'Take a provider and answer "unavailable" through the one request lifecycle in ' +
        "src/ai-proxy/lib/request-lifecycle.ts; a door that calls the pool itself skips its cooldown and release.",
    matcher: callTo(["acquireProvider", "providerUnavailableResponse"]),
    onlyIn: /^src\//,
    allowedIn: /^src\/ai-proxy\/lib\/(?:request-lifecycle|providers\/pool)\.ts$/,
});
