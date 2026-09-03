// `react-native-zeroconf@0.14.0` ships no TypeScript types (only `dist/index.js`). This
// ambient declaration mirrors its runtime API (verified against the compiled `dist/index.js`
// — `scan`/`stop`/`publishService`/`getServices` + the EventEmitter `resolved`/`found`/
// `remove`/`error`/`start`/`stop`/`update` events, and the native `Service` shape).
declare module "react-native-zeroconf" {
    export interface Service {
        name: string;
        fullName?: string;
        host?: string;
        port?: number;
        addresses?: string[];
        txt?: Record<string, string>;
    }

    export type ZeroconfEvent = "start" | "stop" | "found" | "remove" | "resolved" | "published" | "unpublished" | "update" | "error";

    export default class Zeroconf {
        scan(type?: string, protocol?: string, domain?: string): void;
        stop(): void;
        getServices(): Record<string, Service>;
        publishService(type: string, protocol: string, domain: string, name: string, port: number, txt?: Record<string, string>): void;
        unpublishService(name: string): void;
        addDeviceListeners(): void;
        removeDeviceListeners(): void;
        on(event: "resolved" | "published" | "unpublished", listener: (service: Service) => void): this;
        on(event: "found" | "remove", listener: (name: string) => void): this;
        on(event: "error", listener: (err: Error) => void): this;
        on(event: "start" | "stop" | "update", listener: () => void): this;
        removeAllListeners(event?: ZeroconfEvent): this;
    }
}
