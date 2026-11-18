import { describe, expect, it } from "vitest";
import { encodePcm, PcmStreamDecoder, type PcmFormat } from "./pcm";

const left = Float32Array.from([0.5, -0.25, 0.125]);
const right = Float32Array.from([-1, 0.75, 0]);

describe.each<PcmFormat>(["f32le", "f64le"])("%s", (format) => {
	const bytes = encodePcm([left, right], 3, format);

	it("encodes interleaved little-endian samples", () => {
		const sampleBytes = format === "f64le" ? 8 : 4;
		const read = (index: number): number =>
			format === "f64le" ? bytes.readDoubleLE(index * sampleBytes) : bytes.readFloatLE(index * sampleBytes);

		expect(bytes.length).toBe(6 * sampleBytes);
		expect([0, 1, 2, 3, 4, 5].map(read)).toEqual([0.5, -1, -0.25, 0.75, 0.125, 0]);
	});

	it("decodes the same frames whichever byte boundary splits the stream", () => {
		for (let split = 0; split <= bytes.length; split++) {
			const decoder = new PcmStreamDecoder(2, format);
			const decoded = [decoder.push(bytes.subarray(0, split)), decoder.push(bytes.subarray(split))];
			const channels = [0, 1].map((channel) => decoded.flatMap((samples) => [...(samples?.[channel] ?? [])]));

			expect(channels).toEqual([[...left], [...right]]);
		}
	});

	it("decodes a buffer whose byte offset is not aligned to the sample size", () => {
		const unaligned = Buffer.alloc(bytes.length + 1).subarray(1);

		bytes.copy(unaligned);

		const decoded = new PcmStreamDecoder(2, format).push(unaligned);

		expect(decoded?.map((channel) => [...channel])).toEqual([[...left], [...right]]);
	});
});
