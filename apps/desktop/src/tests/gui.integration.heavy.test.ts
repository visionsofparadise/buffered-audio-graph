/**
 * GUI integration (heavy) — CDP-driven end-to-end verification of the graph
 * mutation path. Boots the desktop app once on an isolated, persistent profile
 * (`.smoke-profile/`), seeds a restored per-node-pin bag tab, and drives the real
 * UI over the Chrome DevTools Protocol, asserting every graph mutation works and
 * persists. Per-motion pass/fail is reported through vitest. See design-testing.md
 * (2026-07-12 harness, 2026-07-18 regression net, 2026-07-19 restructure entries).
 */
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addNode } from "./actions/addNode";
import { clearGraph } from "./actions/clearGraph";
import { deleteNodeViaMenu, openNodeMenuAndDump } from "./actions/deleteNodeViaMenu";
import { dragNodeBy } from "./actions/dragNodeBy";
import { clickRender, dismissRenderToast, isRenderEnabled, waitForRenderError, waitForRenderOutput } from "./actions/render";
import { selectSmokeTab } from "./actions/selectSmokeTab";
import { setNodePathParam } from "./actions/setNodePathParam";
import { redo, undo } from "./actions/undoRedo";
import { openStagePicker, stageTriggerText } from "./actions/vst3";
import {
	attachCollectors,
	findAppPage,
	getFreePort,
	killProcessTree,
	launchApp,
	log,
	pageErrors,
	waitForCdp,
} from "./utils/app";
import {
	BAG_PATH,
	BUILTIN_PACKAGE,
	DEBOUNCE_WAIT_MS,
	DUPLICATE_CHANNELS_NODE,
	INPUT_WAV_PATH,
	OTT_MATCH,
	OUTPUT_WAV_PATH,
	PATH_SENTINEL,
	PROFILE_DIR,
	SOURCE_NODE,
	STALE_BUILTIN_VERSION,
	TRANSFORM_NODE,
	VST3_NODE,
	WRITE_NODE,
	ZERO_TARGET_MIN_VERSION,
} from "./utils/constants";
import {
	edgeCount,
	isNodeBypassed,
	renderedNodeSummary,
	waitForEdgeAgreement,
	waitForEdgeCount,
	waitForNodeCount,
} from "./utils/graph";
import {
	clickButtonByText,
	clickButtonInNodeByText,
	clickCmdkItemByText,
	clickMenuItemByText,
	clickPoint,
	connectHandles,
	defocus,
	dragBetween,
	dumpMenuItems,
	openMenuText,
	rectOf,
	scanRootLabels,
	sleep,
	synthClickInNode,
	waitForMenuItems,
	zoomOut,
} from "./utils/page";
import {
	readBuiltinVersion,
	readPersistedBag,
	readVst3FirstStage,
	seedProfile,
	waitForPositionEntry,
	waitForPresetCommit,
	waitForRefreshedBuiltInPackage,
	waitForRestoredDependency,
} from "./utils/profile";
import { versionAtLeast } from "./utils/version";

let child: ReturnType<typeof launchApp> | undefined;
let browser: Browser | undefined;
let page: Page;

beforeAll(async () => {
	const bagId = seedProfile();

	log(`Seeded profile at ${PROFILE_DIR} (bag ${bagId})`);

	const port = await getFreePort();

	log(`Using remote debugging port ${port}`);

	child = launchApp(port);

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

	page = await findAppPage(browser, 60000);

	attachCollectors(page);

	// Wait out the package install + loading screen. On success the app
	// auto-proceeds to the graph with no Continue click; the button exists only
	// on the error path.
	await page.waitForSelector(".react-flow__renderer", { timeout: 300000 });
});

afterAll(async () => {
	if (browser) {
		try {
			await browser.disconnect();
		} catch {
			// Ignore disconnect races.
		}
	}

	if (child) killProcessTree(child);
});

describe("boot and package lifecycle", () => {
	it("resets and reloads the stale built-in package", async () => {
		const refreshedPackage = await waitForRefreshedBuiltInPackage(10000);

		expect(
			refreshedPackage?.status === "ready" && refreshedPackage.version !== null && refreshedPackage.version !== STALE_BUILTIN_VERSION,
			`stale package lifecycle resets and reloads (${STALE_BUILTIN_VERSION} → ${String(refreshedPackage?.version)})`,
		).toBe(true);
	});

	it("registers the restored tab's exact pinned dependency", async () => {
		const restoredDependency = await waitForRestoredDependency(10000);

		expect(
			restoredDependency?.status === "ready" && restoredDependency.requestedSpec === `${BUILTIN_PACKAGE}@${STALE_BUILTIN_VERSION}`,
			`restored tab registers exact dependency ${BUILTIN_PACKAGE}@${STALE_BUILTIN_VERSION}`,
		).toBe(true);
	});

	it("resolves the restored node against its pinned package", async () => {
		const restoredNodes = await renderedNodeSummary(page);

		expect(
			restoredNodes.count === 1 &&
				restoredNodes.texts.some((text) => text.includes(SOURCE_NODE)) &&
				restoredNodes.texts.every((text) => !/node unavailable/i.test(text)),
			`restored ${SOURCE_NODE} resolves against its pinned package (${restoredNodes.texts.join(" | ")})`,
		).toBe(true);
	});

	it("returns to the untouched smoke graph", async () => {
		await selectSmokeTab(page);
	});

	it("auto-proceeds past loading with no Continue button", async () => {
		const sawContinueButton = await page.evaluate(() =>
			Array.from(document.querySelectorAll("button")).some((button) => (button.textContent).includes("Continue")),
		);

		expect(!sawContinueButton, "loading auto-proceeds to the graph with no Continue button (success path)").toBe(true);

		// The reduced-to-Quit menu during loading (Phase 2.2) is verified attended:
		// the warm smoke profile resolves packages too fast to catch the chromeOnly
		// menu over CDP, and the plan forbids a forced chromeOnly render.
		await page.waitForFunction(
			() => Array.from(document.querySelectorAll("button")).some((button) => (button.textContent).includes("Add node")),
			{ timeout: 30000, polling: 300 },
		);
		await sleep(500);
	});
});

describe("full-graph render", () => {
	let readId: string;
	let builtinVersion: string | null;

	beforeAll(async () => {
		await clearGraph(page);

		readId = await addNode(page, SOURCE_NODE, 1, { search: "read" });

		// Set the input path before moving the node: a drag leaves React Flow's node
		// in a state where the file input's change does not commit, so set-then-drag
		// (the commit survives the position change) rather than drag-then-set.
		await setNodePathParam(page, readId, INPUT_WAV_PATH);

		// Move Read WAV well clear of centre while it is the only node (unambiguous
		// drag), so the Write node added next lands to its right without overlap.
		await dragNodeBy(page, readId, -450, 0);

		// The built-in version resolved into the bag drives the zero-target guard.
		await sleep(DEBOUNCE_WAIT_MS);

		builtinVersion = readBuiltinVersion();

		log(`  INFO  render assertions exercise ${BUILTIN_PACKAGE}@${builtinVersion ?? "unknown"}`);
	});

	it("shows core's leaf-validation error for a zero-target graph", async (context) => {
		// Zero-target: a lone Read WAV is a leaf that is not a target. Only packages
		// bundling core ≥ 0.10.0 carry the leaf validation — guard on the capability.
		if (builtinVersion === null || !versionAtLeast(builtinVersion, ZERO_TARGET_MIN_VERSION)) {
			log(
				`  SKIP  zero-target error — ${BUILTIN_PACKAGE}@${builtinVersion ?? "unknown"} predates the leaf validation (needs ≥ ${ZERO_TARGET_MIN_VERSION}); asserted once the 0.21.0 built-in publishes.`,
			);
			context.skip();

			return;
		}

		await clickRender(page);

		const errorText = await waitForRenderError(page, 20000);

		expect(
			errorText !== null && /is not a target|end in a target/i.test(errorText),
			`zero-target — render toast shows core's leaf-validation error ("${String(errorText)}")`,
		).toBe(true);

		await dismissRenderToast(page);
	});

	it("connects Read WAV → Write and enables the render gate", async () => {
		const writeId = await addNode(page, WRITE_NODE, 2, { search: "write" });

		await setNodePathParam(page, writeId, OUTPUT_WAV_PATH);

		await zoomOut(page, 4);

		const sourceHandle = await rectOf(page, `.react-flow__node[data-id="${readId}"] .react-flow__handle-right`);
		const targetHandle = await rectOf(page, `.react-flow__node[data-id="${writeId}"] .react-flow__handle-left`);

		if (!sourceHandle || !targetHandle) throw new Error("Could not locate render-graph connection handles");

		await connectHandles(page, sourceHandle, targetHandle);

		expect(await waitForEdgeCount(page, 1, 8000), "render graph — Read WAV → Write connected (edge = 1)").toBe(true);

		// Render gate happy path: both nodes were added at the installed catalog version,
		// so every pinned pair is ready and the Render button is enabled before click.
		expect(await isRenderEnabled(page), "render gate — Render button enabled once both pinned packages are ready").toBe(true);
	});

	it("renders the graph to a non-empty output file", async () => {
		rmSync(OUTPUT_WAV_PATH, { force: true });

		await clickRender(page);

		const outcome = await waitForRenderOutput(page, OUTPUT_WAV_PATH, 60000);

		expect(outcome.ok, `render to completion — output written and toast settled (${outcome.error ?? "ok"})`).toBe(true);
		expect(statSync(OUTPUT_WAV_PATH).size > 0, "render to completion — output file exists and is non-empty").toBe(true);

		await dismissRenderToast(page);
	});
});

describe("graph editing and persistence", () => {
	let sourceId: string;
	let transformId: string;

	beforeAll(async () => {
		await clearGraph(page);
	});

	it("adds a node from the catalog by mouse", async () => {
		sourceId = await addNode(page, SOURCE_NODE, 1, { search: "read" });
	});

	it("adds a node from the catalog by keyboard", async () => {
		transformId = await addNode(page, TRANSFORM_NODE, 2, { search: "gain", method: "keyboard" });

		expect(transformId.length > 0, "catalog keyboard nav — type-to-filter then Enter adds the first match").toBe(true);
	});

	it("connects two nodes and the edge survives autosave reconciliation", async () => {
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

		const sourceHandle = await rectOf(page, `.react-flow__node[data-id="${sourceId}"] .react-flow__handle-right`);
		const targetHandle = await rectOf(page, `.react-flow__node[data-id="${transformId}"] .react-flow__handle-left`);

		if (!sourceHandle || !targetHandle) throw new Error("Could not locate connection handles");

		await connectHandles(page, sourceHandle, targetHandle);

		expect(await waitForEdgeCount(page, 1, 8000), "connect nodes — edge count reaches 1").toBe(true);
		await waitForEdgeAgreement(page, 1, 5000);
	});

	it("reveals the edge insert chip and survives opening the catalog", async () => {
		const sourceHandle = await rectOf(page, `.react-flow__node[data-id="${sourceId}"] .react-flow__handle-right`);
		const targetHandle = await rectOf(page, `.react-flow__node[data-id="${transformId}"] .react-flow__handle-left`);

		if (!sourceHandle || !targetHandle) throw new Error("Could not locate connection handles for the insert chip");

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

		expect(chipShown, "edge chip — hovering the edge reveals the insert chip").toBe(true);

		const chipButton = await page.$('[data-edge-insert] button[aria-label="Insert node"]');
		const chipBox = chipButton ? await chipButton.boundingBox() : null;

		if (!chipBox) throw new Error("edge chip — insert button had no bounding box");

		await page.mouse.click(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);

		const catalogOpened = await page
			.waitForSelector("[data-catalog-input]", { timeout: 3000 })
			.then(() => true)
			.catch(() => false);

		expect(catalogOpened, "edge chip — clicking the + chip opens the insert catalog").toBe(true);
		expect(await edgeCount(page) === 1, "edge chip — the edge survives the chip click (still 1)").toBe(true);

		await page.keyboard.press("Escape");
		await sleep(200);
	});

	it("commits a typed path parameter", async () => {
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

		const committedValue = await page.$eval(inputSelector, (element) => (element as HTMLInputElement).value);

		expect(committedValue === PATH_SENTINEL, `type param — input value persists ("${committedValue}")`).toBe(true);
	});

	it("toggles bypass on the source node", async () => {
		const bypassButton = await rectOf(page, `.react-flow__node[data-id="${sourceId}"] button[aria-label="Bypass"]`);

		if (!bypassButton) throw new Error("Bypass button not found");

		await clickPoint(page, bypassButton);
		await sleep(300);

		expect(await isNodeBypassed(page, sourceId), "toggle bypass — node shows opacity-60").toBe(true);
	});

	it("shows exactly Bypass/Reset/Delete Node plus the package label in the node menu", async () => {
		const nodeMenuItems = await openNodeMenuAndDump(page, transformId);
		const menuText = await openMenuText(page);
		const hasBypass = nodeMenuItems.some((item) => /bypass|enable/i.test(item));
		const hasReset = nodeMenuItems.some((item) => /reset/i.test(item));
		const hasDelete = nodeMenuItems.some((item) => item.includes("Delete Node"));
		const hasRenderAbort = nodeMenuItems.some((item) => /render|abort/i.test(item));

		expect(
			nodeMenuItems.length === 3 && hasBypass && hasReset && hasDelete && !hasRenderAbort,
			`node menu is exactly Bypass/Reset/Delete Node (${nodeMenuItems.join(" | ")})`,
		).toBe(true);

		const menuVersion = readBuiltinVersion();
		const expectedLabel = `${BUILTIN_PACKAGE}@${menuVersion ?? ""}`;

		expect(
			menuVersion !== null && menuText.includes(expectedLabel),
			`node menu shows the read-only version label "${expectedLabel}" (menu text: ${menuText})`,
		).toBe(true);

		await page.keyboard.press("Escape");
		await sleep(150);
	});

	it("deletes a node and cascades its dependent edge", async () => {
		const deleted = await deleteNodeViaMenu(page, transformId);

		expect(deleted, "delete node — opened node menu and selected Delete Node").toBe(true);
		expect(await waitForNodeCount(page, 1, 5000), "delete node — node count returns to 1").toBe(true);
		expect(await waitForEdgeCount(page, 0, 5000), "delete node — dependent edge removed (edges = 0)").toBe(true);
	});

	it("persists the bag to match the rendered graph", async () => {
		await sleep(DEBOUNCE_WAIT_MS);

		const persisted = readPersistedBag();

		expect(persisted.nodes.length === 1, `persisted bag has 1 node (has ${persisted.nodes.length})`).toBe(true);
		expect(persisted.edges.length === 0, `persisted bag has 0 edges (has ${persisted.edges.length})`).toBe(true);

		const persistedPath = persisted.nodes[0]?.parameters?.path;

		expect(persistedPath === PATH_SENTINEL, `persisted param path equals typed value ("${String(persistedPath)}")`).toBe(true);
	});

	it("persists an integer parameter as a number", async () => {
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

		expect(
			channels === 4 && Number.isInteger(channels),
			`integer parameter — Duplicate Channels persists numeric channels=4 (${String(channels)})`,
		).toBe(true);

		const deletedDuplicateChannels = await deleteNodeViaMenu(page, duplicateChannelsId);

		expect(deletedDuplicateChannels, "integer parameter — Duplicate Channels removed after persistence assertion").toBe(true);
		expect(await waitForNodeCount(page, 1, 5000), "integer parameter — mutation graph returns to 1 node").toBe(true);
	});
});

describe("undo/redo wiring — insert-on-edge", () => {
	let readNodeId: string;
	let gainNodeId: string;
	let insertBagId: string;
	let insertedNodeId: string | null;

	beforeAll(async () => {
		await clearGraph(page);

		readNodeId = await addNode(page, SOURCE_NODE, 1, { search: "read" });
		gainNodeId = await addNode(page, TRANSFORM_NODE, 2, { search: "gain" });

		await zoomOut(page, 4);
		await dragNodeBy(page, gainNodeId, 320, 140);

		const valueSourceHandle = await rectOf(page, `.react-flow__node[data-id="${readNodeId}"] .react-flow__handle-right`);
		const valueTargetHandle = await rectOf(page, `.react-flow__node[data-id="${gainNodeId}"] .react-flow__handle-left`);

		if (!valueSourceHandle || !valueTargetHandle) throw new Error("Could not locate value-level connection handles");

		await connectHandles(page, valueSourceHandle, valueTargetHandle);
		await waitForEdgeAgreement(page, 1, 8000);
	});

	it("splits the edge by inserting a node as one history entry", async () => {
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

		expect(insertChipShown, "insert-on-edge — hovering the edge reveals the insert chip").toBe(true);

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

		expect(await waitForNodeCount(page, 3, 10000), "insert-on-edge — node count reaches 3").toBe(true);
		await waitForEdgeAgreement(page, 2, 8000);

		// The inserted node is the persisted node that is neither pre-existing endpoint.
		insertBagId = readPersistedBag().id;
		insertedNodeId = readPersistedBag().nodes.map((node) => node.id).find((id) => id !== undefined && id !== readNodeId && id !== gainNodeId) ?? null;

		expect(insertedNodeId !== null, "insert-on-edge — inserted node id identified in the persisted bag").toBe(true);
	});

	it("undoes the insert across definition and rendered graph", async () => {
		await defocus(page);
		await undo(page);

		expect(await waitForNodeCount(page, 2, 5000), "insert-on-edge undo — back to 2 nodes").toBe(true);
		await waitForEdgeAgreement(page, 1, 8000);
	});

	it("redoes the insert and restores the position entry", async () => {
		await defocus(page);
		await redo(page);

		expect(await waitForNodeCount(page, 3, 5000), "insert-on-edge redo — 3 nodes again").toBe(true);
		await waitForEdgeAgreement(page, 2, 8000);

		// The inserted node's definition and position halves ride one history entry,
		// so redo restores its position entry in graphs/{bagId}.json.
		expect(
			insertedNodeId !== null && (await waitForPositionEntry(insertBagId, insertedNodeId, true, 5000)),
			"insert-on-edge redo — inserted node's position entry present in graphs/{bagId}.json",
		).toBe(true);
	});

	it("drops definition and position together on the final undo", async () => {
		// The redo re-inserts the node and leaves focus in its parameter field, where
		// the Canvas keydown handler ignores Ctrl+Z; defocus before the undo so it lands.
		await defocus(page);
		await undo(page);

		expect(await waitForNodeCount(page, 2, 5000), "insert-on-edge — final undo returns to 2 nodes").toBe(true);
		await waitForEdgeAgreement(page, 1, 8000);

		// The single undo dropped the definition and the position together — proof the
		// two-state mutation coalesced into one history entry.
		expect(
			insertedNodeId !== null && (await waitForPositionEntry(insertBagId, insertedNodeId, false, 5000)),
			"insert-on-edge — final undo drops the inserted node's position entry (definition + position as one entry)",
		).toBe(true);
	});
});

describe("vst3 stage editor", () => {
	let vst3Id: string;

	beforeAll(async () => {
		await clearGraph(page);
	});

	it("adds a VST3 node with a stage row", async () => {
		vst3Id = await addNode(page, VST3_NODE, 1);

		const addedStage = await clickButtonInNodeByText(page, vst3Id, "Add stage");

		expect(addedStage, "VST3 — add a stage row").toBe(true);

		await sleep(600);
	});

	it("opens the stage plugin picker", async () => {
		const opened = await openStagePicker(page, vst3Id);

		expect(opened, "VST3 — stage plugin picker opens").toBe(true);
	});

	it("picks a plugin, persists its path, and commits a preset through the editor", async (context) => {
		const entryCount = await waitForMenuItems(page, 30000);

		if (entryCount === 0) {
			await page.keyboard.press("Escape");
			log("  SKIP  VST3 scan returned zero entries — no installed plugins in the scan roots; skipping the picker/open assertions.");
			context.skip();

			return;
		}

		log(`  INFO  picker rendered ${entryCount} scan entr${entryCount === 1 ? "y" : "ies"}`);

		const pickedOtt = await clickMenuItemByText(page, OTT_MATCH);

		if (!pickedOtt) {
			const catalog = await dumpMenuItems(page);

			log(`  INFO  scan entries (first 40): ${catalog.slice(0, 40).join(" | ")}`);
			await page.keyboard.press("Escape");
		}

		expect(pickedOtt, `VST3 — pick ${OTT_MATCH} from the scan results`).toBe(true);

		await sleep(300);

		const title = await stageTriggerText(page, vst3Id);

		expect(title.includes(OTT_MATCH), `VST3 — stage title updates to the picked plugin (got "${title}")`).toBe(true);

		// The pluginPath commit persists after the debounce.
		await sleep(DEBOUNCE_WAIT_MS);

		const pickedStage = readVst3FirstStage();

		expect(
			typeof pickedStage?.pluginPath === "string" && pickedStage.pluginPath.length > 0,
			`VST3 — bag gains a pluginPath ("${String(pickedStage?.pluginPath)}")`,
		).toBe(true);

		// Open the plugin GUI; it auto-closes after ~3s (BAG_VST3_SMOKE_CLOSE_MS). The
		// button is a body IconButton, so it needs a synthetic click (React Flow swallows
		// CDP pointer events on body buttons — same as the "Add stage" click above).
		const launched = await synthClickInNode(page, vst3Id, 'button[aria-label="Open editor"]');

		expect(launched, "VST3 — click Open to launch the plugin GUI").toBe(true);
		log("  INFO  launched the plugin GUI (auto-closes in ~3s via BAG_VST3_SMOKE_CLOSE_MS)");

		// The saved event fires on close; the preset path then commits and persists.
		const presetPath = await waitForPresetCommit(20000);

		expect(presetPath !== null, `VST3 — presetPath follows the saved event and commits ("${String(presetPath)}")`).toBe(true);

		if (presetPath === null) return;

		let presetSize = 0;

		try {
			presetSize = statSync(presetPath).size;
		} catch {
			presetSize = -1;
		}

		expect(presetSize > 0, `VST3 — preset file exists and is non-empty (${presetSize} bytes)`).toBe(true);
	});
});

describe("settings — vst3 scan roots", () => {
	let seededRoots: Array<string> = [];

	it("renders the seeded scan roots", async () => {
		const localAppData = process.env.LOCALAPPDATA;
		const expectedRoots = ["C:\\Program Files\\Common Files\\VST3", ...(localAppData ? [join(localAppData, "Programs", "Common", "VST3")] : [])];

		const appMenuTrigger = await rectOf(page, 'button[aria-label="App menu"]');

		if (!appMenuTrigger) throw new Error("App menu trigger not found");

		await clickPoint(page, appMenuTrigger);
		await page.waitForSelector('[role="menuitem"]', { timeout: 5000 });
		await sleep(150);

		const openedSettings = await clickMenuItemByText(page, "Settings");

		expect(openedSettings, "open Settings from the app menu").toBe(true);

		await sleep(200);

		const openedScanRootsSection = await clickButtonByText(page, "VST3 scan roots");

		expect(openedScanRootsSection, "Settings — open the VST3 scan roots section from the left nav").toBe(true);

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

		seededRoots = await scanRootLabels(page);

		expect(
			seededRoots.length === expectedRoots.length && expectedRoots.every((root) => seededRoots.includes(root)),
			`Settings renders the ${expectedRoots.length} seeded scan roots (${seededRoots.join(" | ")})`,
		).toBe(true);
		log(`  INFO  seeded VST3 scan roots: ${seededRoots.join(" | ")}`);
	});

	it("removes a root and persists the removal", async () => {
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

		expect(remainingRoots.length === seededRoots.length - 1, `remove root — list shrinks to ${seededRoots.length - 1}`).toBe(true);
		expect(!remainingRoots.includes(removedRoot), "remove root — removed path no longer rendered").toBe(true);

		// state.json follows the removal after the autosave debounce.
		await sleep(DEBOUNCE_WAIT_MS);

		const persistedState = JSON.parse(readFileSync(join(PROFILE_DIR, "state.json"), "utf8")) as { vst3ScanRoots?: Array<string> };

		expect(Array.isArray(persistedState.vst3ScanRoots), "state.json gained a vst3ScanRoots array").toBe(true);
		expect(
			persistedState.vst3ScanRoots?.length === remainingRoots.length && !(persistedState.vst3ScanRoots ?? []).includes(removedRoot),
			`state.json vst3ScanRoots follows the removal (${(persistedState.vst3ScanRoots ?? []).join(" | ")})`,
		).toBe(true);

		// Close the Settings modal so the tab bar is readable for the reconcile section.
		await page.keyboard.press("Escape");
		await sleep(200);
	});
});

describe("external file:changed reconcile", () => {
	it("shows the externally renamed bag on the active tab", async () => {
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

		expect(reconciled, 'file:changed reconcile — active tab shows the external name "External Edit"').toBe(true);
	});
});

describe("hygiene", () => {
	it("recorded zero uncaught page errors", () => {
		expect(pageErrors, `zero page errors (saw ${pageErrors.length}: ${pageErrors.join("; ")})`).toHaveLength(0);
	});
});
