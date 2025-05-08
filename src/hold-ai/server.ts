import { WebSocketServer } from "ws";
import * as readline from "node:readline";

// Store messages
const messages: Array<{ timestamp: string; message: string }> = [];

// Start the server
const startServer = () => {
    // Create WebSocket server on port 8080
    const wss = new WebSocketServer({ port: 9090 });

    console.log("Hold-AI WebSocket Server started on port 9090");

    // Handle new connections
    wss.on("connection", (ws) => {
        console.log("Client connected");

        // Send all existing messages to the new client
        if (messages.length > 0) {
            ws.send(JSON.stringify(messages));
        }

        // Handle client disconnect
        ws.on("close", () => {
            console.log("Client disconnected");
        });
    });

    // Create readline interface
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    console.log('Enter messages (type "OK" to finish):');

    // Handle user input
    const promptUser = () => {
        rl.question("> ", (input) => {
            if (input.trim().toUpperCase() === "OK") {
                console.log("Finishing Hold-AI Server...");

                // Add a special message to indicate completion
                const completionMessage = { timestamp: new Date().toISOString(), message: "__COMPLETED__" };
                messages.push(completionMessage);

                // Broadcast completion to all clients
                wss.clients.forEach((client) => {
                    if (client.readyState === 1) {
                        // OPEN
                        client.send(JSON.stringify(completionMessage));
                    }
                });

                // Close everything
                rl.close();

                // Give clients a moment to receive the final message before shutting down
                setTimeout(() => {
                    wss.close();
                    console.log("Server closed");
                }, 1000);

                return;
            }

            // Add the message
            const newMessage = { timestamp: new Date().toISOString(), message: input };
            messages.push(newMessage);
            console.log("Message saved.");

            // Broadcast to all clients
            wss.clients.forEach((client) => {
                if (client.readyState === 1) {
                    // OPEN
                    client.send(JSON.stringify(newMessage));
                }
            });

            // Continue prompting
            promptUser();
        });
    };

    promptUser();
};

// Run the server
startServer();
