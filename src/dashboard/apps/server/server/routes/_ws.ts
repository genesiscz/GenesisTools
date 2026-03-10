import { WS_EVENTS } from "@dashboard/shared";
import { defineWebSocketHandler } from "h3";

interface Client {
    id: string;
    userId?: string;
    peer: unknown;
}

const clients = new Map<string, Client>();

export default defineWebSocketHandler({
    open(peer) {
        const clientId = `client_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        clients.set(clientId, { id: clientId, peer });

        console.log(`[WebSocket] Client connected: ${clientId}`);

        // Send welcome message
        peer.send(
            JSON.stringify({
                type: "connected",
                clientId,
                timestamp: new Date().toISOString(),
            })
        );
    },

    message(peer, message) {
        try {
            const data = JSON.parse(message.text());
            const { type, payload } = data;

            console.log(`[WebSocket] Received message: ${type}`);

            switch (type) {
                case WS_EVENTS.TIMER_UPDATE:
                case WS_EVENTS.TIMER_CREATE:
                case WS_EVENTS.TIMER_DELETE:
                    // Broadcast timer changes to all connected clients except sender
                    broadcastToOthers(peer, data);
                    break;

                case WS_EVENTS.SYNC_REQUEST:
                    // Handle sync request
                    peer.send(
                        JSON.stringify({
                            type: WS_EVENTS.SYNC_RESPONSE,
                            timestamp: new Date().toISOString(),
                            message: "Sync request received",
                        })
                    );
                    break;

                default:
                    console.log(`[WebSocket] Unknown message type: ${type}`);
            }
        } catch (error) {
            console.error("[WebSocket] Error parsing message:", error);
        }
    },

    close(peer) {
        // Find and remove the client
        for (const [clientId, client] of clients.entries()) {
            if (client.peer === peer) {
                clients.delete(clientId);
                console.log(`[WebSocket] Client disconnected: ${clientId}`);
                break;
            }
        }
    },

    error(_peer, error) {
        console.error("[WebSocket] Error:", error);
    },
});

function broadcastToOthers(sender: unknown, message: unknown) {
    const messageStr = JSON.stringify(message);

    for (const client of clients.values()) {
        if (client.peer !== sender) {
            try {
                (client.peer as { send: (msg: string) => void }).send(messageStr);
            } catch (error) {
                console.error(`[WebSocket] Failed to send to client ${client.id}:`, error);
            }
        }
    }
}
