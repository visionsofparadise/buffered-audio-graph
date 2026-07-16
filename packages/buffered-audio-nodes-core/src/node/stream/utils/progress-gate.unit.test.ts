import { describe, expect, it } from "vitest";
import { createProgressGate, PROGRESS_MIN_INTERVAL_MS } from "./progress-gate";

describe("createProgressGate", () => {
	it("emits on the first call", () => {
		const gate = createProgressGate(1000);

		expect(gate(0, 0)).toBe(true);
	});

	it("suppresses calls that stay in the same 1% bucket even after the interval elapses", () => {
		const gate = createProgressGate(1000);

		expect(gate(0, 0)).toBe(true);
		expect(gate(9, PROGRESS_MIN_INTERVAL_MS * 2)).toBe(false);
	});

	it("emits when a new bucket is crossed and the interval has elapsed", () => {
		const gate = createProgressGate(1000);

		expect(gate(0, 0)).toBe(true);
		expect(gate(10, PROGRESS_MIN_INTERVAL_MS)).toBe(true);
	});

	it("suppresses a new bucket within the interval, then emits once the interval passes", () => {
		const gate = createProgressGate(1000);

		expect(gate(0, 0)).toBe(true);
		expect(gate(20, PROGRESS_MIN_INTERVAL_MS - 1)).toBe(false);
		expect(gate(20, PROGRESS_MIN_INTERVAL_MS)).toBe(true);
	});

	it("gates on the interval alone when the total is unknown", () => {
		const gate = createProgressGate();

		expect(gate(0, 0)).toBe(true);
		expect(gate(1_000_000, PROGRESS_MIN_INTERVAL_MS - 1)).toBe(false);
		expect(gate(5, PROGRESS_MIN_INTERVAL_MS)).toBe(true);
	});

	it("advances bucket state only on emission", () => {
		const gate = createProgressGate(1000);

		expect(gate(0, 0)).toBe(true);
		expect(gate(50, PROGRESS_MIN_INTERVAL_MS - 1)).toBe(false);
		expect(gate(15, PROGRESS_MIN_INTERVAL_MS)).toBe(true);
	});
});
