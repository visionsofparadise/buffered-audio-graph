import { sleep } from "../utils/page";
import type { Page } from "puppeteer-core";

export async function openStagePicker(page: Page, nodeId: string): Promise<boolean> {
	const triggerSelector = `.react-flow__node[data-id="${nodeId}"] button[aria-label="Select plugin"]`;

	await page.waitForSelector(triggerSelector, { timeout: 5000 });

	const handle = await page.$(triggerSelector);

	if (!handle) return false;

	const isOpen = (): Promise<boolean> => handle.evaluate((element) => element.getAttribute("data-state") === "open");

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

export async function stageTriggerText(page: Page, nodeId: string): Promise<string> {
	return page.$eval(
		`.react-flow__node[data-id="${nodeId}"] button[aria-label="Select plugin"]`,
		(element) => element.textContent,
	);
}
