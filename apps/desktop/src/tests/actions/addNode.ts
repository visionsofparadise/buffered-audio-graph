import type { Page } from "puppeteer-core";

import { DEBOUNCE_WAIT_MS } from "../utils/constants";
import { nodeCount, nodeIdByLabel, renderedNodeSummary } from "../utils/graph";
import { clickCmdkItemByText, clickPoint, dumpCmdkItems, rectByText, sleep } from "../utils/page";

/** Open the Add-node catalog from the TopLeftOverlay trigger; resolves once the search input is present. */
async function openAddNodeCatalog(page: Page): Promise<void> {
	const trigger = await rectByText(page, "button", "Add node");

	if (!trigger) throw new Error("Add node trigger not found");

	await clickPoint(page, trigger);
	await page.waitForSelector("[data-catalog-input]", { timeout: 5000 });
	await sleep(150);
}

export interface AddNodeOptions {
	/** cmdk search query typed into the input (defaults to the node label). */
	readonly search?: string;
	/** "click" picks the matching row with the mouse; "keyboard" uses ArrowDown+Enter (the cmdk-in-Radix focus check). */
	readonly method?: "click" | "keyboard";
}

export async function addNode(page: Page, nodeLabel: string, expectedCount: number, options: AddNodeOptions = {}): Promise<string> {
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
