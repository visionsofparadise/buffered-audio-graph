import { sleep } from "../utils/page";
import type { Page } from "puppeteer-core";

export async function setNodePathParam(page: Page, nodeId: string, value: string): Promise<void> {
	const selector = `.react-flow__node[data-id="${nodeId}"] input[type="text"]`;

	await page.waitForSelector(selector, { timeout: 5000 });

	for (let attempt = 0; attempt < 6; attempt++) {
		await page.focus(selector);
		await page.$eval(
			selector,
			(element, pathValue: string) => {
				const input = element as HTMLInputElement;
				const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");

				descriptor?.set?.call(input, pathValue);
				input.dispatchEvent(new Event("input", { bubbles: true }));
			},
			value,
		);
		await sleep(50);
		await page.$eval(selector, (element) => {
			(element as HTMLInputElement).blur();
		});
		await sleep(300);

		const committed = await page.$eval(selector, (element) => (element as HTMLInputElement).value).catch(() => "");

		if (committed === value) return;
	}
}
