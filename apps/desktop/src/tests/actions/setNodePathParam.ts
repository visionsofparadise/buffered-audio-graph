import type { Page } from "puppeteer-core";

import { sleep } from "../utils/page";

/**
 * Set a node's first text param (its file-path input) via the native value setter
 * + input event, then confirm the value committed. The file input is uncontrolled
 * (`key={param.value}`, so it remounts to the committed value); a set that fails to
 * commit reverts to empty on the next remount, so this retries until the round-trip
 * sticks — hardening against a transient post-interaction remount race.
 */
export async function setNodePathParam(page: Page, nodeId: string, value: string): Promise<void> {
	const selector = `.react-flow__node[data-id="${nodeId}"] input[type="text"]`;

	await page.waitForSelector(selector, { timeout: 5000 });

	for (let attempt = 0; attempt < 6; attempt++) {
		await page.$eval(
			selector,
			(element, pathValue: string) => {
				const input = element as HTMLInputElement;
				const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");

				descriptor?.set?.call(input, pathValue);
				input.dispatchEvent(new Event("input", { bubbles: true }));
				input.dispatchEvent(new Event("blur", { bubbles: true }));
			},
			value,
		);
		await sleep(300);

		const committed = await page.$eval(selector, (element) => (element as HTMLInputElement).value).catch(() => "");

		if (committed === value) return;
	}
}
