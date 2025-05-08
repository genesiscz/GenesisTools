import { WebSocketServer } from "ws";
import Enquirer from "enquirer";
import log from "../logger";

// Store messages
const messages: Array<{ timestamp: string; message: string }> = [];

// Start the server
const startServer = () => {
    // Create WebSocket server on port 8080
    const wss = new WebSocketServer({ port: 9091 });
    const prompter = new Enquirer();

    log.info("Hold-AI WebSocket Server started on port 9091");

    // Handle new connections
    wss.on("connection", (ws) => {
        log.info("Client connected");

        // Send all existing messages to the new client, one by one
        if (messages.length > 0) {
            log.info(`Sending ${messages.length} existing messages to new client...`);
            messages.forEach((msg) => {
                ws.send(JSON.stringify(msg)); // Send each individual message object
            });
            log.info("Finished sending existing messages.");
        }

        // Handle client disconnect
        ws.on("close", () => {
            log.info("Client disconnected");
        });
    });

    log.info('Enter messages (type "OK" to finish current cycle and reset):');

    // Handle user input
    const promptUser = async () => {
        try {
            const response: { userInput?: string } = await prompter.prompt({
                type: "input",
                name: "userInput",
                message: " ", // Minimal message, relying on prefix
                prefix: ">", // Display '>' as the prompt prefix
            });

            const input = response.userInput?.trim() || ""; // Safely get and trim input

            if (input.toUpperCase() === "OK") {
                log.info("Processing 'OK': resetting messages and client connections...");

                const completionMessage = { timestamp: new Date().toISOString(), message: "__COMPLETED__" };

                // Add to messages temporarily so it's part of the "session" that's completing
                // but it won't persist for new sessions as messages array will be cleared.
                // messages.push(completionMessage); // Decided against this, as __COMPLETED__ is a signal, not persistent data.

                log.info("Broadcasting __COMPLETED__ to all active clients and closing their connections...");
                wss.clients.forEach((client) => {
                    if (client.readyState === 1) {
                        // WebSocket.OPEN
                        client.send(JSON.stringify(completionMessage));
                        client.close(); // Close connection after sending completion
                    }
                });
                log.info("All active client connections for this cycle have been closed.");

                // Clear messages for the new cycle
                messages.length = 0;
                log.info("Messages cleared for the new cycle.");
                log.info("Ready for new messages. Restarting prompt cycle...");
                promptUser(); // Call promptUser again to continue the loop
                return;
            }

            // Add the message (if not "OK" and not empty)
            if (input) {
                const newMessage = { timestamp: new Date().toISOString(), message: input };
                messages.push(newMessage);

                if (wss.clients.size === 0) {
                    log.info("Message saved because no clients are connected.");
                }

                // Broadcast to all clients
                wss.clients.forEach((client) => {
                    if (client.readyState === 1) {
                        // WebSocket.OPEN
                        client.send(JSON.stringify(newMessage));
                    }
                });
            }
            // Continue prompting for the next message
            promptUser();
        } catch (error) {
            // Enquirer throws an error if the prompt is cancelled (e.g. Ctrl+C)
            if (String(error).toLowerCase().includes("cancel") || !error) {
                // Also handle empty error for some cancellation cases
                log.warn("\nPrompt cancelled by user. Shutting down Hold-AI server gracefully.");
            } else {
                log.error("\nError during prompt:", error);
            }
            // Clean up server resources before exiting due to prompt error/cancellation
            log.info("Closing all client connections before server shutdown...");
            wss.clients.forEach((client) => {
                if (client.readyState === 1) {
                    client.close();
                }
            });
            wss.close(() => {
                log.info("WebSocket server closed due to prompt error or user cancellation.");
                process.exit(0); // Exit gracefully on cancellation, or 1 for other errors. Let's use 0 for user cancel.
            });
        }
    };

    promptUser();
};

// Run the server
startServer();
