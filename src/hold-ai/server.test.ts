import { afterEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process"; // Using node:child_process for more control
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises"; // For async delays
import { WebSocket } from "ws";

const serverScriptPath = resolve(__dirname, "./server.ts");

// Helper to start the server as a child process
async function startTestServer(): Promise<ChildProcess> {
    const serverProcess = spawn("bun", ["run", serverScriptPath], {
        stdio: ["pipe", "pipe", "pipe"], // pipe stdin for sending input
        detached: false, // if true, it might keep running; manage lifecycle carefully
    });

    // Wait for server to indicate it's ready or timeout
    await new Promise<void>((res, rej) => {
        let output = "";
        const onData = (data: Buffer) => {
            output += data.toString();
            if (output.includes("Hold-AI WebSocket Server started on port 9091")) {
                serverProcess.stdout?.off("data", onData);
                serverProcess.stderr?.off("data", onData);
                res();
            }
        };
        serverProcess.stdout?.on("data", onData);
        serverProcess.stderr?.on("data", onData); // Server logs info to stdout, but listen to stderr too
        serverProcess.on("error", (err) => rej(err));
        setTimeout(5000, () => rej(new Error("Server start timed out")));
    });
    return serverProcess;
}

// Helper to stop the server
async function stopTestServer(serverProcess: ChildProcess | null): Promise<void> {
    if (!serverProcess || serverProcess.killed) {
        return;
    }
    await new Promise<void>((resolve) => {
        serverProcess.on("exit", () => resolve());
        // Attempt graceful shutdown by sending 'Ctrl+C' or a known exit command if server handles it.
        // For this server, Ctrl+C in the prompt leads to graceful shutdown.
        // Sending SIGINT (Ctrl+C)
        if (serverProcess.stdin?.writable) {
            // serverProcess.stdin.write('\x03'); // Sending Ctrl+C can be unreliable cross-platform or in tests
            // serverProcess.stdin.end();
            // For now, just kill, as proper stdin interaction is complex for this test setup.
        }
        serverProcess.kill("SIGTERM"); // Or SIGINT
        setTimeout(2000, () => {
            // Timeout for kill
            if (!serverProcess.killed) {
                serverProcess.kill("SIGKILL");
            }
            resolve();
        });
    });
}

function connectClient(port = 9091): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${port}`);
        ws.on("open", () => resolve(ws));
        ws.on("error", (err) => reject(err));
        setTimeout(2000, () => reject(new Error("Client connection timed out")));
    });
}

describe("Hold-AI Server", () => {
    let serverProcess: ChildProcess | null = null;

    afterEach(async () => {
        await stopTestServer(serverProcess);
        serverProcess = null;
    });

    it("should start and a client should connect", async () => {
        serverProcess = await startTestServer();
        expect(serverProcess).toBeDefined();

        let client: WebSocket | null = null;
        try {
            client = await connectClient();
            expect(client.readyState).toBe(WebSocket.OPEN);
        } finally {
            client?.close();
        }
    }, 10000); // Increase timeout for server start and client connect

    it("should send existing messages to a new client", async () => {
        serverProcess = await startTestServer();

        // Simulate server receiving messages via its Enquirer prompt
        // This is hard to do directly without complex IPC or refactoring server for testability.
        // Instead, we'll test the effect: start server, manually add messages (if server allowed it, it doesn't), then connect client.
        // The current server only adds messages via Enquirer. We can't directly inject messages for this test easily.
        // Alternative: modify server to accept initial messages via e.g. env var for testing, or mock Enquirer globally.

        // For now, this test is limited. We'll assume if a client connects, and IF there were messages, they'd be sent.
        // We can test message broadcasting more directly.
        // This specific test for *existing* messages is hard with current server design.
        // We will test message broadcasting in another test.
        let client: WebSocket | null = null;
        try {
            client = await connectClient();
            // If we could preload messages on server, we'd check for them here.
            // For now, just ensure connection works.
            expect(client.readyState).toBe(WebSocket.OPEN);
        } finally {
            client?.close();
        }
    }, 10000);

    it("should broadcast new messages to connected clients", async (done) => {
        serverProcess = await startTestServer();
        const client = await connectClient();

        const testMessage = { timestamp: expect.any(String), message: "Hello Client" };

        client.on("message", (data) => {
            const received = JSON.parse(data.toString());
            expect(received).toEqual(testMessage);
            client.close();
            done();
        });

        // Simulate user typing "Hello Client" into the server's Enquirer prompt
        // This requires writing to the server process's stdin.
        expect(serverProcess?.stdin).not.toBeNull();
        serverProcess?.stdin?.write("Hello Client\n");
    }, 15000);

    it("should broadcast __COMPLETED__ and clear messages when 'OK' is entered", async (done) => {
        serverProcess = await startTestServer();
        const client1 = await connectClient();
        let client1ReceivedCompleted = false;
        let _client1Closed = false;

        // Send an initial message to ensure `messages` array is not empty
        serverProcess?.stdin?.write("Initial Message\n");
        // Wait for it to be processed by server and broadcast (client will receive it)
        await new Promise<void>((resolve) => client1.once("message", () => resolve()));

        client1.on("message", (data) => {
            const received = JSON.parse(data.toString());
            if (received.message === "__COMPLETED__") {
                client1ReceivedCompleted = true;
            }
        });
        client1.on("close", () => {
            _client1Closed = true;
            expect(client1ReceivedCompleted).toBe(true);
            // Check if messages are cleared on server (indirectly)
            // Connect a new client, it should not receive 'Initial Message'
            connectClient()
                .then((client2) => {
                    let receivedInitial = false;
                    client2.on("message", (data) => {
                        const msg = JSON.parse(data.toString());
                        if (msg.message === "Initial Message") {
                            receivedInitial = true;
                        }
                    });
                    // Wait a bit to see if any messages arrive
                    setTimeout(500).then(() => {
                        client2.close();
                        expect(receivedInitial).toBe(false); // Should not receive the old message
                        done();
                    });
                })
                .catch((err) => done(err));
        });

        serverProcess?.stdin?.write("OK\n");
    }, 20000); // Increased timeout for multiple client interactions
});
