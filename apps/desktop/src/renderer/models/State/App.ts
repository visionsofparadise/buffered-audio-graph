import type { Snapshot } from "valtio/vanilla";
import { z } from "zod";
import type { State } from ".";
import { useCreateState } from "../ProxyStore/hooks/useCreateState";
import type { ProxyStore } from "../ProxyStore/ProxyStore";

const TabEntrySchema = z.object({
	id: z.string(),
	bagPath: z.string(),
});

const RecentFileSchema = z.object({
	id: z.string(),
	bagPath: z.string(),
	name: z.string(),
	lastOpened: z.number(),
});

const WindowBoundsSchema = z.object({
	x: z.number(),
	y: z.number(),
	width: z.number(),
	height: z.number(),
});

const LoadedNodeInfoSchema = z.object({
	nodeName: z.string(),
	description: z.string(),
	schema: z.unknown(),
	category: z.enum(["source", "transform", "target"]),
});

const NodePackageStateSchema = z.object({
	requestedSpec: z.string(),
	name: z.string(),
	version: z.string().nullable().default(null),
	apiVersion: z.number().nullable().default(null),
	status: z.enum(["pending", "installing", "ready", "error"]).default("pending"),
	error: z.string().nullable().default(null),
	nodes: z.array(LoadedNodeInfoSchema).default([]),
	isBuiltIn: z.boolean().default(false),
	origin: z.enum(["catalog", "dependency"]).default("catalog"),
});

export const AppStateSchema = z.object({
	tabs: z.array(TabEntrySchema).default([]),
	activeTabId: z.string().nullable().default(null),
	windowBounds: WindowBoundsSchema.optional(),
	recentFiles: z.array(RecentFileSchema).default([]),
	packages: z.array(NodePackageStateSchema).default([]),
	binaries: z.record(z.string(), z.string()).default({}),
	vst3ScanRoots: z.array(z.string()).default([]),
	installBagPackagesAutomatically: z.boolean().default(true),
});

export type TabEntry = z.infer<typeof TabEntrySchema>;
export type RecentFile = z.infer<typeof RecentFileSchema>;
export type WindowBounds = z.infer<typeof WindowBoundsSchema>;
export type NodePackageState = z.infer<typeof NodePackageStateSchema>;
export type AppState = z.infer<typeof AppStateSchema> & State;

const SavedStateSchema = AppStateSchema.pick({
	tabs: true,
	activeTabId: true,
	windowBounds: true,
	recentFiles: true,
	binaries: true,
	installBagPackagesAutomatically: true,
})
	.extend({
		packages: z.array(z.unknown()).optional(),
		// Not picked (which would inherit `.default([])`): Zod v4's `.partial()` keeps
		// a picked field's default, so a state.json lacking the key would parse to `[]`
		// instead of `undefined` — losing the first-run vs. user-emptied distinction.
		vst3ScanRoots: z.array(z.string()).optional(),
	})
	.partial();

const BUILT_IN_PACKAGE_NAME = "@buffered-audio/nodes";
const BUILT_IN_PACKAGE_SPEC = "@buffered-audio/nodes@latest";

const BUILT_IN_PACKAGE_ENTRY: NodePackageState = {
	requestedSpec: BUILT_IN_PACKAGE_SPEC,
	name: BUILT_IN_PACKAGE_NAME,
	version: null,
	apiVersion: null,
	status: "pending",
	error: null,
	nodes: [],
	isBuiltIn: true,
	origin: "catalog",
};

function resetPackageLifecycle(entry: NodePackageState): NodePackageState {
	return entry.status === "ready"
		? entry
		: {
				...entry,
				status: "pending",
				error: null,
				nodes: [],
				version: null,
				apiVersion: null,
			};
}

function loadSavedPackages(savedPackages: Array<unknown> | undefined): Array<NodePackageState> {
	const parsed = (savedPackages ?? [])
		.map((entry) => NodePackageStateSchema.safeParse(entry))
		.filter((result): result is { success: true; data: NodePackageState } => result.success)
		.map((result) => resetPackageLifecycle(result.data));

	if (parsed.length === 0) {
		return [BUILT_IN_PACKAGE_ENTRY];
	}

	if (!parsed.some((entry) => entry.isBuiltIn)) {
		return [BUILT_IN_PACKAGE_ENTRY, ...parsed];
	}

	return parsed.map((entry) =>
		entry.isBuiltIn
			? {
					...entry,
					requestedSpec: BUILT_IN_PACKAGE_SPEC,
					name: BUILT_IN_PACKAGE_NAME,
				}
			: entry,
	);
}

export async function loadAppState(main: { getUserDataPath: () => Promise<string>; readFile: (path: string) => Promise<string>; vst3GetDefaultScanRoots: () => Promise<Array<string>> }): Promise<Omit<AppState, "_key">> {
	const userDataPath = await main.getUserDataPath();
	const path = `${userDataPath}/state.json`;

	let saved: z.infer<typeof SavedStateSchema> = {};

	try {
		const content = await main.readFile(path);
		const result = SavedStateSchema.safeParse(JSON.parse(content));

		if (result.success) {
			saved = result.data;
		}
	} catch {
		saved = {};
	}

	const tabs = saved.tabs ?? [];

	const activeTabId = tabs.some((tab) => tab.id === saved.activeTabId) ? (saved.activeTabId ?? null) : (tabs[0]?.id ?? null);

	const packages = loadSavedPackages(saved.packages);

	const vst3ScanRoots = saved.vst3ScanRoots ?? (await main.vst3GetDefaultScanRoots());

	return {
		tabs,
		activeTabId,
		windowBounds: saved.windowBounds,
		recentFiles: saved.recentFiles ?? [],
		packages,
		binaries: saved.binaries ?? {},
		vst3ScanRoots,
		installBagPackagesAutomatically: saved.installBagPackagesAutomatically ?? true,
	};
}

export function useAppState(initial: Omit<AppState, "_key">, store: ProxyStore): Snapshot<AppState> {
	return useCreateState<AppState>(initial, store);
}
