import type { GraphDefinition } from "@buffered-audio/core";
import type { QueryClient } from "@tanstack/react-query";
import type { Snapshot } from "valtio/vanilla";
import type { Logger } from "../../shared/models/Logger";
import type { Main } from "./Main";
import type { MainEvents } from "./MainEvents";
import type { ProxyStore } from "./ProxyStore/ProxyStore";
import type { AppState } from "./State/App";
import type { GraphState } from "./State/Graph";

export interface HistoryEntry {
	label: string;
	undo: () => void;
	redo: () => void;
}

export interface HistoryState {
	entries: Array<HistoryEntry>;
	cursor: number;
}

export interface AppContext {
	readonly app: Snapshot<AppState>;
	readonly appStore: ProxyStore;
	readonly logger: Logger;
	readonly main: Main;
	readonly mainEvents: MainEvents;
	readonly queryClient: QueryClient;
	readonly userDataPath: string;
	readonly windowId: string;
	readonly historyStacks: Map<string, HistoryState>;
	readonly tabNames: Map<string, string>;
	readonly renameCallbacks: Map<string, (name: string) => void>;
	readonly importCallbacks: Map<string, () => Promise<void>>;
	readonly undoCallbacks: Map<string, () => void>;
	readonly redoCallbacks: Map<string, () => void>;
	readonly openBagTab: () => Promise<void>;
	readonly openBagByPath: (bagPath: string) => Promise<void>;
	readonly newBagTab: () => Promise<void>;
	readonly renameTab: (tabId: string, newName: string) => void;
	readonly importBagIntoActiveTab: () => Promise<void>;
	readonly openModuleManager: () => void;
	readonly openBinaryManager: () => void;
}

export interface GraphContext extends AppContext {
	readonly graph: Snapshot<GraphState>;
	readonly graphStore: ProxyStore;
	readonly graphDefinition: GraphDefinition;
	readonly mutateDefinition: (updater: (definition: GraphDefinition) => GraphDefinition) => void;
	readonly bagPath: string;
	readonly bagId: string;
	readonly history: HistoryState;
	readonly pushHistory: (entry: HistoryEntry) => void;
	readonly undo: () => void;
	readonly redo: () => void;
}
