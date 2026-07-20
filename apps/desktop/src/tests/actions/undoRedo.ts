import type { Page } from "puppeteer-core";

import { sleep } from "../utils/page";

export async function undo(page: Page): Promise<void> {
	await page.keyboard.down("Control");
	await page.keyboard.press("KeyZ");
	await page.keyboard.up("Control");
	await sleep(200);
}

export async function redo(page: Page): Promise<void> {
	await page.keyboard.down("Control");
	await page.keyboard.down("Shift");
	await page.keyboard.press("KeyZ");
	await page.keyboard.up("Shift");
	await page.keyboard.up("Control");
	await sleep(200);
}
