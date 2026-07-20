import type { Page } from "puppeteer-core";

import { nodeCount, waitForNodeCount } from "../utils/graph";
import { sleep } from "../utils/page";

/** Select each node (header click) and press Delete until the graph is empty, resolving whether it cleared. */
export async function clearGraph(page: Page): Promise<boolean> {
	for (let attempt = 0; attempt < 6; attempt++) {
		const ids = await page.$$eval(".react-flow__node", (elements) =>
			elements.map((element) => element.getAttribute("data-id")).filter((id): id is string => id !== null),
		);

		if (ids.length === 0) return true;

		for (const id of ids) {
			const origin = await page.$eval(`.react-flow__node[data-id="${id}"]`, (element): { x: number; y: number } => {
				const rect = element.getBoundingClientRect();

				return { x: rect.x, y: rect.y };
			});

			await page.mouse.click(origin.x + 40, origin.y + 8);
			await sleep(100);
			await page.keyboard.press("Delete");
			await sleep(200);
		}

		if (await waitForNodeCount(page, 0, 2000)) return true;
	}

	return (await nodeCount(page)) === 0;
}
