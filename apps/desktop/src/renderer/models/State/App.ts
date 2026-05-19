import type { Snapshot } from "valtio/vanilla";
import { z } from "zod";
import type { State } from ".";
import { packageNameFromSpec } from "../../../shared/utilities/packageSpec";
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

const LoadedModuleInfoSchema = z.object({
	moduleName: z.string(),
	moduleDescription: z.string(),
	schema: z.unknown(),
	category: z.enum(["source", "transform", "target"]),
});

const ModulePackageStateSchema = z.object({
	requestedSpec: z.string(),
	name: z.string(),
	version: z.string().nullable().default(null),
	status: z.enum(["pending", "installing", "loading", "ready", "error"]).default("pending"),
	error: z.string().nullable().default(null),
	modules: z.array(LoadedModuleInfoSchema).default([]),
	isBuiltIn: z.boolean().default(false),
});

export const AppStateSchema = z.object({
	tabs: z.array(TabEntrySchema).default([]),
	activeTabId: z.string().nullable().default(null),
	theme: z.enum(["lava", "viridis"]).default("lava"),
	windowBounds: WindowBoundsSchema.optional(),
	recentFiles: z.array(RecentFileSchema).default([]),
	packages: z.array(ModulePackageStateSchema).default([]),
	binaries: z.record(z.string(), z.string()).default({}),
});

export type TabEntry = z.infer<typeof TabEntrySchema>;
export type RecentFile = z.infer<typeof RecentFileSchema>;
export type WindowBounds = z.infer<typeof WindowBoundsSchema>;
export type ModulePackageState = z.infer<typeof ModulePackageStateSchema>;
export type AppState = z.infer<typeof AppStateSchema> & State;

const SavedStateSchema = AppStateSchema.pick({
	tabs: true,
	activeTabId: true,
	theme: true,
	windowBounds: true,
	recentFiles: true,
	binaries: true,
})
	.extend({
		packages: z.array(z.unknown()).optional(),
	})
	.partial();

const LegacyModulePackageStateSchema = z.object({
	url: z.string().optional(),
	name: z.string().optional(),
	version: z.string().nullable().optional(),
	status: z.string().optional(),
	error: z.string().nullable().optional(),
	modules: z.array(LoadedModuleInfoSchema).optional(),
	isBuiltIn: z.boolean().optional(),
});

const BUILT_IN_PACKAGE_NAME = "@buffered-audio/nodes";
const BUILT_IN_PACKAGE_SPEC = "@buffered-audio/nodes@latest";

function resetPackageLifecycle(entry: ModulePackageState): ModulePackageState {
	return entry.status === "ready"
		? entry
		: {
			...entry,
			status: "pending",
			error: null,
			modules: [],
			version: null,
		};
}

function migrateLegacyPackageState(value: unknown): ModulePackageState | null {
	const current = ModulePackageStateSchema.safeParse(value);

	if (current.success) {
		return resetPackageLifecycle(current.data);
	}

	const legacy = LegacyModulePackageStateSchema.safeParse(value);

	if (!legacy.success) {
		return null;
	}

	const entry = legacy.data;
	const isBuiltIn = entry.isBuiltIn === true || entry.name === BUILT_IN_PACKAGE_NAME;
	let requestedSpec: string | null = null;

	if (isBuiltIn) {
		requestedSpec = BUILT_IN_PACKAGE_SPEC;
	} else if (entry.name) {
		const looksLikeRegistryName = entry.name.startsWith("@") || !entry.name.includes("/");

		if (looksLikeRegistryName) {
			requestedSpec = entry.version ? `${entry.name}@${entry.version}` : `${entry.name}@latest`;
		}
	}

	if (!requestedSpec) {
		return null;
	}

	return resetPackageLifecycle({
		requestedSpec,
		name: packageNameFromSpec(requestedSpec),
		version: entry.status === "ready" ? (entry.version ?? null) : null,
		status: entry.status === "ready" ? "ready" : "pending",
		error: entry.status === "ready" ? (entry.error ?? null) : null,
		modules: entry.status === "ready" ? (entry.modules ?? []) : [],
		isBuiltIn,
	});
}

function loadSavedPackages(savedPackages: Array<unknown> | undefined): Array<ModulePackageState> {
	const migrated = (savedPackages ?? [])
		.map((entry) => migrateLegacyPackageState(entry))
		.filter((entry): entry is ModulePackageState => entry !== null);

	if (migrated.length === 0) {
		return [
			{
				requestedSpec: BUILT_IN_PACKAGE_SPEC,
				name: BUILT_IN_PACKAGE_NAME,
				version: null,
				status: "pending",
				error: null,
				modules: [],
				isBuiltIn: true,
			},
		];
	}

	if (!migrated.some((entry) => entry.isBuiltIn)) {
		return [
			{
				requestedSpec: BUILT_IN_PACKAGE_SPEC,
				name: BUILT_IN_PACKAGE_NAME,
				version: null,
				status: "pending",
				error: null,
				modules: [],
				isBuiltIn: true,
			},
			...migrated,
		];
	}

	return migrated.map((entry) =>
		entry.isBuiltIn
			? {
				...entry,
				requestedSpec: BUILT_IN_PACKAGE_SPEC,
				name: BUILT_IN_PACKAGE_NAME,
			}
			: entry,
	);
}

export async function loadAppState(main: { getUserDataPath: () => Promise<string>; readFile: (path: string) => Promise<string> }): Promise<Omit<AppState, "_key">> {
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
		// no saved state
	}

	const tabs = saved.tabs ?? [];

	const activeTabId = tabs.some((tab) => tab.id === saved.activeTabId) ? (saved.activeTabId ?? null) : (tabs[0]?.id ?? null);

	const packages = loadSavedPackages(saved.packages);

	return {
		tabs,
		activeTabId,
		theme: saved.theme ?? "lava",
		windowBounds: saved.windowBounds,
		recentFiles: saved.recentFiles ?? [],
		packages,
		binaries: saved.binaries ?? {},
	};
}

export function useAppState(initial: Omit<AppState, "_key">, store: ProxyStore): Snapshot<AppState> {
	return useCreateState<AppState>(initial, store);
}
