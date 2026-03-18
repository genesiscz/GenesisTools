import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

interface ProviderProps {
	children: React.ReactNode;
	queryClient: QueryClient;
}

export function getContext() {
	const queryClient = new QueryClient();
	return {
		queryClient,
	};
}

export function Provider({ children, queryClient }: ProviderProps) {
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
