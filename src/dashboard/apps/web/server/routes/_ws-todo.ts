/**
 * WebSocket Handler for Live Todo Sync
 *
 * This demonstrates Nitro's experimental WebSocket support for:
 * - Real-time cross-device synchronization
 * - Broadcasting to all connected clients
 * - Integration with PowerSync sync events
 *
 * Enable WebSocket in app.config.ts:
 *   experimental: { websocket: true }
 */

import { defineWebSocketHandler } from "h3";

// Store connected clients for broadcasting
interface Client {
    id: string;
    peer: unknown;
}

const clients = new Map<string, Client>();

export default defineWebSocketHandler({
    open(peer) {
        const clientId = `todo_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        clients.set(clientId, { id: clientId, peer });
        console.log("[WS:Todo] Client connected:", clientId);

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
            console.log("[WS:Todo] Message received:", data.type, "| Total clients:", clients.size);

            // Broadcast todo changes to all other connected clients
            if (data.type === "TODO_CREATED" || data.type === "TODO_UPDATED" || data.type === "TODO_DELETED") {
                const broadcasted = broadcastToOthers(peer, data);
                console.log("[WS:Todo] Broadcasted", data.type, "to", broadcasted, "other clients");
            }
        } catch (err) {
            console.error("[WS:Todo] Failed to parse message:", err);
        }
    },

    close(peer) {
        // Find and remove the client
        for (const [clientId, client] of clients.entries()) {
            if (client.peer === peer) {
                clients.delete(clientId);
                console.log("[WS:Todo] Client disconnected:", clientId);
                break;
            }
        }
    },

    error(_peer, error) {
        console.error("[WS:Todo] Error:", error);
    },
});

function broadcastToOthers(sender: unknown, message: unknown): number {
    const messageStr = JSON.stringify(message);
    let count = 0;

    for (const client of clients.values()) {
        if (client.peer !== sender) {
            try {
                (client.peer as { send: (msg: string) => void }).send(messageStr);
                count++;
                console.log(`[WS:Todo] Sent to client ${client.id}`);
            } catch (error) {
                console.error(`[WS:Todo] Failed to send to client ${client.id}:`, error);
            }
        }
    }
    return count;
}
