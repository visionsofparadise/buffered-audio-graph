import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	BAG_NAME,
	BAG_PATH,
	BUILTIN_PACKAGE,
	INPUT_WAV_PATH,
	OUTPUT_WAV_PATH,
	PROFILE_DIR,
	RESTORED_BAG_NAME,
	RESTORED_BAG_PATH,
	SOURCE_NODE,
	STALE_BUILTIN_VERSION,
	VST3_NODE,
	WRITE_NODE,
} from "./constants";
import { sleep } from "./page";
import { writeSineWav } from "./wav";

interface PersistedNode {
	readonly id?: string;
	readonly nodeName?: string;
	readonly packageVersion?: string;
	readonly parameters?: Record<string, unknown>;
}

export interface PersistedBag {
	readonly id: string;
	readonly apiVersion: number;
	readonly name: string;
	readonly nodes: ReadonlyArray<PersistedNode>;
	readonly edges: ReadonlyArray<unknown>;
}

export function readPersistedBag(): PersistedBag {
	return JSON.parse(readFileSync(BAG_PATH, "utf8")) as PersistedBag;
}

interface PersistedGraphState {
	readonly positions?: Record<string, { x: number; y: number }>;
}

function readGraphPositions(bagId: string): Record<string, { x: number; y: number }> {
	try {
		const graphState = JSON.parse(
			readFileSync(join(PROFILE_DIR, "graphs", `${bagId}.json`), "utf8"),
		) as PersistedGraphState;

		return graphState.positions ?? {};
	} catch {
		return {};
	}
}

export async function waitForPositionEntry(
	bagId: string,
	nodeId: string,
	present: boolean,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (Object.prototype.hasOwnProperty.call(readGraphPositions(bagId), nodeId) === present) return true;

		await sleep(150);
	}

	return false;
}

export interface PersistedPackage {
	readonly requestedSpec?: string;
	readonly name?: string;
	readonly version?: string | null;
	readonly apiVersion?: number | null;
	readonly status?: string;
	readonly isBuiltIn?: boolean;
	readonly origin?: "catalog" | "dependency";
}

interface PersistedState {
	readonly packages?: ReadonlyArray<PersistedPackage>;
}

export interface PersistedStage {
	readonly pluginPath?: string;
	readonly pluginName?: string;
	readonly presetPath?: string;
}

export function readVst3FirstStage(): PersistedStage | null {
	const bag = readPersistedBag();
	const vst3 = bag.nodes.find((node) => node.nodeName === VST3_NODE);
	const stages = vst3?.parameters?.stages;

	if (!Array.isArray(stages) || stages.length === 0) return null;

	const stage = stages[0] as PersistedStage;

	return stage;
}

export function readBuiltinVersion(): string | null {
	try {
		return (
			readPersistedBag().nodes.find(
				(node) => typeof node.packageVersion === "string" && node.packageVersion.length > 0,
			)?.packageVersion ?? null
		);
	} catch {
		return null;
	}
}

function readBuiltInPackageState(): PersistedPackage | null {
	try {
		const state = JSON.parse(readFileSync(join(PROFILE_DIR, "state.json"), "utf8")) as PersistedState;

		return state.packages?.find((entry) => entry.isBuiltIn) ?? null;
	} catch {
		return null;
	}
}

function readRestoredDependencyState(): PersistedPackage | null {
	try {
		const state = JSON.parse(readFileSync(join(PROFILE_DIR, "state.json"), "utf8")) as PersistedState;

		return (
			state.packages?.find(
				(entry) =>
					entry.origin === "dependency" &&
					entry.name === BUILTIN_PACKAGE &&
					entry.version === STALE_BUILTIN_VERSION,
			) ?? null
		);
	} catch {
		return null;
	}
}

export async function waitForRefreshedBuiltInPackage(timeoutMs: number): Promise<PersistedPackage | null> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const entry = readBuiltInPackageState();

		if (entry?.status === "ready" && entry.version !== null && entry.version !== STALE_BUILTIN_VERSION) {
			return entry;
		}

		await sleep(100);
	}

	return readBuiltInPackageState();
}

export async function waitForRestoredDependency(timeoutMs: number): Promise<PersistedPackage | null> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const entry = readRestoredDependencyState();

		if (entry?.status === "ready") {
			return entry;
		}

		await sleep(100);
	}

	return readRestoredDependencyState();
}

export async function waitForPresetCommit(timeoutMs: number): Promise<string | null> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const stage = readVst3FirstStage();

		if (stage?.presetPath) return stage.presetPath;

		await sleep(300);
	}

	return null;
}

export function seedProfile(): string {
	mkdirSync(PROFILE_DIR, { recursive: true });

	writeSineWav(INPUT_WAV_PATH);
	rmSync(OUTPUT_WAV_PATH, { force: true });

	const bagId = randomUUID();
	const restoredBagId = randomUUID();
	const bag = { id: bagId, apiVersion: 1, name: BAG_NAME, nodes: [], edges: [] };

	writeFileSync(BAG_PATH, JSON.stringify(bag, null, 2));

	const restoredBag = {
		id: restoredBagId,
		apiVersion: 1,
		name: RESTORED_BAG_NAME,
		nodes: [
			{
				id: randomUUID(),
				packageName: BUILTIN_PACKAGE,
				packageVersion: STALE_BUILTIN_VERSION,
				nodeName: SOURCE_NODE,
				parameters: { path: INPUT_WAV_PATH },
			},
		],
		edges: [],
	};

	writeFileSync(RESTORED_BAG_PATH, JSON.stringify(restoredBag, null, 2));

	const state = {
		tabs: [
			{ id: bagId, bagPath: BAG_PATH },
			{ id: restoredBagId, bagPath: RESTORED_BAG_PATH },
		],
		activeTabId: restoredBagId,
		windowBounds: { x: 60, y: 60, width: 1600, height: 1000 },
		recentFiles: [
			{ id: restoredBagId, bagPath: RESTORED_BAG_PATH, name: RESTORED_BAG_NAME, lastOpened: Date.now() },
			{ id: bagId, bagPath: BAG_PATH, name: BAG_NAME, lastOpened: Date.now() - 1 },
		],
		packages: [
			{
				requestedSpec: `${BUILTIN_PACKAGE}@latest`,
				name: BUILTIN_PACKAGE,
				version: STALE_BUILTIN_VERSION,
				apiVersion: 1,
				status: "ready",
				error: null,
				nodes: [
					{
						nodeName: SOURCE_NODE,
						description: "Read WAV audio from a file",
						schema: {
							type: "object",
							properties: { path: { type: "string", input: "file", mode: "open" } },
							required: ["path"],
						},
						category: "source",
					},
					{
						nodeName: WRITE_NODE,
						description: "Write audio to a file",
						schema: {
							type: "object",
							properties: { path: { type: "string", input: "file", mode: "save" } },
							required: ["path"],
						},
						category: "target",
					},
				],
				isBuiltIn: true,
				origin: "catalog",
			},
			{
				requestedSpec: `${BUILTIN_PACKAGE}@${STALE_BUILTIN_VERSION}`,
				name: BUILTIN_PACKAGE,
				version: STALE_BUILTIN_VERSION,
				apiVersion: 1,
				status: "ready",
				error: null,
				nodes: [],
				isBuiltIn: false,
				origin: "dependency",
			},
		],
		binaries: {},
	};

	writeFileSync(join(PROFILE_DIR, "state.json"), JSON.stringify(state, null, 2));

	return restoredBagId;
}
