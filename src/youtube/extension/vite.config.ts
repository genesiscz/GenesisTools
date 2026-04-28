import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const root = resolve(import.meta.dirname);
const dist = resolve(root, "../../../dist/extension");

function copyExtensionStaticAssets(): Plugin {
    return {
        name: "copy-extension-static-assets",
        async closeBundle() {
            await mkdir(dist, { recursive: true });
            await copyFile(resolve(root, "manifest.json"), resolve(dist, "manifest.json"));
            await mkdir(resolve(dist, "icons"), { recursive: true });

            for (const name of ["icon16.png", "icon48.png", "icon128.png"]) {
                await copyFile(resolve(root, "icons", name), resolve(dist, "icons", name));
            }
        },
    };
}

export default defineConfig({
    root,
    plugins: [viteReact(), copyExtensionStaticAssets()],
    build: {
        outDir: dist,
        emptyOutDir: true,
        rollupOptions: {
            input: {
                background: resolve(root, "background.ts"),
                "content-script": resolve(root, "content-script.ts"),
                popup: resolve(root, "popup/popup.html"),
            },
            output: {
                entryFileNames: "[name].js",
                chunkFileNames: "chunks/[name]-[hash].js",
                assetFileNames: "assets/[name]-[hash][extname]",
            },
        },
    },
    resolve: {
        alias: {
            "@app": resolve(root, "../.."),
            "@ext": root,
            "@ui": resolve(root, "../../utils/ui"),
        },
    },
});
