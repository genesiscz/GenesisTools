import logger from "@app/logger";
import WebSocket from "ws";

interface IMessage {
    timestamp: string;
    message: string;
}
// Function to wait for the completion message
const messages: IMessage[] = [];

const waitForCompletion = async (): Promise<string> => {
    return new Promise((resolve) => {
        const connectWebSocket = () => {
            // Clear previous messages on reconnect attempts
            messages.length = 0;

            // Connect to the WebSocket server
            const ws = new WebSocket("ws://localhost:9091");

            let displayMessages: IMessage[] = [];

            // Handle connection open
            ws.on("open", () => {
                logger.info("Still processing...");
            });

            // Handle messages
            ws.on("message", (data) => {
                try {
                    const message = JSON.parse(data.toString());

                    messages.push(message);
                    // Check if the completion message exists
                    const completed = messages.some((msg: any) => msg.message === "__COMPLETED__");

                    // If we received the completion message, resolve with the combined messages
                    if (completed) {
                        // Filter out the special completion message for display
                        displayMessages = messages.filter((msg: any) => msg.message !== "__COMPLETED__");

                        // Join all messages as output
                        const combinedMessages = displayMessages.map((msg) => msg.message).join("\n");

                        // Close the connection
                        ws.close();

                        // Resolve with the combined message
                        resolve(combinedMessages);
                    } else {
                        logger.info(`Instruction: ${message.message}`);
                    }
                } catch (err) {
                    console.error("Error parsing message:", err);
                }
            });

            // Handle errors
            ws.on("error", (_error) => {
                logger.info("Still processing...");
                setTimeout(connectWebSocket, 3000);
            });

            // Handle connection close
            ws.on("close", () => {
                //logger.info("Disconnected from Hold-AI Server");
                // Retry connection after 3 seconds
            });
        };

        // Initial connection attempt
        connectWebSocket();
    });
};

// Main function
const main = async () => {
    logger.info("Processing...");

    await waitForCompletion();

    logger.info("OK");
};

// Run the client
main().catch(console.error);
