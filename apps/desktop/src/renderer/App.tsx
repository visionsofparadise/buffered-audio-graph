import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Logger } from "../shared/Models/Logger";
import { AppLoader } from "./Components/AppLoader";

const logger = new Logger("renderer");

Logger.level = "debug";

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			retry: false,
			refetchOnWindowFocus: false,
		},
	},
});

export function App() {
	return (
		<QueryClientProvider client={queryClient}>
			<AppLoader queryClient={queryClient} logger={logger} />
		</QueryClientProvider>
	);
}
