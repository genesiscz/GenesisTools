import type { ExtensionRequest, ExtensionResponse } from "@ext/shared/messages";
import type { ExtensionConfig } from "@ext/shared/types";

declare global {
    namespace chrome {
        namespace runtime {
            interface Port {
                onDisconnect: { addListener(listener: () => void): void };
                onMessage: { addListener(listener: (message: unknown) => void): void };
                postMessage(message: unknown): void;
                disconnect(): void;
            }

            interface MessageSender {}

            type SendResponse = (response?: unknown) => void;

            const onConnect: { addListener(listener: (port: Port) => void): void };
            const onMessage: {
                addListener(
                    listener: (
                        request: ExtensionRequest,
                        sender: MessageSender,
                        sendResponse: SendResponse
                    ) => boolean | undefined
                ): void;
            };
            function sendMessage(request: ExtensionRequest): Promise<ExtensionResponse>;
            function connect(connectInfo?: { name?: string }): Port;
        }

        namespace storage {
            const local: {
                get(keys: string): Promise<Partial<ExtensionConfig>>;
                set(items: Partial<ExtensionConfig>): Promise<void>;
            };
        }
    }
}
