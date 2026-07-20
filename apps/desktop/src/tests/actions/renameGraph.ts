import type { Page } from "puppeteer-core";

import { DEBOUNCE_WAIT_MS } from "../utils/constants";
import { clickPoint, type Point, sleep } from "../utils/page";

/**
 * Rename the graph by driving the active tab's `TabNameInput`: click the tab
 * bar's text input (scoped to the AppBar via the App-menu trigger so node
 * parameter inputs never match), select-all, type the name, commit with Enter,
 * and wait out the save debounce.
 */
export async function renameGraph(page: Page, name: string): Promise<void> {
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
