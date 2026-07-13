import type { QueryClient } from "@tanstack/react-query";
import type { Snapshot } from "valtio/vanilla";
import type { Logger } from "../../shared/models/Logger";
import type { Main } from "./Main";
import type { MainEvents } from "./MainEvents";
import type { ProxyStore } from "./ProxyStore/ProxyStore";
import type { ActiveCommands } from "./State/ActiveCommands";
import type { AppState } from "./State/App";
import type { GraphState } from "./State/Graph";
import type { GraphDefinitionState } from "./State/GraphDefinition";
import type { History } from "./State/History";

export interface AppContext {
	readonly app: Snapshot<AppState>;
	readonly appStore: ProxyStore;
	readonly logger: Logger;
	readonly main: Main;
	readonly mainEvents: MainEvents;
	readonly queryClient: QueryClient;
	readonly userDataPath: string;
	readonly windowId: string;
	readonly activeCommands: Snapshot<ActiveCommands>;
	readonly tabNames: Map<string, string>;
	readonly openBagTab: () => Promise<void>;
	readonly openBagByPath: (bagPath: string) => Promise<void>;
	readonly newBagTab: () => Promise<void>;
	readonly renameTab: (tabId: string, newName: string) => void;
	readonly importBagIntoActiveTab: () => Promise<void>;
	readonly setSettingsOpen: (open: boolean) => void;
}

export interface GraphContext extends AppContext {
	readonly graph: Snapshot<GraphState>;
	readonly graphStore: ProxyStore;
	readonly graphDefinition: Snapshot<GraphDefinitionState>;
	readonly flushDefinition: () => void;
	readonly bagPath: string;
	readonly bagId: string;
	readonly history: Snapshot<History>;
	/** Force an immediate save of the active graph definition (flushes the debounced write). */
	readonly onSave: () => void;
}
