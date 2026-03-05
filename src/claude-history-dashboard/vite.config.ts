import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { resolve } from "node:path";
import viteTsConfigPaths from "vite-tsconfig-paths";
import { createDashboardViteConfig } from "../utils/ui/vite.base";

export default createDashboardViteConfig({
	root: __dirname,
	port: 3069,
	plugins: [
		devtools(),
		viteTsConfigPaths({ projects: ["./tsconfig.json"] }),
		tanstackStart(),
		viteReact({
			babel: {
				plugins: ["babel-plugin-react-compiler"],
			},
		}),
	],
	aliases: {
		"@app": resolve(__dirname, ".."),
	},
});
