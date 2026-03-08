import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig, type UserConfig, type PluginOption } from "vite";

export interface DashboardViteConfig {
	/** Root directory of the dashboard app */
	root: string;
	/** Dev server port */
	port: number;
	/** Additional Vite plugins to merge with defaults */
	plugins?: PluginOption[];
	/** Additional Vite config overrides (merged shallowly) */
	overrides?: Partial<UserConfig>;
}

export function createDashboardViteConfig({
	root,
	port,
	plugins: extraPlugins = [],
	overrides = {},
}: DashboardViteConfig): UserConfig {
	const { plugins: _ignored, ...rest } = overrides;

	return defineConfig({
		root,
		plugins: [tailwindcss(), viteReact(), ...extraPlugins],
		server: {
			port,
		},
		resolve: {
			alias: {
				"@ui": resolve(__dirname, "."),
				"@app": resolve(root, "src"),
			},
		},
		...rest,
	}) as UserConfig;
}
