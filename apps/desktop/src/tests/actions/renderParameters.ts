import type { Page } from "puppeteer-core";

import { sleep } from "../utils/page";

export async function isRenderParametersOpen(page: Page): Promise<boolean> {
	return page.evaluate((): boolean => document.querySelector("[data-render-params-confirm]") !== null);
}

/** collectParameters is async IPC — an immediate presence check races the gate. */
export async function waitForRenderParametersOpen(page: Page, timeoutMs = 5000): Promise<boolean> {
	try {
		await page.waitForSelector("[data-render-params-confirm]", { timeout: timeoutMs });

		return true;
	} catch {
		return false;
	}
}

export async function fillRenderParameter(page: Page, name: string, value: string): Promise<void> {
	const selector = `[data-render-param-input="${name}"]`;

	await page.waitForSelector(selector, { timeout: 5000 });

	await page.$eval(
		selector,
		(element, pathValue: string) => {
			const input = element as HTMLInputElement;
			const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");

			descriptor?.set?.call(input, pathValue);
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
		},
		value,
	);
	await sleep(100);
}

export async function confirmRenderParameters(page: Page): Promise<void> {
	const selector = "[data-render-params-confirm]";

	await page.waitForSelector(selector, { timeout: 5000 });

	const disabled = await page.$eval(selector, (element) => (element as HTMLButtonElement).disabled);

	if (disabled) throw new Error("Render parameters confirm is disabled — fields incomplete");

	await page.click(selector);
	await sleep(200);
}

export async function cancelRenderParameters(page: Page): Promise<void> {
	const selector = "[data-render-params-cancel]";

	await page.waitForSelector(selector, { timeout: 5000 });
	await page.click(selector);
	await sleep(200);
}

export async function readRenderParameter(page: Page, name: string): Promise<string | null> {
	const selector = `[data-render-param-input="${name}"]`;

	return page.$eval(selector, (element) => (element as HTMLInputElement).value).catch(() => null);
}
