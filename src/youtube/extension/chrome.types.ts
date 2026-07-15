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
            function reload(): void;
        }

        namespace tabs {
            interface Tab {
                id?: number;
                url?: string;
            }
            interface QueryInfo {
                url?: string | string[];
                active?: boolean;
                currentWindow?: boolean;
            }
            interface CreateProperties {
                url?: string;
                active?: boolean;
            }
            function query(info: QueryInfo): Promise<Tab[]>;
            function reload(tabId: number): Promise<void>;
            function create(properties: CreateProperties): Promise<Tab>;
        }

        namespace scripting {
            interface InjectionTarget {
                tabId: number;
                allFrames?: boolean;
                frameIds?: number[];
            }
            interface ScriptInjection {
                target: InjectionTarget;
                files?: string[];
                func?: () => unknown;
                world?: "ISOLATED" | "MAIN";
            }
            function executeScript(injection: ScriptInjection): Promise<unknown>;
        }

        namespace storage {
            const local: {
                get(keys: string | string[]): Promise<Partial<ExtensionConfig> & Record<string, unknown>>;
                set(items: Partial<ExtensionConfig> & Record<string, unknown>): Promise<void>;
                remove(keys: string | string[]): Promise<void>;
            };
        }

        namespace permissions {
            interface Permissions {
                origins?: string[];
                permissions?: string[];
            }

            function contains(permissions: Permissions): Promise<boolean>;
            function request(permissions: Permissions): Promise<boolean>;
        }
    }
}
