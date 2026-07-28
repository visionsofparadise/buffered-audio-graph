import type { Page } from "puppeteer-core";

export interface Point {
	readonly x: number;
	readonly y: number;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export async function rectByText(page: Page, selector: string, text: string): Promise<Point | null> {
	return page.evaluate(
		(sel: string, txt: string): Point | null => {
			const elements = Array.from(document.querySelectorAll(sel));
			const match = elements.find((element) => (element.textContent).includes(txt));

			if (!match) return null;

			const rect = match.getBoundingClientRect();

			return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
		},
		selector,
		text,
	);
}

export async function rectOf(page: Page, selector: string): Promise<Point | null> {
	const handle = await page.$(selector);

	if (!handle) return null;

	const box = await handle.boundingBox();

	return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
}

export async function clickPoint(page: Page, point: Point): Promise<void> {
	await page.mouse.click(point.x, point.y);
}

export async function zoomOut(page: Page, ticks: number): Promise<void> {
	const pane = await rectOf(page, ".react-flow__pane");

	if (!pane) return;

	await page.mouse.move(pane.x, pane.y);

	for (let tick = 0; tick < ticks; tick++) {
		await page.mouse.wheel({ deltaY: 200 });
		await sleep(80);
	}

	await sleep(200);
}

export async function dragBetween(page: Page, from: Point, to: Point): Promise<void> {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();

	const steps = 12;

	for (let step = 1; step <= steps; step++) {
		const ratio = step / steps;

		await page.mouse.move(from.x + (to.x - from.x) * ratio, from.y + (to.y - from.y) * ratio);
		await sleep(15);
	}

	await page.mouse.up();
}

export async function connectHandles(page: Page, from: Point, to: Point): Promise<void> {
	await page.mouse.move(from.x, from.y);
	await sleep(80);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await sleep(80);

	const steps = 24;

	for (let step = 1; step <= steps; step++) {
		const ratio = step / steps;

		await page.mouse.move(from.x + (to.x - from.x) * ratio, from.y + (to.y - from.y) * ratio);
		await sleep(20);
	}

	await page.mouse.move(to.x, to.y);
	await sleep(120);
	await page.mouse.move(to.x, to.y);
	await sleep(120);
	await page.mouse.up();
}

export async function defocus(page: Page): Promise<void> {
	const pane = await rectOf(page, ".react-flow__pane");

	if (!pane) return;

	await clickPoint(page, { x: pane.x / 2, y: pane.y / 2 });
	await sleep(100);
}

export async function synthClickInNode(page: Page, nodeId: string, selector: string): Promise<boolean> {
	return page.evaluate(
		(id: string, sel: string): boolean => {
			const node = document.querySelector(`.react-flow__node[data-id="${id}"]`);
			const target = node?.querySelector(sel);

			if (!(target instanceof HTMLElement)) return false;

			target.click();

			return true;
		},
		nodeId,
		selector,
	);
}

export async function clickMenuItemByText(page: Page, text: string): Promise<boolean> {
	const items = await page.$$('[role="menuitem"]');

	for (const item of items) {
		const itemText = await item.evaluate((element) => element.textContent);

		if (!itemText.includes(text)) continue;

		await item.evaluate((element) => {
			element.scrollIntoView({ block: "center" });
		});
		await sleep(60);

		const box = await item.boundingBox();

		if (box) {
			await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

			return true;
		}
	}

	return false;
}

export async function dumpMenuItems(page: Page): Promise<Array<string>> {
	return page.$$eval('[role="menuitem"]', (elements) =>
		elements.map((element) => (element.textContent).replace(/\s+/g, " ").trim().slice(0, 40)),
	);
}

export async function openMenuText(page: Page): Promise<string> {
	return page.evaluate((): string => {
		const menu = document.querySelector('[role="menu"]');

		return menu ? (menu.textContent).replace(/\s+/g, " ").trim() : "";
	});
}

export async function waitForMenuItems(page: Page, timeoutMs: number): Promise<number> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const count = await page.$$eval('[role="menuitem"]', (elements) => elements.length);

		if (count > 0) return count;

		await sleep(300);
	}

	return 0;
}

export async function dumpCmdkItems(page: Page): Promise<Array<string>> {
	return page.$$eval("[data-catalog-item]", (elements) =>
		elements.map((element) => (element.textContent).replace(/\s+/g, " ").trim().slice(0, 40)),
	);
}

export async function clickCmdkItemByText(page: Page, text: string): Promise<boolean> {
	const items = await page.$$("[data-catalog-item]");

	for (const item of items) {
		const itemText = await item.evaluate((element) => element.textContent);

		if (!itemText.includes(text)) continue;

		await item.evaluate((element) => {
			element.scrollIntoView({ block: "center" });
		});
		await sleep(60);

		const box = await item.boundingBox();

		if (box) {
			await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

			return true;
		}
	}

	return false;
}

export async function clickButtonByText(page: Page, text: string): Promise<boolean> {
	const buttons = await page.$$("button");

	for (const button of buttons) {
		const buttonText = await button.evaluate((element) => element.textContent);

		if (!buttonText.includes(text)) continue;

		await button.evaluate((element) => {
			element.scrollIntoView({ block: "center" });
		});
		await sleep(60);

		const box = await button.boundingBox();

		if (box) {
			await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

			return true;
		}
	}

	return false;
}

export async function clickButtonInNodeByText(page: Page, nodeId: string, text: string): Promise<boolean> {
	return page.evaluate(
		(id: string, needle: string): boolean => {
			const node = document.querySelector(`.react-flow__node[data-id="${id}"]`);

			if (!node) return false;

			const button = Array.from(node.querySelectorAll("button")).find((candidate) =>
				candidate.textContent.includes(needle),
			);

			if (!button) return false;

			button.click();

			return true;
		},
		nodeId,
		text,
	);
}

export async function scanRootLabels(page: Page): Promise<Array<string>> {
	return page.$$eval('button[aria-label^="Remove "]', (buttons) =>
		buttons
			.filter((button) => button.closest(".react-flow__node") === null)
			.map((button) => (button.getAttribute("aria-label") ?? "").replace(/^Remove /, "")),
	);
}
