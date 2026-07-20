import type { Page } from "puppeteer-core";

import { sleep } from "./page";
import { readPersistedBag } from "./profile";

export async function nodeCount(page: Page): Promise<number> {
	return page.$$eval(".react-flow__node", (elements) => elements.length);
}

export async function edgeCount(page: Page): Promise<number> {
	return page.$$eval(".react-flow__edge", (elements) => elements.length);
}

export async function nodeIdByLabel(page: Page, label: string): Promise<string | null> {
	return page.evaluate((lbl: string): string | null => {
		const nodes = Array.from(document.querySelectorAll(".react-flow__node"));

		for (const node of nodes) {
			if ((node.textContent).includes(lbl)) return node.getAttribute("data-id");
		}

		return null;
	}, label);
}

export interface RenderedNodeSummary {
	readonly count: number;
	readonly texts: ReadonlyArray<string>;
}

export async function renderedNodeSummary(page: Page): Promise<RenderedNodeSummary> {
	return page.$$eval(".react-flow__node", (elements): RenderedNodeSummary => ({
		count: elements.length,
		texts: elements.slice(0, 8).map((element) => (element.textContent).replace(/\s+/g, " ").trim().slice(0, 120)),
	}));
}

export async function waitForNodeCount(page: Page, expected: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if ((await nodeCount(page)) === expected) return true;

		await sleep(150);
	}

	return false;
}

export async function waitForEdgeCount(page: Page, expected: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		if ((await edgeCount(page)) === expected) return true;

		await sleep(150);
	}

	return false;
}

export async function waitForEdgeAgreement(page: Page, expected: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let persisted: number | null = null;
	let rendered: number | null = null;
	let persistedError: string | null = null;

	while (Date.now() < deadline) {
		try {
			persisted = readPersistedBag().edges.length;
			persistedError = null;
		} catch (error: unknown) {
			persisted = null;
			persistedError = error instanceof Error ? error.message : String(error);
		}

		rendered = await edgeCount(page);

		if (persisted === expected && rendered === expected) return;

		await sleep(150);
	}

	throw new Error(
		`Edge agreement timed out: expected=${expected}, persisted=${String(persisted)}, rendered=${String(rendered)}, persistedError=${persistedError ?? "none"}`,
	);
}

/** The current value of a node's first text input (its file-path param), or null when absent. */
export async function paramInputValue(page: Page, nodeId: string): Promise<string | null> {
	return page
		.$eval(`.react-flow__node[data-id="${nodeId}"] input[type="text"]`, (element) => (element).value)
		.catch(() => null);
}

/** Whether a node renders bypassed (its body carries `.opacity-60`). */
export async function isNodeBypassed(page: Page, nodeId: string): Promise<boolean> {
	return page.evaluate((id: string): boolean => {
		const node = document.querySelector(`.react-flow__node[data-id="${id}"]`);

		return node ? node.querySelector(".opacity-60") !== null : false;
	}, nodeId);
}
