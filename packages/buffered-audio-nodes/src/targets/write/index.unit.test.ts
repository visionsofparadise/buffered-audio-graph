import { describe, expect, it } from "vitest";
import { encodingSchema } from ".";

describe("Write encoding bitrate schema", () => {
	it.each([8, 64, 192, 320, 1024])("accepts integer bitrate %s kbps", (bitrate) => {
		expect(encodingSchema.safeParse({ format: "mp3", bitrate }).success).toBe(true);
	});

	it("accepts an omitted bitrate", () => {
		expect(encodingSchema.safeParse({ format: "aac" }).success).toBe(true);
	});

	it.each(["192k", "192", 8.5, 7, 1025])("rejects invalid bitrate %s", (bitrate) => {
		expect(encodingSchema.safeParse({ format: "mp3", bitrate }).success).toBe(false);
	});
});
