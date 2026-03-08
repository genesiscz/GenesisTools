import { devtools } from "@tanstack/devtools-vite";
import { resolve } from "node:path";
import viteTsConfigPaths from "vite-tsconfig-paths";
import { createDashboardViteConfig } from "../utils/ui/vite.base";

const config = createDashboardViteConfig({
	root: __dirname,
	port: 3069,
	plugins: [
		devtools(),
		viteTsConfigPaths({
			projects: ["./tsconfig.json"],
		}),
	],
	aliases: {
		"@app": resolve(__dirname, ".."),
	},
	reactOptions: {
		babel: {
			plugins: ["babel-plugin-react-compiler"],
		},
	},
});

export default config;
