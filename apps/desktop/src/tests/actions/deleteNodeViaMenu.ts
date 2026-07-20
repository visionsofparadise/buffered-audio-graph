import type { Page } from "puppeteer-core";

import { clickMenuItemByText, dumpMenuItems, sleep } from "../utils/page";

export async function deleteNodeViaMenu(page: Page, nodeId: string): Promise<boolean> {
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

/** Right-click a node, read its context-menu vocabulary, and leave the menu open for inspection. */
export async function openNodeMenuAndDump(page: Page, nodeId: string): Promise<Array<string>> {
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
