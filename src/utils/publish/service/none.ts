import type { ServiceInstaller } from "./types";

export const noServiceInstaller: ServiceInstaller & { readonly manager: "none" } = {
    manager: "none",
    render: () => "",
    installCommands: () => [],
    install: async () => ({ unitFile: "" }),
    restart: async () => {},
    stop: async () => {},
    isActive: async () => false,
};
