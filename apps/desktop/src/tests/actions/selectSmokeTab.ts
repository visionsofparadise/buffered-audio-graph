import type { Page } from "puppeteer-core";

import { nodeCount } from "../utils/graph";
import { sleep } from "../utils/page";

export async function selectSmokeTab(page: Page): Promise<void> {
	const closeButton = await page.$('button[aria-label="Close .smoke-seed"]');

	if (!closeButton) throw new Error("Persisted smoke tab was not found");

	await closeButton.evaluate((element) => {
		(element.parentElement)?.click();
	});

	const deadline = Date.now() + 10000;

	while (Date.now() < deadline) {
		if ((await nodeCount(page)) === 0 && (await page.$(".react-flow__renderer")) !== null) return;

		await sleep(100);
	}

	throw new Error("Persisted smoke tab did not load its empty graph");
}
