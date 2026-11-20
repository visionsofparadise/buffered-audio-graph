import { describe, expect, it } from "vitest";
import { describeError } from "./describe-error";

describe("describeError", () => {
	it("gives a plain error's message", () => {
		expect(describeError(new Error("x"))).toBe("x");
	});

	it("gives a non-error as a string", () => {
		expect(describeError("text")).toBe("text");
	});

	it("follows an aggregate's message with each cause", () => {
		const error = new AggregateError(
			[new Error("write failed"), new Error("destroy failed")],
			"Render and cleanup failed",
		);

		expect(describeError(error)).toBe("Render and cleanup failed: write failed; destroy failed");
	});

	it("flattens nested aggregates and drops repeated causes", () => {
		const error = new AggregateError(
			[
				new AggregateError([new Error("finally failed"), new Error("destroy failed")], "Stream teardown failed"),
				new Error("destroy failed"),
			],
			"Render and cleanup failed",
		);

		expect(describeError(error)).toBe("Render and cleanup failed: finally failed; destroy failed");
	});
});
