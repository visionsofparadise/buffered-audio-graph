import type { QueryClient } from "@tanstack/react-query";
import type { State } from "opshot";
import type { Logger } from "../../shared/models/Logger";
import type { GraphMeta, History } from "./History";
import type { Main } from "./Main";
import type { MainEvents } from "./MainEvents";
import type { ActiveCommands } from "./State/ActiveCommands";
import type { AppState } from "./State/App";
import type { GraphViewState, PositionsState } from "./State/Graph";
import type { GraphDefinitionState } from "./State/GraphDefinition";

export interface TabNamesState {
	names: Record<string, string>;
}

export interface AppContext {
	readonly app: State<AppState>;
	readonly activeCommands: State<ActiveCommands>;
	readonly logger: Logger;
	readonly main: Main;
	readonly mainEvents: MainEvents;
	readonly queryClient: QueryClient;
	readonly userDataPath: string;
	readonly windowId: string;
	readonly tabNames: State<TabNamesState>;
	readonly openBagTab: () => Promise<void>;
	readonly openBagByPath: (bagPath: string) => Promise<void>;
	readonly newBagTab: () => Promise<void>;
	readonly renameTab: (tabId: string, newName: string) => void;
	readonly importBagIntoActiveTab: () => Promise<void>;
	readonly setSettingsOpen: (open: boolean) => void;
}

export interface GraphContext extends AppContext {
	readonly graphDefinition: State<GraphDefinitionState, GraphMeta, GraphMeta>;
	readonly positions: State<PositionsState, GraphMeta, GraphMeta>;
	readonly graphView: State<GraphViewState>;
	readonly history: History;
	readonly flushDefinition: () => void;
	readonly bagPath: string;
	readonly bagId: string;
	/** Force an immediate save of the active graph definition (flushes the debounced write). */
	readonly onSave: () => void;
}
