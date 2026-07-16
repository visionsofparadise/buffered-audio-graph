import { EventEmitter } from "node:events";
import type { RenderEvents, StreamContext, StreamSetupContext } from "../node/stream";

export function createTestSetupContext(overrides?: Partial<StreamSetupContext>): StreamSetupContext {
	return { executionProviders: ["cpu"], memoryLimit: 256 * 1024 * 1024, highWaterMark: 16, ...overrides };
}

export function createTestStreamContext(): { context: StreamContext; events: RenderEvents } {
	const events: RenderEvents = new EventEmitter();
	let counter = 0;

	return { events, context: { events, nextStreamId: () => counter++ } };
}
