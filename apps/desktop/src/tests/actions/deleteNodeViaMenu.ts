import { nodeHeaderPoint } from "../utils/graph";
import { clickMenuItemByText, dumpMenuItems, sleep } from "../utils/page";
import type { Page } from "puppeteer-core";

async function openNodeContextMenu(page: Page, nodeId: string): Promise<boolean> {
	const header = await nodeHeaderPoint(page, nodeId);

	await page.mouse.click(header.x, header.y, { button: "right" });

	try {
		await page.waitForSelector('[role="menuitem"]', { timeout: 3000 });
	} catch {
		return false;
	}

	await sleep(120);

	return true;
}

export async function deleteNodeViaMenu(page: Page, nodeId: string): Promise<boolean> {
	if (!(await openNodeContextMenu(page, nodeId))) return false;

	return clickMenuItemByText(page, "Delete Node");
}

export async function openNodeMenuAndDump(page: Page, nodeId: string): Promise<Array<string>> {
	if (!(await openNodeContextMenu(page, nodeId))) return [];

	return dumpMenuItems(page);
}
