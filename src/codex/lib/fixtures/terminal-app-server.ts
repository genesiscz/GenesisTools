import { SafeJSON } from "@genesiscz/utils/json";

let loggedIn = false;
for await (const line of console) {
    const request = SafeJSON.parse(line, { strict: true });
    if (!request.method || request.id === undefined) {
        continue;
    }
    let result: object;
    if (request.method === "initialize") {
        result = { userAgent: "fixture", platformFamily: "unix", platformOs: "macos" };
    } else if (request.method === "account/login/start") {
        loggedIn = request.params.type === "chatgptAuthTokens" && request.params.chatgptAccountId === "workspace-a";
        result = { type: "chatgptAuthTokens" };
    } else {
        result = { account: loggedIn ? { type: "chatgpt", email: "selected@example.test" } : null };
    }
    if (request.method === "account/read" && loggedIn) {
        process.stdout.write(
            `${SafeJSON.stringify({ method: "thread/started", params: { thread: { id: "fixture-thread" } } })}\n`
        );
    }
    process.stdout.write(`${SafeJSON.stringify({ id: request.id, result })}\n`);
}
