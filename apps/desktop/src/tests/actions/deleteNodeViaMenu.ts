import type { Page } from "puppeteer-core";

import { clickMenuItemByText, dumpMenuItems, sleep } from "../utils/page";

export async function deleteNodeViaMenu(page: Page, nodeId: string): Promise<boolean> {
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
