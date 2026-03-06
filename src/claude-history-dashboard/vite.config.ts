import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";
import { resolveSharedDeps } from "../utils/ui/vite.base";

const config = defineConfig({
	plugins: [
		resolveSharedDeps(__dirname),
		devtools(),
		viteTsConfigPaths({
			projects: ["./tsconfig.json"],
		}),
		tailwindcss(),
		tanstackStart(),
		viteReact({
			babel: {
				plugins: ["babel-plugin-react-compiler"],
			},
		}),
	],
	server: {
		port: 3069,
		fs: {
			allow: [__dirname, resolve(__dirname, "..", "utils", "ui")],
		},
	},
	resolve: {
		alias: {
			"@ui": resolve(__dirname, "..", "utils", "ui"),
			"@app": resolve(__dirname, ".."),
		},
	},
});

export default config;
