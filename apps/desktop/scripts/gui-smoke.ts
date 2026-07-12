/**
 * GUI smoke — CDP-driven end-to-end verification of the graph mutation path.
 *
 * Launches the desktop app on an isolated, persistent profile
 * (`.smoke-profile/`), seeds a single empty-bag tab, drives the real UI over
 * the Chrome DevTools Protocol, and asserts every graph mutation works and
 * persists. See design-testing.md (2026-07-12 GUI smoke harness entry).
 *
 * Exit 0 on all assertions passing; 1 with a printed failure summary.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const DESKTOP_DIR = process.cwd();
const REPO_ROOT = resolve(DESKTOP_DIR, "..", "..");
const PROFILE_DIR = join(DESKTOP_DIR, ".smoke-profile");
const BAG_PATH = join(DESKTOP_DIR, ".smoke-seed.bag");
const BAG_NAME = "Smoke Bag";
const PATH_SENTINEL = "C:/smoke/input.wav";

const SOURCE_NODE = "Read WAV";
const TRANSFORM_NODE = "Gain";
const VST3_NODE = "VST3";
const OTT_MATCH = "OTT";

const DEBOUNCE_WAIT_MS = 1300;

interface Point {
	readonly x: number;
	readonly y: number;
}

interface PersistedNode {
	readonly nodeName?: string;
	readonly parameters?: Record<string, unknown>;
}

interface PersistedBag {
	readonly nodes: ReadonlyArray<PersistedNode>;
	readonly edges: ReadonlyArray<unknown>;
}

interface PersistedStage {
	readonly pluginPath?: string;
	readonly pluginName?: string;
	readonly presetPath?: string;
}

/** Read the first stage of the persisted VST3 node, or null if absent. */
function readVst3FirstStage(): PersistedStage | null {
	const bag = JSON.parse(readFileSync(BAG_PATH, "utf8")) as PersistedBag;
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

function seedProfile(): string {
	mkdirSync(PROFILE_DIR, { recursive: true });

	const bagId = randomUUID();
	const bag = { id: bagId, apiVersion: 1, name: BAG_NAME, nodes: [], edges: [] };

	writeFileSync(BAG_PATH, JSON.stringify(bag, null, 2));

	const state = {
		tabs: [{ id: bagId, bagPath: BAG_PATH }],
		activeTabId: bagId,
		windowBounds: { x: 60, y: 60, width: 1600, height: 1000 },
		recentFiles: [{ id: bagId, bagPath: BAG_PATH, name: BAG_NAME, lastOpened: Date.now() }],
		binaries: {},
	};

	writeFileSync(join(PROFILE_DIR, "state.json"), JSON.stringify(state, null, 2));

	return bagId;
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

async function clickPoint(page: Page, point: Point): Promise<void> {
	await page.mouse.click(point.x, point.y);
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

/**
 * The VST3 scan-root paths currently rendered in the open Preferences modal.
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

async function addNode(page: Page, nodeLabel: string, expectedCount: number): Promise<void> {
	const trigger = await rectByText(page, "button", "Add node");

	if (!trigger) throw new Error("Add node trigger not found");

	await clickPoint(page, trigger);
	await page.waitForSelector('[role="menuitem"]', { timeout: 5000 });
	await sleep(150);

	const clicked = await clickMenuItemByText(page, nodeLabel);

	if (!clicked) {
		const catalog = await dumpMenuItems(page);

		throw new Error(`Catalog item "${nodeLabel}" not found. Catalog: ${catalog.join(" | ")}`);
	}

	const reached = await waitForNodeCount(page, expectedCount, 8000);

	check(reached, `add "${nodeLabel}" — node count reaches ${expectedCount}`);
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

	await addNode(page, VST3_NODE, expectedNodeCount);

	const vst3Id = await nodeIdByLabel(page, VST3_NODE);

	if (!vst3Id) throw new Error("Could not resolve the VST3 node id after add");

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

		// 1 + 2: add two nodes.
		await addNode(page, SOURCE_NODE, 1);
		await addNode(page, TRANSFORM_NODE, 2);

		const sourceId = await nodeIdByLabel(page, SOURCE_NODE);
		const transformId = await nodeIdByLabel(page, TRANSFORM_NODE);

		if (!sourceId || !transformId) throw new Error("Could not resolve node ids after add");

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

		await dragBetween(page, sourceHandle, targetHandle);

		check(await waitForEdgeCount(page, 1, 8000), "connect nodes — edge count reaches 1");

		// 5 + 6: structural undo x2 / redo x2 — node/edge counts follow.
		// (Placed on structural ops so the counts observably track undo/redo,
		// which they could not if undo reversed the param/bypass edits below.)
		const paneRect = await rectOf(page, ".react-flow__pane");

		if (paneRect) await clickPoint(page, { x: paneRect.x, y: paneRect.y });

		await undo(page);
		check(await waitForEdgeCount(page, 0, 5000), "undo 1 — edge removed (edges = 0)");

		await undo(page);
		check(await waitForNodeCount(page, 1, 5000), "undo 2 — transform node removed (nodes = 1)");

		await redo(page);
		check(await waitForNodeCount(page, 2, 5000), "redo 1 — transform node restored (nodes = 2)");

		await redo(page);
		check(await waitForEdgeCount(page, 1, 5000), "redo 2 — edge restored (edges = 1)");

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

		const isBypassed = await page.evaluate((id: string): boolean => {
			const node = document.querySelector(`.react-flow__node[data-id="${id}"]`);

			return node ? node.querySelector(".opacity-60") !== null : false;
		}, sourceId);

		check(isBypassed, "toggle bypass — node shows opacity-60");

		// 9: delete the transform node via its header menu.
		const deleted = await deleteNodeViaMenu(page, transformId);

		check(deleted, "delete node — opened node menu and selected Delete Node");
		check(await waitForNodeCount(page, 1, 5000), "delete node — node count returns to 1");
		check(await waitForEdgeCount(page, 0, 5000), "delete node — dependent edge removed (edges = 0)");

		// 10: after the debounce window, the persisted bag matches the UI.
		await sleep(DEBOUNCE_WAIT_MS);

		const persisted = JSON.parse(readFileSync(BAG_PATH, "utf8")) as PersistedBag;

		check(persisted.nodes.length === 1, `persisted bag has 1 node (has ${persisted.nodes.length})`);
		check(persisted.edges.length === 0, `persisted bag has 0 edges (has ${persisted.edges.length})`);

		const persistedPath = persisted.nodes[0]?.parameters?.path;

		check(
			persistedPath === PATH_SENTINEL,
			`persisted param path equals typed value ("${String(persistedPath)}")`,
		);

		// 11: VST3 stage editor (Phase 7.3). Runs before the Preferences remove-flow
		// so both seeded scan roots are still present when the picker scans.
		await runVst3Section(page, 2);

		// 12: Preferences — VST3 scan roots seed, render, and remove-flow persistence.
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

		const openedPreferences = await clickMenuItemByText(page, "Preferences");

		check(openedPreferences, "open Preferences from the app menu");

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
			`Preferences renders the ${expectedRoots.length} seeded scan roots (${seededRoots.join(" | ")})`,
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
