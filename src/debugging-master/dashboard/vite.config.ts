import { resolve } from "node:path";
import viteTsConfigPaths from "vite-tsconfig-paths";
import { createDashboardViteConfig } from "../../utils/ui/vite.base";

export default createDashboardViteConfig({
    root: __dirname,
    port: 7244,
    plugins: [
        viteTsConfigPaths({
            projects: ["./tsconfig.json"],
        }),
    ],
    aliases: {
        "@app": resolve(__dirname, "..", ".."),
    },
    tanstackStartOptions: false,
    overrides: {
        base: "/",
        build: {
            outDir: "dist",
            emptyOutDir: true,
            target: "es2022",
            assetsDir: "assets",
        },
    },
});
