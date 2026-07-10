import { describe, it, expect } from "vitest";
import { buildRf64Header, buildWavHeader, getBytesPerSample, writeSample } from "./wav";

describe("getBytesPerSample", () => {
	it("maps each bit depth to its byte width", () => {
		expect(getBytesPerSample("16")).toBe(2);
		expect(getBytesPerSample("24")).toBe(3);
		expect(getBytesPerSample("32")).toBe(4);
		expect(getBytesPerSample("32f")).toBe(4);
	});
});

describe("writeSample", () => {
	// Round-trip full-scale values at each integer depth; the asymmetric +/- scaling (0x7fff vs 0x8000) lives here.
	it("writes 16-bit full-scale and returns the advanced offset", () => {
		const buffer = Buffer.alloc(2);
		const next = writeSample(buffer, 0, 1, "16");

		expect(buffer.readInt16LE(0)).toBe(32767);
		expect(next).toBe(2);
	});

	it("writes 16-bit negative full-scale using the 0x8000 factor", () => {
		const buffer = Buffer.alloc(2);

		writeSample(buffer, 0, -1, "16");

		expect(buffer.readInt16LE(0)).toBe(-32768);
	});

	it("clamps out-of-range samples to [-1, 1]", () => {
		const buffer = Buffer.alloc(4);

		writeSample(buffer, 0, 2, "16");
		writeSample(buffer, 2, -2, "16");

		expect(buffer.readInt16LE(0)).toBe(32767);
		expect(buffer.readInt16LE(2)).toBe(-32768);
	});

	it("writes 24-bit little-endian and advances by 3", () => {
		const buffer = Buffer.alloc(3);
		const next = writeSample(buffer, 0, 0.5, "24");
		const raw = (buffer[0] ?? 0) | ((buffer[1] ?? 0) << 8) | ((buffer[2] ?? 0) << 16);

		expect(raw).toBe(Math.round(0.5 * 0x7fffff));
		expect(next).toBe(3);
	});

	it("writes 32-bit float verbatim", () => {
		const buffer = Buffer.alloc(4);
		const next = writeSample(buffer, 0, 0.123, "32f");

		expect(buffer.readFloatLE(0)).toBeCloseTo(0.123, 6);
		expect(next).toBe(4);
	});
});

describe("buildWavHeader", () => {
	it("lays out an 80-byte canonical WAV header with a JUNK placeholder", () => {
		const header = buildWavHeader(1000, 44100, 2, "16");

		expect(header.length).toBe(80);
		expect(header.toString("ascii", 0, 4)).toBe("RIFF");
		expect(header.readUInt32LE(4)).toBe(80 - 8 + 1000);
		expect(header.toString("ascii", 8, 12)).toBe("WAVE");
		expect(header.toString("ascii", 12, 16)).toBe("JUNK");
		// fmt chunk at offset 48.
		expect(header.toString("ascii", 48, 52)).toBe("fmt ");
		expect(header.readUInt16LE(56)).toBe(1); // audioFormat: PCM
		expect(header.readUInt16LE(58)).toBe(2); // channels
		expect(header.readUInt32LE(60)).toBe(44100); // sampleRate
		expect(header.readUInt32LE(64)).toBe(44100 * 2 * 2); // byteRate
		expect(header.readUInt16LE(68)).toBe(4); // blockAlign
		expect(header.readUInt16LE(70)).toBe(16); // bitsPerSample
		expect(header.toString("ascii", 72, 76)).toBe("data");
		expect(header.readUInt32LE(76)).toBe(1000); // dataSize
	});

	it("marks float format (audioFormat 3) for 32f", () => {
		const header = buildWavHeader(0, 48000, 1, "32f");

		expect(header.readUInt16LE(56)).toBe(3);
		expect(header.readUInt16LE(70)).toBe(32);
	});
});

describe("buildRf64Header", () => {
	// Beyond 4 GB, dataSize is carried in the ds64 chunk and the RIFF/data 32-bit sizes are UINT32_MAX sentinels.
	it("emits an RF64 header with 64-bit sizes for oversized data", () => {
		const bigDataSize = 0x1_0000_0004; // > UINT32_MAX
		const header = buildRf64Header(bigDataSize, 44100, 2, "16");

		expect(header.toString("ascii", 0, 4)).toBe("RF64");
		expect(header.readUInt32LE(4)).toBe(0xffffffff);
		expect(header.toString("ascii", 8, 12)).toBe("WAVE");
		expect(header.toString("ascii", 12, 16)).toBe("ds64");
		expect(Number(header.readBigUInt64LE(28))).toBe(bigDataSize); // 64-bit dataSize
		expect(Number(header.readBigUInt64LE(36))).toBe(Math.floor(bigDataSize / 4)); // sampleCount (blockAlign 4)
		expect(header.readUInt32LE(76)).toBe(0xffffffff); // data chunk size sentinel
	});
});
