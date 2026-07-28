import { nodeHeaderPoint } from "../utils/graph";
import { dragBetween, sleep } from "../utils/page";
import type { Page } from "puppeteer-core";

export async function dragNodeBy(page: Page, nodeId: string, deltaX: number, deltaY: number): Promise<void> {
	const header = await nodeHeaderPoint(page, nodeId);

	await dragBetween(page, header, { x: header.x + deltaX, y: header.y + deltaY });
	await sleep(300);
}
