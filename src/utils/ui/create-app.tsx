import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./theme/styles.css";

export interface DashboardAppConfig {
	/** The root React component (typically a Router) */
	App: React.ComponentType;
	/** Root element ID (default: "root") */
	rootId?: string;
	/** Custom QueryClient instance (default: creates new one) */
	queryClient?: QueryClient;
}

export function createDashboardApp(config: DashboardAppConfig) {
	const queryClient = config.queryClient ?? new QueryClient();
	const rootElement = document.getElementById(config.rootId ?? "root");

	if (!rootElement) {
		throw new Error(`Root element #${config.rootId ?? "root"} not found`);
	}

	createRoot(rootElement).render(
		<StrictMode>
			<QueryClientProvider client={queryClient}>
				<config.App />
			</QueryClientProvider>
		</StrictMode>,
	);
}
