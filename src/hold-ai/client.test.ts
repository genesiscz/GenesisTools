import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";

const clientScriptPath = resolve(__dirname, "./client.ts");

// Helper to run the client script
async function runTestClient(): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const clientProcess = spawn("bun", ["run", clientScriptPath], {
        stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    clientProcess.stdout.on("data", (data) => {
        stdout += data.toString();
    });
    clientProcess.stderr.on("data", (data) => {
        stderr += data.toString();
    });

    const exitCode = await new Promise<number | null>((resolve) => {
        clientProcess.on("close", resolve);
        clientProcess.on("error", () => resolve(1)); // Treat spawn error as failure
    });

    return { stdout, stderr, exitCode };
}

describe("Hold-AI Client", () => {
    let mockWSS: WebSocketServer | null = null;
    let connectedClientWS: WebSocket | null = null; // The WebSocket instance from the client connection to the mock server

    beforeEach(() => {
        // Reset before each test
        connectedClientWS = null;
        if (mockWSS) {
            for (const client of mockWSS.clients) {
                client.terminate();
            }
            mockWSS.close();
            mockWSS = null;
        }
    });

    afterEach(() => {
        if (connectedClientWS && connectedClientWS.readyState === WebSocket.OPEN) {
            connectedClientWS.terminate();
        }
        if (mockWSS) {
            for (const client of mockWSS.clients) {
                client.terminate();
            }
            mockWSS.close();
            mockWSS = null;
        }
    });

    const startMockServer = (port = 9091): Promise<WebSocketServer> => {
        return new Promise((resolve) => {
            const wss = new WebSocketServer({ port });
            wss.on("listening", () => resolve(wss));
            wss.on("connection", (ws) => {
                connectedClientWS = ws; // Capture client connection
            });
            mockWSS = wss;
        });
    };

    it("should connect to server, receive messages, and resolve on __COMPLETED__", async () => {
        mockWSS = await startMockServer();

        const clientRunPromise = runTestClient();

        // Wait for the client to connect to our mock server
        await new Promise<void>((resolve, reject) => {
            const interval = setInterval(() => {
                if (connectedClientWS) {
                    clearInterval(interval);
                    resolve();
                }
            }, 100);
            setTimeout(5000, () => {
                clearInterval(interval);
                reject(new Error("Client did not connect to mock server in time"));
            });
        });

        expect(connectedClientWS).not.toBeNull();
        if (!connectedClientWS) {
            throw new Error("Client did not connect");
        }

        // Send messages from mock server to client
        connectedClientWS.send(JSON.stringify({ timestamp: new Date().toISOString(), message: "Message 1" }));
        await setTimeout(50); // allow client to process
        connectedClientWS.send(JSON.stringify({ timestamp: new Date().toISOString(), message: "Message 2" }));
        await setTimeout(50);
        connectedClientWS.send(JSON.stringify({ timestamp: new Date().toISOString(), message: "__COMPLETED__" }));

        const { stdout, exitCode } = await clientRunPromise;

        // console.log("Client STDOUT:", stdout);
        // console.log("Client STDERR:", stderr);

        expect(exitCode).toBe(0);
        // The client script logs "Instruction: ..." and then "OK"
        expect(stdout).toContain("Instruction: Message 1");
        expect(stdout).toContain("Instruction: Message 2");
        expect(stdout).toContain("OK");
        // It should not log the __COMPLETED__ message itself as an instruction
        expect(stdout).not.toContain("Instruction: __COMPLETED__");
    }, 15000); // Increased timeout for async operations

    it("should attempt to reconnect if server is not initially available", async () => {
        // Don't start the server immediately
        const clientRunPromise = runTestClient();

        // Client logs "Still processing..." on error/reconnect attempt
        // Wait a bit to see if client tries to connect (and fails)
        await setTimeout(1000);

        // Now start the mock server
        mockWSS = await startMockServer();

        await new Promise<void>((resolve, reject) => {
            const interval = setInterval(() => {
                if (connectedClientWS) {
                    clearInterval(interval);
                    resolve();
                }
            }, 100);
            setTimeout(7000, () => {
                // Client retries every 3s, give it time
                clearInterval(interval);
                reject(new Error("Client did not connect to mock server after starting late"));
            });
        });

        expect(connectedClientWS).not.toBeNull();
        if (!connectedClientWS) {
            throw new Error("Client did not connect");
        }

        // Send completion to allow client to exit cleanly
        connectedClientWS.send(JSON.stringify({ timestamp: new Date().toISOString(), message: "__COMPLETED__" }));

        const { stdout, exitCode } = await clientRunPromise;
        expect(exitCode).toBe(0);
        expect(stdout).toContain("Still processing..."); // Indicates it likely tried to connect while server was down
        expect(stdout).toContain("OK"); // Indicates successful completion
    }, 20000); // Longer timeout for reconnection logic
});
