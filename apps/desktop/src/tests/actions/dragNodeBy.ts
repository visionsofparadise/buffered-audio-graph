import { dragBetween, sleep } from "../utils/page";
import type { Page } from "puppeteer-core";

export async function dragNodeBy(page: Page, nodeId: string, deltaX: number, deltaY: number): Promise<void> {
	const origin = await page.$eval(`.react-flow__node[data-id="${nodeId}"]`, (element): { x: number; y: number } => {
		const rect = element.getBoundingClientRect();

		return { x: rect.x, y: rect.y };
	});

	await dragBetween(
		page,
		{ x: origin.x + 40, y: origin.y + 14 },
		{ x: origin.x + 40 + deltaX, y: origin.y + 14 + deltaY },
	);
	await sleep(300);
}
