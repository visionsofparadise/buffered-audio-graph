import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { RenderEvents } from "@buffered-audio/core";
import { subscribeRenderEvents } from "./event-sink";

describe("subscribeRenderEvents", () => {
	it("prints render liveness with the source label and rounded elapsed seconds", () => {
		const events: RenderEvents = new EventEmitter();
		const output = new Array<string>();
		const createdAt = new Date(2026, 0, 2, 3, 4, 5).getTime();

		subscribeRenderEvents(events, () => "Read WAV#0", (text) => output.push(text));
		events.emit("liveness", { createdAt, elapsedMs: 30_501 });

		expect(output).toEqual(["03:04:05 [Read WAV#0] render active elapsed=31s\n"]);
	});
});
