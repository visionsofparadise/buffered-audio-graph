/**
 * GUI smoke — CDP-driven end-to-end verification of the graph mutation path.
 *
 * Launches the desktop app on an isolated, persistent profile
 * (`.smoke-profile/`), seeds a restored per-node-pin bag tab, drives the
 * real UI over the Chrome DevTools Protocol, and asserts every graph mutation
 * works and persists. Coverage includes the cmdk add-node catalog (mouse +
 * keyboard pick), the edge insert chip, the reduced node menu, full-graph
 * render-to-completion through core, the version-guarded zero-target leaf
 * error, value-level undo/redo of rename/parameter/bypass edits, insert-on-edge
 * as a mutation, a mixed-sequence exact restore of the persisted bag, the
 * external file:changed reconcile, and the Settings modal. See design-testing.md
 * (2026-07-12 GUI smoke harness and 2026-07-18 regression net entries).
 *
 * Exit 0 on all assertions passing; 1 with a printed failure summary.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const DESKTOP_DIR = process.cwd();
const REPO_ROOT = resolve(DESKTOP_DIR, "..", "..");
const PROFILE_DIR = join(DESKTOP_DIR, ".smoke-profile");
const BAG_PATH = join(DESKTOP_DIR, ".smoke-seed.bag");
const RESTORED_BAG_PATH = join(PROFILE_DIR, "smoke-restored.bag");
const BAG_NAME = "Smoke Bag";
const RESTORED_BAG_NAME = "Restored Bag";
const PATH_SENTINEL = "C:/smoke/input.wav";
const PATH_SENTINEL_2 = "C:/smoke/param-undo.wav";
const INPUT_WAV_PATH = join(PROFILE_DIR, "smoke-input.wav");
const OUTPUT_WAV_PATH = join(PROFILE_DIR, "smoke-output.wav");

const BUILTIN_PACKAGE = "@buffered-audio/nodes";
const STALE_BUILTIN_VERSION = "0.22.0";
/** Core's leaf-must-be-a-target validation ships in nodes ≥ 0.21.0 (bundles core ≥ 0.10.0). */
const ZERO_TARGET_MIN_VERSION = "0.21.0";

const SOURCE_NODE = "Read WAV";
const TRANSFORM_NODE = "Gain";
const DUPLICATE_CHANNELS_NODE = "Duplicate Channels";
const WRITE_NODE = "Write";
const VST3_NODE = "VST3";
const OTT_MATCH = "OTT";

const DEBOUNCE_WAIT_MS = 1300;

interface Point {
	readonly x: number;
	readonly y: number;
}

interface PersistedNode {
	readonly id?: string;
	readonly nodeName?: string;
	readonly packageVersion?: string;
	readonly parameters?: Record<string, unknown>;
}

interface PersistedBag {
	readonly id: string;
	readonly apiVersion: number;
	readonly name: string;
	readonly nodes: ReadonlyArray<PersistedNode>;
	readonly edges: ReadonlyArray<unknown>;
}

/** Parse the persisted smoke bag from disk. Read after a settle wait (`DEBOUNCE_WAIT_MS`) so the debounced writer has flushed. */
function readPersistedBag(): PersistedBag {
	return JSON.parse(readFileSync(BAG_PATH, "utf8")) as PersistedBag;
}

interface PersistedGraphState {
	readonly positions?: Record<string, { x: number; y: number }>;
}

/** The persisted per-node positions for a bag (`graphs/{bagId}.json`), or `{}` before the debounced writer has created the file. */
function readGraphPositions(bagId: string): Record<string, { x: number; y: number }> {
	try {
		const graphState = JSON.parse(readFileSync(join(PROFILE_DIR, "graphs", `${bagId}.json`), "utf8")) as PersistedGraphState;

		return graphState.positions ?? {};
	} catch {
		return {};
	}
}

/** Poll `graphs/{bagId}.json` until `nodeId` has (or lacks) a positions entry, absorbing the ~800ms positions-write debounce. */
async function waitForPositionEntry(bagId: string, nodeId: string, present: boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if (Object.prototype.hasOwnProperty.call(readGraphPositions(bagId), nodeId) === present) return true;

		await sleep(150);
	}

	return false;
}

interface PersistedPackage {
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

interface PersistedStage {
	readonly pluginPath?: string;
	readonly pluginName?: string;
	readonly presetPath?: string;
}

/** Read the first stage of the persisted VST3 node, or null if absent. */
function readVst3FirstStage(): PersistedStage | null {
	const bag = readPersistedBag();
	const vst3 = bag.nodes.find((node) => node.nodeName === VST3_NODE);
	const stages = vst3?.parameters?.stages;

	if (!Array.isArray(stages) || stages.length === 0) return null;

	const stage = stages[0] as PersistedStage;

	return stage;
}

const failures: Array<string> = [];
const pageErrors: Array<string> = [];
const collectorAttached = new WeakSet<Page>();

function log(message: string): void {
	process.stdout.write(`${message}\n`);
}

/**
 * Attach the console/pageerror collectors to a page, deduped. Registered against
 * every page target as early as it is created (before any interaction) so a
 * load-time renderer crash ahead of page acquisition is still caught — Phase 1
 * review note.
 */
function attachCollectors(page: Page): void {
	if (collectorAttached.has(page)) return;

	collectorAttached.add(page);

	page.on("pageerror", (error: unknown) => {
		pageErrors.push(error instanceof Error ? error.message : String(error));
	});
	page.on("console", (message) => {
		if (message.type() === "error") log(`  [console.error] ${message.text()}`);
	});
}

function check(condition: boolean, message: string): void {
	if (condition) {
		log(`  PASS  ${message}`);
	} else {
		log(`  FAIL  ${message}`);
		failures.push(message);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function getFreePort(): Promise<number> {
	return new Promise((resolvePort, rejectPort) => {
		const server = createServer();

		server.on("error", rejectPort);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();

			if (address !== null && typeof address === "object") {
				const { port } = address;

				server.close(() => resolvePort(port));
			} else {
				server.close(() => rejectPort(new Error("Could not resolve a free port")));
			}
		});
	});
}

function httpGetStatus(url: string): Promise<number> {
	return new Promise((resolveStatus, rejectStatus) => {
		const request = http.get(url, (response) => {
			response.resume();
			resolveStatus(response.statusCode ?? 0);
		});

		request.on("error", rejectStatus);
	});
}

/** Write a 1-second 48 kHz 16-bit mono sine as a standard PCM WAV — the Read WAV input for the render assertion. */
function writeSineWav(filePath: string): void {
	const sampleRate = 48000;
	const seconds = 1;
	const frequency = 440;
	const numSamples = sampleRate * seconds;
	const bytesPerSample = 2;
	const dataSize = numSamples * bytesPerSample;
	const buffer = Buffer.alloc(44 + dataSize);

	buffer.write("RIFF", 0, "ascii");
	buffer.writeUInt32LE(36 + dataSize, 4);
	buffer.write("WAVE", 8, "ascii");
	buffer.write("fmt ", 12, "ascii");
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20); // PCM
	buffer.writeUInt16LE(1, 22); // mono
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
	buffer.writeUInt16LE(bytesPerSample, 32); // block align
	buffer.writeUInt16LE(16, 34); // bits per sample
	buffer.write("data", 36, "ascii");
	buffer.writeUInt32LE(dataSize, 40);

	for (let index = 0; index < numSamples; index++) {
		const sample = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.5;
		const clamped = Math.max(-1, Math.min(1, sample));

		buffer.writeInt16LE(Math.round(clamped * 32767), 44 + index * bytesPerSample);
	}

	writeFileSync(filePath, buffer);
}

/** The built-in nodes package version carried by the first added node in the saved bag (per-node `packageVersion`), or null. */
function readBuiltinVersion(): string | null {
	try {
		return readPersistedBag().nodes.find((node) => typeof node.packageVersion === "string" && node.packageVersion.length > 0)?.packageVersion ?? null;
	} catch {
		return null;
	}
}

/** Numeric dotted-version comparison: is `version` ≥ `target`? */
function versionAtLeast(version: string, target: string): boolean {
	const left = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const right = target.split(".").map((part) => Number.parseInt(part, 10) || 0);

	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const delta = (left[index] ?? 0) - (right[index] ?? 0);

		if (delta !== 0) return delta > 0;
	}

	return true;
}

function fileSize(filePath: string): number {
	try {
		return statSync(filePath).size;
	} catch {
		return -1;
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

		return state.packages?.find(
			(entry) =>
				entry.origin === "dependency" &&
				entry.name === BUILTIN_PACKAGE &&
				entry.version === STALE_BUILTIN_VERSION,
		) ?? null;
	} catch {
		return null;
	}
}

async function waitForRefreshedBuiltInPackage(timeoutMs: number): Promise<PersistedPackage | null> {
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

async function waitForRestoredDependency(timeoutMs: number): Promise<PersistedPackage | null> {
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

function seedProfile(): string {
	mkdirSync(PROFILE_DIR, { recursive: true });

	writeSineWav(INPUT_WAV_PATH);
	rmSync(OUTPUT_WAV_PATH, { force: true });

	const bagId = randomUUID();
	const restoredBagId = randomUUID();
	const bag = { id: bagId, apiVersion: 1, name: BAG_NAME, nodes: [], edges: [] };

	writeFileSync(BAG_PATH, JSON.stringify(bag, null, 2));

	// Restoring a tab must register the bag's exact dependency even when the
	// catalog advances independently to a newer version during startup.
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

async function selectSmokeTab(page: Page): Promise<void> {
	const closeButton = await page.$('button[aria-label="Close .smoke-seed"]');

	if (!closeButton) throw new Error("Persisted smoke tab was not found");

	await closeButton.evaluate((element) => {
		(element.parentElement)?.click();
	});

	const deadline = Date.now() + 10000;

	while (Date.now() < deadline) {
		if ((await nodeCount(page)) === 0 && (await page.$(".react-flow__renderer")) !== null) return;

		await sleep(100);
	}

	throw new Error("Persisted smoke tab did not load its empty graph");
}

async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		try {
			const status = await httpGetStatus(`http://127.0.0.1:${port}/json/version`);

			if (status === 200) return;
		} catch {
			// Endpoint not up yet.
		}

		await sleep(500);
	}

	throw new Error(`CDP endpoint on port ${port} did not come up`);
}

async function findAppPage(browser: Browser, timeoutMs: number): Promise<Page> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const pages = await browser.pages();
		const appPage = pages.find((candidate) => /^https?:\/\/localhost:\d+/.test(candidate.url()));

		if (appPage) return appPage;

		await sleep(500);
	}

	throw new Error("Could not find the app renderer page over CDP");
}

async function rectByText(page: Page, selector: string, text: string): Promise<Point | null> {
	return page.evaluate(
		(sel: string, txt: string): Point | null => {
			const elements = Array.from(document.querySelectorAll(sel));
			const match = elements.find((element) => (element.textContent).includes(txt));

			if (!match) return null;

			const rect = match.getBoundingClientRect();

			return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
		},
		selector,
		text,
	);
}

async function rectOf(page: Page, selector: string): Promise<Point | null> {
	const handle = await page.$(selector);

	if (!handle) return null;

	const box = await handle.boundingBox();

	return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
}

async function heightOf(page: Page, selector: string): Promise<number | null> {
	const handle = await page.$(selector);

	if (!handle) return null;

	const box = await handle.boundingBox();

	return box ? box.height : null;
}

async function heightByText(page: Page, selector: string, text: string): Promise<number | null> {
	const handles = await page.$$(selector);

	for (const handle of handles) {
		const matches = await handle.evaluate((element, txt: string) => (element.textContent).includes(txt), text);

		if (!matches) continue;

		const box = await handle.boundingBox();

		return box ? box.height : null;
	}

	return null;
}

async function nodeCount(page: Page): Promise<number> {
	return page.$$eval(".react-flow__node", (elements) => elements.length);
}

async function edgeCount(page: Page): Promise<number> {
	return page.$$eval(".react-flow__edge", (elements) => elements.length);
}

async function nodeIdByLabel(page: Page, label: string): Promise<string | null> {
	return page.evaluate((lbl: string): string | null => {
		const nodes = Array.from(document.querySelectorAll(".react-flow__node"));

		for (const node of nodes) {
			if ((node.textContent).includes(lbl)) return node.getAttribute("data-id");
		}

		return null;
	}, label);
}

interface RenderedNodeSummary {
	readonly count: number;
	readonly texts: ReadonlyArray<string>;
}

async function renderedNodeSummary(page: Page): Promise<RenderedNodeSummary> {
	return page.$$eval(".react-flow__node", (elements): RenderedNodeSummary => ({
		count: elements.length,
		texts: elements.slice(0, 8).map((element) => (element.textContent).replace(/\s+/g, " ").trim().slice(0, 120)),
	}));
}

async function waitForNodeCount(page: Page, expected: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if ((await nodeCount(page)) === expected) return true;

		await sleep(150);
	}

	return false;
}

async function waitForEdgeCount(page: Page, expected: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if ((await edgeCount(page)) === expected) return true;

		await sleep(150);
	}

	return false;
}

async function waitForEdgeAgreement(page: Page, expected: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let persisted: number | null = null;
	let rendered: number | null = null;
	let persistedError: string | null = null;

	while (Date.now() < deadline) {
		try {
			persisted = readPersistedBag().edges.length;
			persistedError = null;
		} catch (error: unknown) {
			persisted = null;
			persistedError = error instanceof Error ? error.message : String(error);
		}

		rendered = await edgeCount(page);

		if (persisted === expected && rendered === expected) return;

		await sleep(150);
	}

	throw new Error(
		`Edge agreement timed out: expected=${expected}, persisted=${String(persisted)}, rendered=${String(rendered)}, persistedError=${persistedError ?? "none"}`,
	);
}

async function clickPoint(page: Page, point: Point): Promise<void> {
	await page.mouse.click(point.x, point.y);
}

/**
 * Zoom the React Flow canvas out by `ticks` wheel steps over the pane centre.
 * The seeded empty bag's `fitView` zooms to maxZoom (2×) once the first node
 * mounts; at 2× the nodes are large and a handle-to-handle connect drag spans a
 * long diagonal that fails to register, so zooming out first keeps the drag short.
 */
async function zoomOut(page: Page, ticks: number): Promise<void> {
	const pane = await rectOf(page, ".react-flow__pane");

	if (!pane) return;

	await page.mouse.move(pane.x, pane.y);

	for (let tick = 0; tick < ticks; tick++) {
		await page.mouse.wheel({ deltaY: 200 });
		await sleep(80);
	}

	await sleep(200);
}

async function dragBetween(page: Page, from: Point, to: Point): Promise<void> {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();

	const steps = 12;

	for (let step = 1; step <= steps; step++) {
		const ratio = step / steps;

		await page.mouse.move(from.x + (to.x - from.x) * ratio, from.y + (to.y - from.y) * ratio);
		await sleep(15);
	}

	await page.mouse.up();
}

/**
 * Drag a React Flow connection from one handle to another. More deliberate than
 * `dragBetween`: it hovers the source handle before pressing and dwells on the
 * target handle before releasing, so React Flow registers the drop target (a
 * fast diagonal drag between distant handles can otherwise release with no
 * hovered target and drop the connection).
 */
async function connectHandles(page: Page, from: Point, to: Point): Promise<void> {
	await page.mouse.move(from.x, from.y);
	await sleep(80);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await sleep(80);

	const steps = 24;

	for (let step = 1; step <= steps; step++) {
		const ratio = step / steps;

		await page.mouse.move(from.x + (to.x - from.x) * ratio, from.y + (to.y - from.y) * ratio);
		await sleep(20);
	}

	// Dwell on the target handle so React Flow's drop-target detection latches.
	await page.mouse.move(to.x, to.y);
	await sleep(120);
	await page.mouse.move(to.x, to.y);
	await sleep(120);
	await page.mouse.up();
}

async function clickMenuItemByText(page: Page, text: string): Promise<boolean> {
	const items = await page.$$('[role="menuitem"]');

	for (const item of items) {
		const itemText = await item.evaluate((element) => element.textContent);

		if (!itemText.includes(text)) continue;

		await item.evaluate((element) => {
			element.scrollIntoView({ block: "center" });
		});
		await sleep(60);

		const box = await item.boundingBox();

		if (box) {
			await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

			return true;
		}
	}

	return false;
}

async function deleteNodeViaMenu(page: Page, nodeId: string): Promise<boolean> {
	// Drive the right-click node context menu (shares NodeMenuItems with the
	// header dots menu, so "Delete Node" invokes the same removeNode mutation).
	// The header dots menu's Radix trigger cannot be opened over CDP because
	// React Flow consumes the trigger's pointerdown for node selection; the
	// context menu opens from a controlled `open` state on right-click instead.
	const nodeOrigin = await page.$eval(`.react-flow__node[data-id="${nodeId}"]`, (element): { x: number; y: number } => {
		const rect = element.getBoundingClientRect();

		return { x: rect.x, y: rect.y };
	});

	await page.mouse.click(nodeOrigin.x + 40, nodeOrigin.y + 14, { button: "right" });

	try {
		await page.waitForSelector('[role="menuitem"]', { timeout: 3000 });
	} catch {
		return false;
	}

	await sleep(120);

	return clickMenuItemByText(page, "Delete Node");
}

async function dumpMenuItems(page: Page): Promise<Array<string>> {
	return page.$$eval('[role="menuitem"]', (elements) =>
		elements.map((element) => (element.textContent).replace(/\s+/g, " ").trim().slice(0, 40)),
	);
}

/** The full text of the currently open dropdown menu (`[role="menu"]`) — captures non-item rows like the read-only version label. */
async function openMenuText(page: Page): Promise<string> {
	return page.evaluate((): string => {
		const menu = document.querySelector('[role="menu"]');

		return menu ? (menu.textContent).replace(/\s+/g, " ").trim() : "";
	});
}

/**
 * The VST3 scan-root paths currently rendered in the open Settings modal.
 * Excludes any `Remove …` buttons inside graph nodes (a VST3 stage row's remove
 * control shares the `Remove ` prefix) so only the modal's root rows are read.
 */
async function scanRootLabels(page: Page): Promise<Array<string>> {
	return page.$$eval('button[aria-label^="Remove "]', (buttons) =>
		buttons
			.filter((button) => button.closest(".react-flow__node") === null)
			.map((button) => (button.getAttribute("aria-label") ?? "").replace(/^Remove /, "")),
	);
}

/** Open the Add-node catalog from the TopLeftOverlay trigger; resolves once the search input is present. */
async function openAddNodeCatalog(page: Page): Promise<void> {
	const trigger = await rectByText(page, "button", "Add node");

	if (!trigger) throw new Error("Add node trigger not found");

	await clickPoint(page, trigger);
	await page.waitForSelector("[data-catalog-input]", { timeout: 5000 });
	await sleep(150);
}

/** The visible node rows in the open catalog (`[data-catalog-item]`), trimmed. */
async function dumpCmdkItems(page: Page): Promise<Array<string>> {
	return page.$$eval("[data-catalog-item]", (elements) =>
		elements.map((element) => (element.textContent).replace(/\s+/g, " ").trim().slice(0, 40)),
	);
}

/** Click the catalog row whose text contains `text` via a real mouse click; returns whether one was found. */
async function clickCmdkItemByText(page: Page, text: string): Promise<boolean> {
	const items = await page.$$("[data-catalog-item]");

	for (const item of items) {
		const itemText = await item.evaluate((element) => element.textContent);

		if (!itemText.includes(text)) continue;

		await item.evaluate((element) => {
			element.scrollIntoView({ block: "center" });
		});
		await sleep(60);

		const box = await item.boundingBox();

		if (box) {
			await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

			return true;
		}
	}

	return false;
}

interface AddNodeOptions {
	/** cmdk search query typed into the input (defaults to the node label). */
	readonly search?: string;
	/** "click" picks the matching row with the mouse; "keyboard" uses ArrowDown+Enter (the cmdk-in-Radix focus check). */
	readonly method?: "click" | "keyboard";
}

async function addNode(page: Page, nodeLabel: string, expectedCount: number, options: AddNodeOptions = {}): Promise<string> {
	const search = options.search ?? nodeLabel;
	const method = options.method ?? "click";

	await sleep(DEBOUNCE_WAIT_MS);
	await openAddNodeCatalog(page);
	await page.keyboard.type(search, { delay: 20 });
	await sleep(250);

	if (method === "keyboard") {
		// Type-and-Enter picks the first (here, only) match from the search field.
		await page.keyboard.press("Enter");
	} else {
		const clicked = await clickCmdkItemByText(page, nodeLabel);

		if (!clicked) {
			const catalog = await dumpCmdkItems(page);

			throw new Error(`Catalog item "${nodeLabel}" not found. Catalog: ${catalog.join(" | ")}`);
		}
	}

	const deadline = Date.now() + 10000;
	let stableNodeId: string | null = null;
	let stableSince: number | null = null;

	while (Date.now() < deadline) {
		const [count, nodeId] = await Promise.all([nodeCount(page), nodeIdByLabel(page, nodeLabel)]);

		if (count === expectedCount && nodeId !== null) {
			if (nodeId !== stableNodeId) {
				stableNodeId = nodeId;
				stableSince = Date.now();
			}

			if (stableSince !== null && Date.now() - stableSince >= DEBOUNCE_WAIT_MS) {
				check(true, `add "${nodeLabel}" (${method}) — node identity is stable at count ${expectedCount}`);

				return nodeId;
			}
		} else {
			stableNodeId = null;
			stableSince = null;
		}

		await sleep(150);
	}

	const rendered = await renderedNodeSummary(page);
	const texts = rendered.texts.length > 0 ? rendered.texts.join(" | ") : "(none)";

	throw new Error(
		`Add "${nodeLabel}" (${method}) did not reach requested identity at count ${expectedCount}; rendered count=${rendered.count}, nodes=${texts}`,
	);
}

/**
 * Set a node's first text param (its file-path input) via the native value setter
 * + input event, then confirm the value committed. The file input is uncontrolled
 * (`key={param.value}`, so it remounts to the committed value); a set that fails to
 * commit reverts to empty on the next remount, so this retries until the round-trip
 * sticks — hardening against a transient post-interaction remount race.
 */
async function setNodePathParam(page: Page, nodeId: string, value: string): Promise<void> {
	const selector = `.react-flow__node[data-id="${nodeId}"] input[type="text"]`;

	await page.waitForSelector(selector, { timeout: 5000 });

	for (let attempt = 0; attempt < 6; attempt++) {
		await page.$eval(
			selector,
			(element, pathValue: string) => {
				const input = element as HTMLInputElement;
				const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");

				descriptor?.set?.call(input, pathValue);
				input.dispatchEvent(new Event("input", { bubbles: true }));
				input.dispatchEvent(new Event("blur", { bubbles: true }));
			},
			value,
		);
		await sleep(300);

		const committed = await page.$eval(selector, (element) => (element as HTMLInputElement).value).catch(() => "");

		if (committed === value) return;
	}
}

/** The current value of a node's first text input (its file-path param), or null when absent. */
async function paramInputValue(page: Page, nodeId: string): Promise<string | null> {
	return page
		.$eval(`.react-flow__node[data-id="${nodeId}"] input[type="text"]`, (element) => (element).value)
		.catch(() => null);
}

/** Whether a node renders bypassed (its body carries `.opacity-60`). */
async function isNodeBypassed(page: Page, nodeId: string): Promise<boolean> {
	return page.evaluate((id: string): boolean => {
		const node = document.querySelector(`.react-flow__node[data-id="${id}"]`);

		return node ? node.querySelector(".opacity-60") !== null : false;
	}, nodeId);
}

/**
 * Click a neutral point on the React Flow pane (offset into its top-left
 * quarter, clear of the centred nodes and the corner overlays) to move focus
 * out of any field before undo/redo — the Canvas keydown handler ignores
 * Ctrl+Z while an INPUT/TEXTAREA has focus.
 */
async function defocus(page: Page): Promise<void> {
	const pane = await rectOf(page, ".react-flow__pane");

	if (!pane) return;

	await clickPoint(page, { x: pane.x / 2, y: pane.y / 2 });
	await sleep(100);
}

/**
 * Rename the graph by driving the active tab's `TabNameInput`: click the tab
 * bar's text input (scoped to the AppBar via the App-menu trigger so node
 * parameter inputs never match), select-all, type the name, commit with Enter,
 * and wait out the save debounce.
 */
async function renameGraph(page: Page, name: string): Promise<void> {
	const inputPoint = await page.evaluate((): Point | null => {
		const bar = document.querySelector('button[aria-label="App menu"]')?.closest("div.h-12");
		const input = bar?.querySelector('input[type="text"]');

		if (!input) return null;

		const rect = input.getBoundingClientRect();

		return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
	});

	if (!inputPoint) throw new Error("Active tab name input was not found in the AppBar");

	await clickPoint(page, inputPoint);
	await sleep(100);
	await page.keyboard.down("Control");
	await page.keyboard.press("A");
	await page.keyboard.up("Control");
	await page.keyboard.type(name, { delay: 20 });
	await page.keyboard.press("Enter");
	await sleep(DEBOUNCE_WAIT_MS);
}

/** Click a plain `<button>` (not a menuitem) whose text contains `text` — used for the Settings left-nav rows. */
async function clickButtonByText(page: Page, text: string): Promise<boolean> {
	const buttons = await page.$$("button");

	for (const button of buttons) {
		const buttonText = await button.evaluate((element) => element.textContent);

		if (!buttonText.includes(text)) continue;

		await button.evaluate((element) => {
			element.scrollIntoView({ block: "center" });
		});
		await sleep(60);

		const box = await button.boundingBox();

		if (box) {
			await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

			return true;
		}
	}

	return false;
}

interface RenderToastState {
	readonly present: boolean;
	readonly failed: boolean;
	readonly error: string | null;
}

/** The render toast's live state, keyed off its unique "In progress"/"Failed" footer status span. */
async function renderToastState(page: Page): Promise<RenderToastState> {
	return page.evaluate((): RenderToastState => {
		const spans = Array.from(document.querySelectorAll("span"));
		const status = spans.find((span) => span.textContent === "In progress" || span.textContent === "Failed");

		if (!status) return { present: false, failed: false, error: null };

		const failed = status.textContent === "Failed";
		const errorSpan = spans.find(
			(span) => span.className.includes("text-error") && span.className.includes("text-body"),
		);

		return { present: true, failed, error: failed ? (errorSpan?.textContent ?? "") : null };
	});
}

/** Wait until a render settles with its output present and the toast gone, or the toast reports failure. */
async function waitForRenderOutput(
	page: Page,
	outputPath: string,
	timeoutMs: number,
): Promise<{ ok: boolean; error: string | null }> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const state = await renderToastState(page);

		if (state.failed) return { ok: false, error: state.error };

		if (fileSize(outputPath) > 0 && !state.present) return { ok: true, error: null };

		await sleep(200);
	}

	return { ok: false, error: "timed out waiting for render completion" };
}

/** Wait for the render toast to report failure and return its error text, or null on timeout. */
async function waitForRenderError(page: Page, timeoutMs: number): Promise<string | null> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const state = await renderToastState(page);

		if (state.failed) return state.error ?? "";

		await sleep(150);
	}

	return null;
}

/** Right-click a node, read its context-menu vocabulary, and leave the menu open for inspection. */
async function openNodeMenuAndDump(page: Page, nodeId: string): Promise<Array<string>> {
	const nodeOrigin = await page.$eval(`.react-flow__node[data-id="${nodeId}"]`, (element): { x: number; y: number } => {
		const rect = element.getBoundingClientRect();

		return { x: rect.x, y: rect.y };
	});

	await page.mouse.click(nodeOrigin.x + 40, nodeOrigin.y + 14, { button: "right" });

	try {
		await page.waitForSelector('[role="menuitem"]', { timeout: 3000 });
	} catch {
		return [];
	}

	await sleep(120);

	return dumpMenuItems(page);
}

/** Drag a node clear of the canvas centre by its header, so a subsequent add lands without overlap. */
async function dragNodeBy(page: Page, nodeId: string, deltaX: number, deltaY: number): Promise<void> {
	const origin = await page.$eval(`.react-flow__node[data-id="${nodeId}"]`, (element): { x: number; y: number } => {
		const rect = element.getBoundingClientRect();

		return { x: rect.x, y: rect.y };
	});

	await dragBetween(page, { x: origin.x + 40, y: origin.y + 14 }, { x: origin.x + 40 + deltaX, y: origin.y + 14 + deltaY });
	await sleep(300);
}

/** Select each node (header click) and press Delete until the graph is empty, resolving whether it cleared. */
async function clearGraph(page: Page): Promise<boolean> {
	for (let attempt = 0; attempt < 6; attempt++) {
		const ids = await page.$$eval(".react-flow__node", (elements) =>
			elements.map((element) => element.getAttribute("data-id")).filter((id): id is string => id !== null),
		);

		if (ids.length === 0) return true;

		for (const id of ids) {
			const origin = await page.$eval(`.react-flow__node[data-id="${id}"]`, (element): { x: number; y: number } => {
				const rect = element.getBoundingClientRect();

				return { x: rect.x, y: rect.y };
			});

			await page.mouse.click(origin.x + 40, origin.y + 8);
			await sleep(100);
			await page.keyboard.press("Delete");
			await sleep(200);
		}

		if (await waitForNodeCount(page, 0, 2000)) return true;
	}

	return (await nodeCount(page)) === 0;
}

/**
 * Click a plain (non-Radix) button inside a node by its text via a synthetic DOM
 * click. React Flow's node pointer handling swallows CDP mouse events on body
 * buttons, but a dispatched `.click()` fires the button's onClick directly (the
 * Phase 1 `.click()` caveat is Radix-trigger-specific: those need real pointerdown).
 */
async function clickButtonInNodeByText(page: Page, nodeId: string, text: string): Promise<boolean> {
	return page.evaluate(
		(id: string, needle: string): boolean => {
			const node = document.querySelector(`.react-flow__node[data-id="${id}"]`);

			if (!node) return false;

			const button = Array.from(node.querySelectorAll("button")).find((candidate) =>
				candidate.textContent.includes(needle),
			);

			if (!button) return false;

			button.click();

			return true;
		},
		nodeId,
		text,
	);
}

/** Synthetic DOM `.click()` on a body element inside a node, matched by selector. */
async function synthClickInNode(page: Page, nodeId: string, selector: string): Promise<boolean> {
	return page.evaluate(
		(id: string, sel: string): boolean => {
			const node = document.querySelector(`.react-flow__node[data-id="${id}"]`);
			const target = node?.querySelector(sel);

			if (!(target instanceof HTMLElement)) return false;

			target.click();

			return true;
		},
		nodeId,
		selector,
	);
}

/**
 * Open a stage's plugin picker. The picker trigger is a Radix DropdownMenu inside
 * a React Flow node; React Flow's node pointerdown handling swallows the trigger's
 * pointer events over CDP (Phase 1 finding), so the picker is opened via keyboard
 * (focus + Enter) — Radix opens on the trigger's keydown, which React Flow ignores.
 * Returns true once the menu is present.
 */
async function openStagePicker(page: Page, nodeId: string): Promise<boolean> {
	const triggerSelector = `.react-flow__node[data-id="${nodeId}"] button[aria-label="Select plugin"]`;

	await page.waitForSelector(triggerSelector, { timeout: 5000 });

	const handle = await page.$(triggerSelector);

	if (!handle) return false;

	// Radix sets data-state="open" on the trigger whose own menu is open — the
	// authoritative signal that THIS picker (not a stray node-catalog menu) opened.
	const isOpen = (): Promise<boolean> => handle.evaluate((element) => element.getAttribute("data-state") === "open");

	// Close any stray menu (e.g. the add-node catalog) before opening this one.
	await page.keyboard.press("Escape");
	await sleep(150);

	for (const activate of ["Enter", "Space", "click"] as const) {
		await handle.focus();

		if (activate === "click") {
			const box = await handle.boundingBox();

			if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
		} else {
			await page.keyboard.press(activate);
		}

		const deadline = Date.now() + 2000;

		while (Date.now() < deadline) {
			if (await isOpen()) return true;

			await sleep(150);
		}
	}

	return false;
}

/** The text of a node's stage-picker trigger (the resolved plugin title or empty state). */
async function stageTriggerText(page: Page, nodeId: string): Promise<string> {
	return page.$eval(
		`.react-flow__node[data-id="${nodeId}"] button[aria-label="Select plugin"]`,
		(element) => element.textContent,
	);
}

/** Poll until the open picker renders at least one entry (menuitem), or time out. */
async function waitForMenuItems(page: Page, timeoutMs: number): Promise<number> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const count = await page.$$eval('[role="menuitem"]', (elements) => elements.length);

		if (count > 0) return count;

		await sleep(300);
	}

	return 0;
}

/** Poll the persisted bag until the VST3 first stage's presetPath is non-empty, or time out. */
async function waitForPresetCommit(timeoutMs: number): Promise<string | null> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const stage = readVst3FirstStage();

		if (stage?.presetPath) return stage.presetPath;

		await sleep(300);
	}

	return null;
}

/**
 * VST3 stage-editor coverage (Phase 7.3). Adds a VST3 node, adds a stage, opens
 * the plugin picker, picks OTT, opens its GUI (auto-closed via
 * BAG_VST3_SMOKE_CLOSE_MS), and asserts the preset path follows the saved event
 * to a non-empty file. Gated: if the scan returns zero entries, the section is
 * skipped with a printed notice rather than failing.
 */
async function runVst3Section(page: Page, expectedNodeCount: number): Promise<void> {
	log("VST3 stage editor:");

	const vst3Id = await addNode(page, VST3_NODE, expectedNodeCount);

	const addedStage = await clickButtonInNodeByText(page, vst3Id, "Add stage");

	check(addedStage, "VST3 — add a stage row");

	await sleep(600);

	const opened = await openStagePicker(page, vst3Id);

	check(opened, "VST3 — stage plugin picker opens");

	if (!opened) return;

	const entryCount = await waitForMenuItems(page, 30000);

	if (entryCount === 0) {
		log("  SKIP  VST3 scan returned zero entries — no installed plugins in the scan roots; skipping the picker/open assertions.");

		await page.keyboard.press("Escape");

		return;
	}

	log(`  INFO  picker rendered ${entryCount} scan entr${entryCount === 1 ? "y" : "ies"}`);

	const pickedOtt = await clickMenuItemByText(page, OTT_MATCH);

	check(pickedOtt, `VST3 — pick ${OTT_MATCH} from the scan results`);

	if (!pickedOtt) {
		const catalog = await dumpMenuItems(page);

		log(`  INFO  scan entries (first 40): ${catalog.slice(0, 40).join(" | ")}`);
		await page.keyboard.press("Escape");

		return;
	}

	await sleep(300);

	const title = await stageTriggerText(page, vst3Id);

	check(title.includes(OTT_MATCH), `VST3 — stage title updates to the picked plugin (got "${title}")`);

	// The pluginPath commit persists after the debounce.
	await sleep(DEBOUNCE_WAIT_MS);

	const pickedStage = readVst3FirstStage();

	check(
		typeof pickedStage?.pluginPath === "string" && pickedStage.pluginPath.length > 0,
		`VST3 — bag gains a pluginPath ("${String(pickedStage?.pluginPath)}")`,
	);

	// Open the plugin GUI; it auto-closes after ~3s (BAG_VST3_SMOKE_CLOSE_MS). The
	// button is a body IconButton, so it needs a synthetic click (React Flow swallows
	// CDP pointer events on body buttons — same as the "Add stage" click above).
	const launched = await synthClickInNode(page, vst3Id, 'button[aria-label="Open editor"]');

	check(launched, "VST3 — click Open to launch the plugin GUI");
	log("  INFO  launched the plugin GUI (auto-closes in ~3s via BAG_VST3_SMOKE_CLOSE_MS)");

	// The saved event fires on close; the preset path then commits and persists.
	const presetPath = await waitForPresetCommit(20000);

	check(presetPath !== null, `VST3 — presetPath follows the saved event and commits ("${String(presetPath)}")`);

	if (presetPath === null) return;

	let presetSize = 0;

	try {
		presetSize = statSync(presetPath).size;
	} catch {
		presetSize = -1;
	}

	check(presetSize > 0, `VST3 — preset file exists and is non-empty (${presetSize} bytes)`);
}

/** Whether the toolbar Render button is enabled (the render gate open — every pinned pair installed and ready). */
async function isRenderEnabled(page: Page): Promise<boolean> {
	return page.evaluate((): boolean => {
		const button = Array.from(document.querySelectorAll("button")).find((candidate) =>
			(candidate.textContent).includes("Render"),
		);

		return button instanceof HTMLButtonElement ? !button.disabled : false;
	});
}

/** Click the toolbar Render action (present as "Render" while idle, "Abort" while running). */
async function clickRender(page: Page): Promise<void> {
	const render = await rectByText(page, "button", "Render");

	if (!render) throw new Error("Render button not found");

	await clickPoint(page, render);
}

/** Dismiss the render toast (its `×` clears a shown error or aborts a running render). */
async function dismissRenderToast(page: Page): Promise<void> {
	const dismiss = (await rectOf(page, 'button[aria-label="Dismiss"]')) ?? (await rectOf(page, 'button[aria-label="Cancel render"]'));

	if (dismiss) await clickPoint(page, dismiss);

	await sleep(200);
}

/**
 * Full-graph render coverage (Phase 4.1). Runs on a fresh graph and clears it
 * afterward: builds Read WAV → Write against a seeded input WAV and asserts the
 * output materializes; version-guards the zero-target leaf-validation assertion
 * on the built-in's actual capability (core ≥ 0.10.0, i.e. nodes ≥ 0.21.0).
 */
async function runRenderSection(page: Page): Promise<void> {
	log("Render — full-graph execution through core:");

	const readId = await addNode(page, SOURCE_NODE, 1, { search: "read" });

	// Set the input path before moving the node: a drag leaves React Flow's node
	// in a state where the file input's change does not commit, so set-then-drag
	// (the commit survives the position change) rather than drag-then-set.
	await setNodePathParam(page, readId, INPUT_WAV_PATH);

	// Move Read WAV well clear of centre while it is the only node (unambiguous
	// drag), so the Write node added next lands to its right without overlap.
	await dragNodeBy(page, readId, -450, 0);

	// The built-in version resolved into the bag drives the zero-target guard.
	await sleep(DEBOUNCE_WAIT_MS);

	const builtinVersion = readBuiltinVersion();

	log(`  INFO  render assertions exercise ${BUILTIN_PACKAGE}@${builtinVersion ?? "unknown"}`);

	const zeroTargetSupported = builtinVersion !== null && versionAtLeast(builtinVersion, ZERO_TARGET_MIN_VERSION);

	// Zero-target: a lone Read WAV is a leaf that is not a target. Only packages
	// bundling core ≥ 0.10.0 carry the leaf validation — guard on the capability.
	if (zeroTargetSupported) {
		await clickRender(page);

		const errorText = await waitForRenderError(page, 20000);

		check(
			errorText !== null && /is not a target|end in a target/i.test(errorText),
			`zero-target — render toast shows core's leaf-validation error ("${String(errorText)}")`,
		);

		await dismissRenderToast(page);
	} else {
		log(
			`  SKIP  zero-target error — ${BUILTIN_PACKAGE}@${builtinVersion ?? "unknown"} predates the leaf validation (needs ≥ ${ZERO_TARGET_MIN_VERSION}); asserted once the 0.21.0 built-in publishes.`,
		);
	}

	const writeId = await addNode(page, WRITE_NODE, 2, { search: "write" });

	await setNodePathParam(page, writeId, OUTPUT_WAV_PATH);

	await zoomOut(page, 4);

	const sourceHandle = await rectOf(page, `.react-flow__node[data-id="${readId}"] .react-flow__handle-right`);
	const targetHandle = await rectOf(page, `.react-flow__node[data-id="${writeId}"] .react-flow__handle-left`);

	if (!sourceHandle || !targetHandle) throw new Error("Could not locate render-graph connection handles");

	await connectHandles(page, sourceHandle, targetHandle);

	check(await waitForEdgeCount(page, 1, 8000), "render graph — Read WAV → Write connected (edge = 1)");

	// Render gate happy path: both nodes were added at the installed catalog version,
	// so every pinned pair is ready and the Render button is enabled before click.
	check(await isRenderEnabled(page), "render gate — Render button enabled once both pinned packages are ready");

	rmSync(OUTPUT_WAV_PATH, { force: true });

	await clickRender(page);

	const outcome = await waitForRenderOutput(page, OUTPUT_WAV_PATH, 60000);

	check(outcome.ok, `render to completion — output written and toast settled (${outcome.error ?? "ok"})`);
	check(fileSize(OUTPUT_WAV_PATH) > 0, `render to completion — output file exists and is non-empty (${fileSize(OUTPUT_WAV_PATH)} bytes)`);

	await dismissRenderToast(page);

	check(await clearGraph(page), "render section — graph cleared for the mutation flow (nodes = 0)");
}

async function run(): Promise<void> {
	const bagId = seedProfile();

	log(`Seeded profile at ${PROFILE_DIR} (bag ${bagId})`);

	const port = await getFreePort();

	log(`Using remote debugging port ${port}`);

	const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
	const child: ChildProcess = spawn(
		npmCommand,
		["run", "start", "--workspace", "desktop", "--", "--", `--remote-debugging-port=${port}`],
		{
			cwd: REPO_ROOT,
			stdio: ["pipe", "pipe", "pipe"],
			// BAG_VST3_SMOKE_CLOSE_MS makes the Vst3/launchEditor handler append
			// --close-after-ms so the opened plugin GUI auto-closes (Phase 5.2, env-only).
			env: { ...process.env, BAG_USER_DATA: PROFILE_DIR, BAG_VST3_SMOKE_CLOSE_MS: "3000" },
			windowsHide: true,
			shell: true,
		},
	);

	child.stdout?.on("data", (chunk: Buffer) => process.stderr.write(`[app] ${chunk.toString()}`));
	child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[app] ${chunk.toString()}`));

	let browser: Browser | null = null;

	try {
		await waitForCdp(port, 60000);

		browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });

		// Register the collectors before page acquisition: against any page target
		// as it appears, and against every page already open. A load-time renderer
		// crash ahead of findAppPage is then still recorded (Phase 1 review note).
		browser.on("targetcreated", (target) => {
			void target.page().then((created) => {
				if (created) attachCollectors(created);
			});
		});

		for (const existing of await browser.pages()) attachCollectors(existing);

		const page = await findAppPage(browser, 60000);

		attachCollectors(page);

		// Wait out the package install + loading screen. On success the app
		// auto-proceeds to the graph with no Continue click (Phase 2.1); the button
		// exists only on the error path.
		await page.waitForSelector(".react-flow__renderer", { timeout: 300000 });

		const refreshedPackage = await waitForRefreshedBuiltInPackage(10000);

		check(
			refreshedPackage?.status === "ready" && refreshedPackage.version !== null && refreshedPackage.version !== STALE_BUILTIN_VERSION,
			`stale package lifecycle resets and reloads (${STALE_BUILTIN_VERSION} → ${String(refreshedPackage?.version)})`,
		);

		const restoredDependency = await waitForRestoredDependency(10000);
		const restoredNodes = await renderedNodeSummary(page);

		check(
			restoredDependency?.status === "ready" && restoredDependency.requestedSpec === `${BUILTIN_PACKAGE}@${STALE_BUILTIN_VERSION}`,
			`restored tab registers exact dependency ${BUILTIN_PACKAGE}@${STALE_BUILTIN_VERSION}`,
		);
		check(
			restoredNodes.count === 1 &&
				restoredNodes.texts.some((text) => text.includes(SOURCE_NODE)) &&
			restoredNodes.texts.every((text) => !/node unavailable/i.test(text)),
			`restored ${SOURCE_NODE} resolves against its pinned package (${restoredNodes.texts.join(" | ")})`,
		);
		await selectSmokeTab(page);
		check(true, "restored-tab regression returns to the untouched smoke graph");

		const sawContinueButton = await page.evaluate(() =>
			Array.from(document.querySelectorAll("button")).some((button) => (button.textContent).includes("Continue")),
		);

		check(!sawContinueButton, "loading auto-proceeds to the graph with no Continue button (success path)");

		// 2.2 (menu reduced to Quit while loading) is verified attended: the warm
		// smoke profile resolves packages too fast to reliably catch the chromeOnly
		// menu state over CDP, and the plan forbids a forced chromeOnly render.
		log(
			"  NOTE  2.2 menu-during-loading (Quit-only) verified attended — not asserted here (loading window too short over CDP; forced render disallowed).",
		);

		await page.waitForFunction(
			() => Array.from(document.querySelectorAll("button")).some((button) => (button.textContent).includes("Add node")),
			{ timeout: 30000, polling: 300 },
		);
		await sleep(500);

		// 2.3: the app-menu trigger fills the full 48px bar height — flush highlight.
		const menuTriggerHeight = await heightOf(page, 'button[aria-label="App menu"]');

		check(menuTriggerHeight === 48, `menu trigger fills the 48px bar height (got ${String(menuTriggerHeight)})`);

		// 2.4: Add-node and Render match the adjacent icon buttons' height (uniform
		// toolbar). Tolerance 1px absorbs the text line-box vs. icon-box subpixel gap.
		const addNodeHeight = await heightByText(page, "button", "Add node");
		const renderHeight = await heightByText(page, "button", "Render");
		const iconButtonHeight = await heightOf(page, 'button[aria-label="Undo"]');

		check(
			addNodeHeight !== null && iconButtonHeight !== null && Math.abs(addNodeHeight - iconButtonHeight) <= 1,
			`Add-node height matches icon buttons (add ${String(addNodeHeight)} vs icon ${String(iconButtonHeight)})`,
		);
		check(
			renderHeight !== null && iconButtonHeight !== null && Math.abs(renderHeight - iconButtonHeight) <= 1,
			`Render height matches icon buttons (render ${String(renderHeight)} vs icon ${String(iconButtonHeight)})`,
		);

		// Full-graph render (Phase 4.1): runs first on a fresh graph and clears it,
		// so the mutation flow below still starts from an empty canvas.
		await runRenderSection(page);

		// 1 + 2: add two nodes through the catalog — Read WAV picked by mouse, Gain
		// picked by keyboard (type-to-filter then Enter selects the first match).
		const sourceId = await addNode(page, SOURCE_NODE, 1, { search: "read" });
		const transformId = await addNode(page, TRANSFORM_NODE, 2, { search: "gain", method: "keyboard" });

		check(
			transformId.length > 0,
			"catalog keyboard nav — type-to-filter then Enter adds the first match",
		);

		// 3: separate the overlapping nodes by dragging the transform node's header.
		const transformRect = await page.$eval(
			`.react-flow__node[data-id="${transformId}"]`,
			(element): { x: number; y: number } => {
				const rect = element.getBoundingClientRect();

				return { x: rect.x, y: rect.y };
			},
		);

		await dragBetween(
			page,
			{ x: transformRect.x + 40, y: transformRect.y + 14 },
			{ x: transformRect.x + 340, y: transformRect.y + 14 },
		);
		await sleep(300);

		// 4: connect source output handle -> transform input handle.
		const sourceHandle = await rectOf(page, `.react-flow__node[data-id="${sourceId}"] .react-flow__handle-right`);
		const targetHandle = await rectOf(page, `.react-flow__node[data-id="${transformId}"] .react-flow__handle-left`);

		if (!sourceHandle || !targetHandle) throw new Error("Could not locate connection handles");

		await connectHandles(page, sourceHandle, targetHandle);

		check(await waitForEdgeCount(page, 1, 8000), "connect nodes — edge count reaches 1");
		await waitForEdgeAgreement(page, 1, 5000);
		check(true, "connect nodes — edge remains in the BAG and renderer after autosave reconciliation");

		// 4b: edge insert chip — hovering the edge reveals the `+` chip; clicking it
		// opens the insert catalog and must NOT delete the edge (the Phase-3 3.4 fix).
		const chipMid = { x: (sourceHandle.x + targetHandle.x) / 2, y: (sourceHandle.y + targetHandle.y) / 2 };
		let chipShown = false;

		for (const dy of [0, -8, 8, -16, 16]) {
			await page.mouse.move(chipMid.x, chipMid.y + dy);
			await sleep(200);

			if ((await page.$("[data-edge-insert]")) !== null) {
				chipShown = true;
				break;
			}
		}

		check(chipShown, "edge chip — hovering the edge reveals the insert chip");

		if (chipShown) {
			const chipButton = await page.$('[data-edge-insert] button[aria-label="Insert node"]');
			const chipBox = chipButton ? await chipButton.boundingBox() : null;

			if (chipBox) {
				await page.mouse.click(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);

				const catalogOpened = await page
					.waitForSelector("[data-catalog-input]", { timeout: 3000 })
					.then(() => true)
					.catch(() => false);

				check(catalogOpened, "edge chip — clicking the + chip opens the insert catalog");
				check(await edgeCount(page) === 1, "edge chip — the edge survives the chip click (still 1)");

				await page.keyboard.press("Escape");
				await sleep(200);
			} else {
				check(false, "edge chip — insert button had no bounding box");
			}
		}

		// 5 + 6: structural undo/redo — node/edge counts follow. Post-migration,
		// positions are historied uniformly, so the setup drag that separated the
		// Gain node is its own history entry sitting between the edge and the
		// node-add: the undo order is edge, drag (no count change), node-add.
		await defocus(page);

		await undo(page);
		const edgeRemovedByUndo = await waitForEdgeCount(page, 0, 5000);

		if (!edgeRemovedByUndo) {
			await sleep(DEBOUNCE_WAIT_MS);

			const undoBag = readPersistedBag();
			const renderedEdges = await edgeCount(page);

			throw new Error(
				`Undo edge reconciliation failed: persisted edges=${undoBag.edges.length}, rendered edges=${renderedEdges}`,
			);
		}

		check(true, "undo 1 — edge removed (edges = 0)");

		// The Gain separation drag is one historied entry; undoing it moves the node
		// back, leaving the node/edge counts unchanged.
		await undo(page);
		check(await waitForNodeCount(page, 2, 2000), "undo 2 — drag reversed, node count unchanged (nodes = 2)");

		await undo(page);
		check(await waitForNodeCount(page, 1, 5000), "undo 3 — transform node removed (nodes = 1)");

		await redo(page);
		check(await waitForNodeCount(page, 2, 5000), "redo 1 — transform node restored (nodes = 2)");

		await redo(page);
		check(await waitForNodeCount(page, 2, 2000), "redo 2 — drag replayed, node count unchanged (nodes = 2)");

		await redo(page);
		check(await waitForEdgeCount(page, 1, 5000), "redo 3 — edge restored (edges = 1)");

		// 7: type into the source node's file path param and blur.
		const inputSelector = `.react-flow__node[data-id="${sourceId}"] input[type="text"]`;

		await page.waitForSelector(inputSelector, { timeout: 5000 });
		await page.$eval(
			inputSelector,
			(element, value: string) => {
				const input = element as HTMLInputElement;
				const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");

				descriptor?.set?.call(input, value);
				input.dispatchEvent(new Event("input", { bubbles: true }));
				input.dispatchEvent(new Event("blur", { bubbles: true }));
			},
			PATH_SENTINEL,
		);
		await sleep(300);

		const committedValue = await page.$eval(
			inputSelector,
			(element) => (element as HTMLInputElement).value,
		);

		check(committedValue === PATH_SENTINEL, `type param — input value persists ("${committedValue}")`);

		// 8: toggle bypass on the source node.
		const bypassButton = await rectOf(page, `.react-flow__node[data-id="${sourceId}"] button[aria-label="Bypass"]`);

		if (!bypassButton) throw new Error("Bypass button not found");

		await clickPoint(page, bypassButton);
		await sleep(300);

		check(await isNodeBypassed(page, sourceId), "toggle bypass — node shows opacity-60");

		// 9: the node menu is exactly Bypass/Enable, Reset, Delete Node (Phase 3.2 —
		// Render/Abort dropped) plus a read-only package@version label (Phase 5.1 —
		// a DropdownMenuLabel, not an item, so the item count stays 3), then delete
		// through the same menu.
		const nodeMenuItems = await openNodeMenuAndDump(page, transformId);
		const menuText = await openMenuText(page);
		const hasBypass = nodeMenuItems.some((item) => /bypass|enable/i.test(item));
		const hasReset = nodeMenuItems.some((item) => /reset/i.test(item));
		const hasDelete = nodeMenuItems.some((item) => item.includes("Delete Node"));
		const hasRenderAbort = nodeMenuItems.some((item) => /render|abort/i.test(item));

		check(
			nodeMenuItems.length === 3 && hasBypass && hasReset && hasDelete && !hasRenderAbort,
			`node menu is exactly Bypass/Reset/Delete Node (${nodeMenuItems.join(" | ")})`,
		);

		const menuVersion = readBuiltinVersion();
		const expectedLabel = `${BUILTIN_PACKAGE}@${menuVersion ?? ""}`;

		check(
			menuVersion !== null && menuText.includes(expectedLabel),
			`node menu shows the read-only version label "${expectedLabel}" (menu text: ${menuText})`,
		);

		await page.keyboard.press("Escape");
		await sleep(150);

		const deleted = await deleteNodeViaMenu(page, transformId);

		check(deleted, "delete node — opened node menu and selected Delete Node");
		check(await waitForNodeCount(page, 1, 5000), "delete node — node count returns to 1");
		check(await waitForEdgeCount(page, 0, 5000), "delete node — dependent edge removed (edges = 0)");

		// 10: after the debounce window, the persisted bag matches the UI.
		await sleep(DEBOUNCE_WAIT_MS);

		const persisted = readPersistedBag();

		check(persisted.nodes.length === 1, `persisted bag has 1 node (has ${persisted.nodes.length})`);
		check(persisted.edges.length === 0, `persisted bag has 0 edges (has ${persisted.edges.length})`);

		const persistedPath = persisted.nodes[0]?.parameters?.path;

		check(
			persistedPath === PATH_SENTINEL,
			`persisted param path equals typed value ("${String(persistedPath)}")`,
		);

		const duplicateChannelsId = await addNode(page, DUPLICATE_CHANNELS_NODE, 2, { search: "duplicate channels" });

		const readoutSelector = `.react-flow__node[data-id="${duplicateChannelsId}"] .type-value`;
		const readout = await rectOf(page, readoutSelector);

		if (!readout) throw new Error("Duplicate Channels numeric readout not found");

		await page.mouse.click(readout.x, readout.y, { count: 2 });

		const editorSelector = `.react-flow__node[data-id="${duplicateChannelsId}"] input[type="number"][step="1"]`;

		await page.waitForSelector(editorSelector, { timeout: 5000 });
		await page.focus(editorSelector);
		await page.keyboard.down("Control");
		await page.keyboard.press("A");
		await page.keyboard.up("Control");
		await page.keyboard.type("4");
		await page.keyboard.press("Enter");
		await sleep(DEBOUNCE_WAIT_MS);

		const integerBag = readPersistedBag();
		const duplicateChannels = integerBag.nodes.find((node) => node.nodeName === DUPLICATE_CHANNELS_NODE);
		const channels = duplicateChannels?.parameters?.channels;

		check(
			channels === 4 && Number.isInteger(channels),
			`integer parameter — Duplicate Channels persists numeric channels=4 (${String(channels)})`,
		);

		const deletedDuplicateChannels = await deleteNodeViaMenu(page, duplicateChannelsId);

		check(deletedDuplicateChannels, "integer parameter — Duplicate Channels removed after persistence assertion");
		check(await waitForNodeCount(page, 1, 5000), "integer parameter — mutation graph returns to 1 node");

		// Value-level undo/redo (the opshot-migration regression net): rename,
		// parameter, and bypass edits asserted against the rendered DOM and the
		// persisted bag through undo/redo; insert-on-edge as a real mutation; a
		// mixed-sequence exact restore; and — strictly last — the external
		// file:changed reconcile, after which nothing may assert undo behavior.
		log("--- value-level undo/redo ---");

		// Setup: Read WAV (path PATH_SENTINEL, bypass on) is in scope as sourceId.
		// Both addNode placements land at screen centre, and coincident handles
		// defeat connectHandles and the edge-chip hover, so the new Gain is dragged
		// clear — an unhistoried position write that cannot pollute undo counts.
		const readNodeId = sourceId;
		const gainNodeId = await addNode(page, TRANSFORM_NODE, 2, { search: "gain" });

		await zoomOut(page, 4);
		await dragNodeBy(page, gainNodeId, 320, 140);

		const valueSourceHandle = await rectOf(page, `.react-flow__node[data-id="${readNodeId}"] .react-flow__handle-right`);
		const valueTargetHandle = await rectOf(page, `.react-flow__node[data-id="${gainNodeId}"] .react-flow__handle-left`);

		if (!valueSourceHandle || !valueTargetHandle) throw new Error("Could not locate value-level connection handles");

		await connectHandles(page, valueSourceHandle, valueTargetHandle);
		await waitForEdgeAgreement(page, 1, 8000);
		check(true, "value setup — Read WAV → Gain connected (edges = 1, persisted and rendered)");

		// Rename: the tab-name commit routes through the historied rename command.
		await renameGraph(page, "Renamed Smoke");
		check(readPersistedBag().name === "Renamed Smoke", 'rename — persisted bag name becomes "Renamed Smoke"');

		await defocus(page);
		await undo(page);
		await sleep(DEBOUNCE_WAIT_MS);
		check(readPersistedBag().name === BAG_NAME, `rename undo — persisted bag name reverts to "${BAG_NAME}"`);

		await redo(page);
		await sleep(DEBOUNCE_WAIT_MS);
		check(readPersistedBag().name === "Renamed Smoke", 'rename redo — persisted bag name returns to "Renamed Smoke"');

		// Parameter: the file-path edit undoes to the previous sentinel and redoes
		// back, in the input and the persisted node parameter alike.
		await setNodePathParam(page, readNodeId, PATH_SENTINEL_2);
		await sleep(DEBOUNCE_WAIT_MS);

		const paramSetNode = readPersistedBag().nodes.find((node) => node.id === readNodeId);

		check(
			(await paramInputValue(page, readNodeId)) === PATH_SENTINEL_2 && paramSetNode?.parameters?.path === PATH_SENTINEL_2,
			`param set — input and persisted path equal "${PATH_SENTINEL_2}"`,
		);

		await defocus(page);
		await undo(page);
		await sleep(DEBOUNCE_WAIT_MS);

		const paramUndoNode = readPersistedBag().nodes.find((node) => node.id === readNodeId);

		check(
			(await paramInputValue(page, readNodeId)) === PATH_SENTINEL && paramUndoNode?.parameters?.path === PATH_SENTINEL,
			`param undo — input and persisted path revert to "${PATH_SENTINEL}"`,
		);

		await redo(page);
		await sleep(DEBOUNCE_WAIT_MS);

		const paramRedoNode = readPersistedBag().nodes.find((node) => node.id === readNodeId);

		check(
			(await paramInputValue(page, readNodeId)) === PATH_SENTINEL_2 && paramRedoNode?.parameters?.path === PATH_SENTINEL_2,
			`param redo — input and persisted path return to "${PATH_SENTINEL_2}"`,
		);

		// Bypass: toggled on the Gain node only — the Read WAV is already bypassed
		// from the earlier scenario and must stay untouched. The bypass control is a
		// plain body button; a coordinate click reaches it for the centred source node
		// but not for this zoomed-out, dragged one, so it fires via a synthetic click
		// (the harness's node-body-button convention — see synthClickInNode).
		const gainHasBypass = await synthClickInNode(page, gainNodeId, 'button[aria-label="Bypass"]');

		if (!gainHasBypass) throw new Error("Gain bypass button not found");

		await sleep(300);
		check(await isNodeBypassed(page, gainNodeId), "bypass — Gain node shows opacity-60");

		await defocus(page);
		await undo(page);
		await sleep(300);
		check(!(await isNodeBypassed(page, gainNodeId)), "bypass undo — opacity-60 absent on Gain");

		await redo(page);
		await sleep(300);
		check(await isNodeBypassed(page, gainNodeId), "bypass redo — opacity-60 present on Gain");

		await undo(page);
		await sleep(300);
		check(!(await isNodeBypassed(page, gainNodeId)), "bypass — final undo leaves Gain unbypassed");

		// Insert-on-edge as a real mutation: complete the chip flow with a
		// Duplicate Channels pick, then undo/redo the split (one history entry).
		const insertSourceHandle = await rectOf(page, `.react-flow__node[data-id="${readNodeId}"] .react-flow__handle-right`);
		const insertTargetHandle = await rectOf(page, `.react-flow__node[data-id="${gainNodeId}"] .react-flow__handle-left`);

		if (!insertSourceHandle || !insertTargetHandle) throw new Error("Could not locate insert-on-edge handles");

		const insertChipMid = {
			x: (insertSourceHandle.x + insertTargetHandle.x) / 2,
			y: (insertSourceHandle.y + insertTargetHandle.y) / 2,
		};
		let insertChipShown = false;

		for (const dy of [0, -8, 8, -16, 16]) {
			await page.mouse.move(insertChipMid.x, insertChipMid.y + dy);
			await sleep(200);

			if ((await page.$("[data-edge-insert]")) !== null) {
				insertChipShown = true;
				break;
			}
		}

		check(insertChipShown, "insert-on-edge — hovering the edge reveals the insert chip");

		const insertChipButton = await page.$('[data-edge-insert] button[aria-label="Insert node"]');
		const insertChipBox = insertChipButton ? await insertChipButton.boundingBox() : null;

		if (!insertChipBox) throw new Error("Insert chip button not found for the insert-on-edge mutation");

		await page.mouse.click(insertChipBox.x + insertChipBox.width / 2, insertChipBox.y + insertChipBox.height / 2);
		await page.waitForSelector("[data-catalog-input]", { timeout: 5000 });
		await sleep(150);
		await page.keyboard.type("duplicate", { delay: 20 });
		await sleep(250);

		const insertPicked = await clickCmdkItemByText(page, DUPLICATE_CHANNELS_NODE);

		if (!insertPicked) throw new Error("Duplicate Channels not found in the insert catalog");

		check(await waitForNodeCount(page, 3, 10000), "insert-on-edge — node count reaches 3");
		await waitForEdgeAgreement(page, 2, 8000);
		check(true, "insert-on-edge — edge splits into 2 (persisted and rendered)");

		// The inserted node is the persisted node that is neither pre-existing endpoint.
		const insertBagId = readPersistedBag().id;
		const insertedNodeId = readPersistedBag().nodes.map((node) => node.id).find((id) => id !== undefined && id !== readNodeId && id !== gainNodeId) ?? null;

		check(insertedNodeId !== null, "insert-on-edge — inserted node id identified in the persisted bag");

		await defocus(page);
		await undo(page);
		check(await waitForNodeCount(page, 2, 5000), "insert-on-edge undo — back to 2 nodes");
		await waitForEdgeAgreement(page, 1, 8000);
		check(true, "insert-on-edge undo — edge restored to 1 (persisted and rendered)");

		await defocus(page);
		await redo(page);
		check(await waitForNodeCount(page, 3, 5000), "insert-on-edge redo — 3 nodes again");
		await waitForEdgeAgreement(page, 2, 8000);
		check(true, "insert-on-edge redo — 2 edges again (persisted and rendered)");

		// Position-undo net (opshot migration): the inserted node's definition and
		// position halves ride one history entry, so redo restores its position entry.
		check(
			insertedNodeId !== null && (await waitForPositionEntry(insertBagId, insertedNodeId, true, 5000)),
			"insert-on-edge redo — inserted node's position entry present in graphs/{bagId}.json",
		);

		// The redo re-inserts the node and leaves focus in its parameter field, where
		// the Canvas keydown handler ignores Ctrl+Z; defocus before the undo so it lands.
		await defocus(page);
		await undo(page);
		check(await waitForNodeCount(page, 2, 5000), "insert-on-edge — final undo returns to 2 nodes");
		await waitForEdgeAgreement(page, 1, 8000);
		check(true, "insert-on-edge — final undo returns to 1 edge (persisted and rendered)");

		// The single undo dropped the definition and the position together — proof the
		// two-state mutation coalesced into one history entry.
		check(
			insertedNodeId !== null && (await waitForPositionEntry(insertBagId, insertedNodeId, false, 5000)),
			"insert-on-edge — final undo drops the inserted node's position entry (definition + position as one entry)",
		);

		// Mixed-sequence exact restore: three discrete mutations, undone and redone
		// wholesale, must deep-equal the persisted captures on both sides — the BAG
		// exact-restore property the migration's History rewrite must preserve.
		await sleep(DEBOUNCE_WAIT_MS);

		const bagA = readPersistedBag();

		await setNodePathParam(page, readNodeId, "C:/smoke/mixed-restore.wav");

		const mixedBypassed = await synthClickInNode(page, gainNodeId, 'button[aria-label="Bypass"]');

		if (!mixedBypassed) throw new Error("Gain bypass button not found for the mixed sequence");

		await sleep(300);

		const mixedDeleted = await deleteNodeViaMenu(page, gainNodeId);

		check(mixedDeleted, "mixed sequence — Gain deleted via the node menu");
		check(await waitForNodeCount(page, 1, 5000), "mixed sequence — 1 node after the three mutations");
		await sleep(DEBOUNCE_WAIT_MS);

		const bagB = readPersistedBag();

		check(
			bagB.nodes.length === 1 && bagB.edges.length === 0,
			`mixed sequence — bagB holds 1 node, 0 edges (${bagB.nodes.length}/${bagB.edges.length})`,
		);

		await defocus(page);
		await undo(page);
		await undo(page);
		await undo(page);
		await sleep(DEBOUNCE_WAIT_MS);

		const restoredBagA = readPersistedBag();
		const bagARestored = JSON.stringify(restoredBagA) === JSON.stringify(bagA);

		if (!bagARestored) {
			log(`  INFO  bagA expected: ${JSON.stringify(bagA)}`);
			log(`  INFO  bagA actual:   ${JSON.stringify(restoredBagA)}`);
		}

		check(bagARestored, "mixed undo ×3 — persisted bag deep-equals the pre-sequence capture");

		await defocus(page);
		await redo(page);
		await redo(page);
		await redo(page);
		await sleep(DEBOUNCE_WAIT_MS);

		const restoredBagB = readPersistedBag();
		const bagBRestored = JSON.stringify(restoredBagB) === JSON.stringify(bagB);

		if (!bagBRestored) {
			log(`  INFO  bagB expected: ${JSON.stringify(bagB)}`);
			log(`  INFO  bagB actual:   ${JSON.stringify(restoredBagB)}`);
		}

		check(bagBRestored, "mixed redo ×3 — persisted bag deep-equals the post-sequence capture");

		// Return to baseline: back to the bagA state, drop Gain for good, and reset
		// the Read WAV path so downstream sections see the historical baseline.
		await defocus(page);
		await undo(page);
		await undo(page);
		await undo(page);
		check(await waitForNodeCount(page, 2, 5000), "baseline — undo ×3 restores the 2-node bagA state");

		// The undo-restored Gain lost its unhistoried position (it renders at flow
		// 0,0), which can sit under the top-left overlay or off-viewport and defeat
		// the real right-click; fall back to a synthetic contextmenu anchored at a
		// visible pane point (the menu opens at the event's client coordinates).
		let baselineDeleted = await deleteNodeViaMenu(page, gainNodeId);

		if (!baselineDeleted) {
			const fallbackPane = await rectOf(page, ".react-flow__pane");
			const fallbackAnchor = fallbackPane ? { x: fallbackPane.x, y: fallbackPane.y / 2 } : { x: 600, y: 300 };
			const dispatched = await page.evaluate(
				(id: string, point: Point): boolean => {
					const node = document.querySelector(`.react-flow__node[data-id="${id}"]`);

					if (!node) return false;

					node.dispatchEvent(
						new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y }),
					);

					return true;
				},
				gainNodeId,
				fallbackAnchor,
			);

			if (dispatched) {
				await page.waitForSelector('[role="menuitem"]', { timeout: 3000 }).catch(() => undefined);
				await sleep(120);
				baselineDeleted = await clickMenuItemByText(page, "Delete Node");
			}
		}

		check(baselineDeleted, "baseline — Gain deleted via the node menu");
		check(await waitForNodeCount(page, 1, 5000), "baseline — 1 node remains");
		check(await waitForEdgeCount(page, 0, 5000), "baseline — 0 edges remain");

		await setNodePathParam(page, readNodeId, PATH_SENTINEL);
		check(
			(await paramInputValue(page, readNodeId)) === PATH_SENTINEL,
			`baseline — Read WAV path reset to "${PATH_SENTINEL}"`,
		);

		// External file:changed reconcile — LAST in this block: today's reconcile
		// leaves the undo stack in an undefined relationship to the document, so
		// nothing below asserts undo behavior.
		await sleep(DEBOUNCE_WAIT_MS);

		const externalBag = { ...readPersistedBag(), name: "External Edit" };

		writeFileSync(BAG_PATH, JSON.stringify(externalBag));

		const reconcileDeadline = Date.now() + 10000;
		let reconciled = false;

		while (Date.now() < reconcileDeadline) {
			const tabBarText = await page.evaluate((): string => {
				const bar = document.querySelector('button[aria-label="App menu"]')?.closest("div.h-12");

				return bar?.textContent ?? "";
			});

			if (tabBarText.includes("External Edit")) {
				reconciled = true;
				break;
			}

			await sleep(200);
		}

		check(reconciled, 'file:changed reconcile — active tab shows the external name "External Edit"');

		// 11: VST3 stage editor (Phase 7.3). Runs before the Settings remove-flow
		// so both seeded scan roots are still present when the picker scans.
		await runVst3Section(page, 2);

		// 12: Settings — VST3 scan roots seed, render, and remove-flow persistence.
		// The three former manager modals merged into one Settings modal (Phase 2):
		// open it from the app menu, then click the "VST3 scan roots" left-nav row.
		// The two seeded Windows roots come from Vst3/getDefaultScanRoots on first boot
		// (state.json had no vst3ScanRoots). Adding a root uses a native folder dialog
		// (undriveable over CDP), so only the remove flow is automated.
		const localAppData = process.env.LOCALAPPDATA;
		const expectedRoots = ["C:\\Program Files\\Common Files\\VST3", ...(localAppData ? [join(localAppData, "Programs", "Common", "VST3")] : [])];

		const appMenuTrigger = await rectOf(page, 'button[aria-label="App menu"]');

		if (!appMenuTrigger) throw new Error("App menu trigger not found");

		await clickPoint(page, appMenuTrigger);
		await page.waitForSelector('[role="menuitem"]', { timeout: 5000 });
		await sleep(150);

		const openedSettings = await clickMenuItemByText(page, "Settings");

		check(openedSettings, "open Settings from the app menu");

		await sleep(200);

		const openedScanRootsSection = await clickButtonByText(page, "VST3 scan roots");

		check(openedScanRootsSection, "Settings — open the VST3 scan roots section from the left nav");

		// Wait for a modal (non-graph) Remove button — a VST3 stage row also carries a
		// `Remove …` button on the canvas, so plain presence is not a modal-ready signal.
		await page.waitForFunction(
			() =>
				Array.from(document.querySelectorAll('button[aria-label^="Remove "]')).some(
					(button) => button.closest(".react-flow__node") === null,
				),
			{ timeout: 5000, polling: 200 },
		);
		await sleep(150);

		const seededRoots = await scanRootLabels(page);

		check(
			seededRoots.length === expectedRoots.length && expectedRoots.every((root) => seededRoots.includes(root)),
			`Settings renders the ${expectedRoots.length} seeded scan roots (${seededRoots.join(" | ")})`,
		);
		log(`  INFO  seeded VST3 scan roots: ${seededRoots.join(" | ")}`);

		const removedRoot = seededRoots[0];

		if (!removedRoot) throw new Error("No seeded scan roots rendered to remove");

		const removeButtons = await page.$$('button[aria-label^="Remove "]');
		let firstRemove = null;

		for (const button of removeButtons) {
			const inNode = await button.evaluate((element) => element.closest(".react-flow__node") !== null);

			if (!inNode) {
				firstRemove = button;
				break;
			}
		}

		const removeBox = firstRemove ? await firstRemove.boundingBox() : null;

		if (!removeBox) throw new Error("Remove button has no bounding box");

		await page.mouse.click(removeBox.x + removeBox.width / 2, removeBox.y + removeBox.height / 2);
		await sleep(300);

		const remainingRoots = await scanRootLabels(page);

		check(remainingRoots.length === seededRoots.length - 1, `remove root — list shrinks to ${seededRoots.length - 1}`);
		check(!remainingRoots.includes(removedRoot), "remove root — removed path no longer rendered");

		// state.json follows the removal after the autosave debounce.
		await sleep(DEBOUNCE_WAIT_MS);

		const persistedState = JSON.parse(readFileSync(join(PROFILE_DIR, "state.json"), "utf8")) as { vst3ScanRoots?: Array<string> };

		check(Array.isArray(persistedState.vst3ScanRoots), "state.json gained a vst3ScanRoots array");
		check(
			persistedState.vst3ScanRoots?.length === remainingRoots.length && !(persistedState.vst3ScanRoots ?? []).includes(removedRoot),
			`state.json vst3ScanRoots follows the removal (${(persistedState.vst3ScanRoots ?? []).join(" | ")})`,
		);

		// 12: zero uncaught page errors.
		check(pageErrors.length === 0, `zero page errors (saw ${pageErrors.length}: ${pageErrors.join("; ")})`);
	} finally {
		if (browser) {
			try {
				await browser.disconnect();
			} catch {
				// Ignore disconnect races.
			}
		}

		killProcessTree(child);
	}
}

async function undo(page: Page): Promise<void> {
	await page.keyboard.down("Control");
	await page.keyboard.press("KeyZ");
	await page.keyboard.up("Control");
	await sleep(200);
}

async function redo(page: Page): Promise<void> {
	await page.keyboard.down("Control");
	await page.keyboard.down("Shift");
	await page.keyboard.press("KeyZ");
	await page.keyboard.up("Shift");
	await page.keyboard.up("Control");
	await sleep(200);
}

function killProcessTree(child: ChildProcess): void {
	const { pid } = child;

	if (pid === undefined) return;

	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Process group already gone.
		}
	}
}

run()
	.then(() => {
		if (failures.length > 0) {
			log(`\nGUI smoke FAILED — ${failures.length} assertion(s):`);
			for (const failure of failures) log(`  - ${failure}`);
			process.exit(1);
		}

		log("\nGUI smoke PASSED — all assertions green.");
		process.exit(0);
	})
	.catch((error: unknown) => {
		log(`\nGUI smoke ERRORED — ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
