import type { Page } from "puppeteer-core";

import { clickPoint, rectByText, rectOf, sleep } from "../utils/page";
import { fileSize } from "../utils/wav";

export interface RenderToastState {
	readonly present: boolean;
	readonly failed: boolean;
	readonly error: string | null;
}

/** The render toast's live state, keyed off its unique "In progress"/"Failed" footer status span. */
export async function renderToastState(page: Page): Promise<RenderToastState> {
	return page.evaluate((): RenderToastState => {
		const spans = Array.from(document.querySelectorAll("span"));
		const status = spans.find((span) => span.textContent === "In progress" || span.textContent === "Failed");

		if (!status) return { present: false, failed: false, error: null };

		const failed = status.textContent === "Failed";
		const errorSpan = spans.find(
			(span) => span.className.includes("text-error") && span.className.includes("text-body"),
		);

		return { present: true, failed, error: failed ? (errorSpan?.textContent ?? "") : null };
	});
}

/** Whether the toolbar Render button is enabled (the render gate open — every pinned pair installed and ready). */
export async function isRenderEnabled(page: Page): Promise<boolean> {
	return page.evaluate((): boolean => {
		const button = Array.from(document.querySelectorAll("button")).find((candidate) =>
			(candidate.textContent).includes("Render"),
		);

		return button instanceof HTMLButtonElement ? !button.disabled : false;
	});
}

/** Click the toolbar Render action (present as "Render" while idle, "Abort" while running). */
export async function clickRender(page: Page): Promise<void> {
	const render = await rectByText(page, "button", "Render");

	if (!render) throw new Error("Render button not found");

	await clickPoint(page, render);
}

/** Dismiss the render toast (its `×` clears a shown error or aborts a running render). */
export async function dismissRenderToast(page: Page): Promise<void> {
	const dismiss = (await rectOf(page, 'button[aria-label="Dismiss"]')) ?? (await rectOf(page, 'button[aria-label="Cancel render"]'));

	if (dismiss) await clickPoint(page, dismiss);

	await sleep(200);
}

/** Wait until a render settles with its output present and the toast gone, or the toast reports failure. */
export async function waitForRenderOutput(
	page: Page,
	outputPath: string,
	timeoutMs: number,
): Promise<{ ok: boolean; error: string | null }> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const state = await renderToastState(page);

		if (state.failed) return { ok: false, error: state.error };

		if (fileSize(outputPath) > 0 && !state.present) return { ok: true, error: null };

		await sleep(200);
	}

	return { ok: false, error: "timed out waiting for render completion" };
}

/** Wait for the render toast to report failure and return its error text, or null on timeout. */
export async function waitForRenderError(page: Page, timeoutMs: number): Promise<string | null> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const state = await renderToastState(page);

		if (state.failed) return state.error ?? "";

		await sleep(150);
	}

	return null;
}
