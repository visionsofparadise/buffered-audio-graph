import type { Page } from "puppeteer-core";

import { sleep } from "../utils/page";

/**
 * Open a stage's plugin picker. The picker trigger is a Radix DropdownMenu inside
 * a React Flow node; React Flow's node pointerdown handling swallows the trigger's
 * pointer events over CDP (Phase 1 finding), so the picker is opened via keyboard
 * (focus + Enter) — Radix opens on the trigger's keydown, which React Flow ignores.
 * Returns true once the menu is present.
 */
export async function openStagePicker(page: Page, nodeId: string): Promise<boolean> {
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
export async function stageTriggerText(page: Page, nodeId: string): Promise<string> {
	return page.$eval(
		`.react-flow__node[data-id="${nodeId}"] button[aria-label="Select plugin"]`,
		(element) => element.textContent,
	);
}
