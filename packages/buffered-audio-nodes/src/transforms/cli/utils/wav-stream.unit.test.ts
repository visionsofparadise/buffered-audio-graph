import { describe, expect, it } from "vitest";
import { buildStreamingWavHeader, WavStreamParser } from "./wav-stream";

interface WavSpec {
	readonly magic?: "RIFF" | "RF64";
	readonly audioFormat: number;
	readonly bits: number;
	readonly channels: number;
	readonly sampleRate?: number;
	readonly dataSize?: number;
	readonly ds64DataSize?: bigint;
	readonly extensible?: boolean;
	readonly data: Buffer;
}

function chunk(id: string, body: Buffer): Buffer {
	const head = Buffer.alloc(8);

	head.write(id, 0, "latin1");
	head.writeUInt32LE(body.length, 4);

	return Buffer.concat([head, body]);
}

function wav(spec: WavSpec): Buffer {
	const sampleRate = spec.sampleRate ?? 48000;
	const blockAlign = (spec.channels * spec.bits) / 8;
	const fmt = Buffer.alloc(spec.extensible ? 40 : 16);

	fmt.writeUInt16LE(spec.extensible ? 0xfffe : spec.audioFormat, 0);
	fmt.writeUInt16LE(spec.channels, 2);
	fmt.writeUInt32LE(sampleRate, 4);
	fmt.writeUInt32LE(sampleRate * blockAlign, 8);
	fmt.writeUInt16LE(blockAlign, 12);
	fmt.writeUInt16LE(spec.bits, 14);

	if (spec.extensible) {
		fmt.writeUInt16LE(22, 16);
		fmt.writeUInt16LE(spec.bits, 18);
		fmt.writeUInt16LE(spec.audioFormat, 24);
	}

	const head = Buffer.alloc(12);

	head.write(spec.magic ?? "RIFF", 0, "latin1");
	head.writeUInt32LE(0xffffffff, 4);
	head.write("WAVE", 8, "latin1");

	const chunks: Array<Buffer> = [head];

	if (spec.ds64DataSize !== undefined) {
		const ds64 = Buffer.alloc(28);

		ds64.writeBigUInt64LE(spec.ds64DataSize, 8);
		chunks.push(chunk("ds64", ds64));
	}

	const dataHead = Buffer.alloc(8);

	dataHead.write("data", 0, "latin1");
	dataHead.writeUInt32LE(spec.dataSize ?? spec.data.length, 4);
	chunks.push(chunk("fmt ", fmt), dataHead, spec.data);

	return Buffer.concat(chunks);
}

function float32(values: Array<number>): Buffer {
	const buffer = Buffer.alloc(values.length * 4);

	values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));

	return buffer;
}

function collect(parser: WavStreamParser, pieces: Array<Buffer>): Array<Array<number>> {
	const channels: Array<Array<number>> = [];

	for (const piece of pieces) {
		const { samples } = parser.push(piece);

		samples?.forEach((channel, index) => {
			channels[index] = [...(channels[index] ?? []), ...channel];
		});
	}

	return channels;
}

describe("buildStreamingWavHeader", () => {
	it("writes a 44-byte float32 header whose RIFF and data sizes read to EOF", () => {
		const header = buildStreamingWavHeader(48000, 2);
		const expected = Buffer.alloc(44);

		expected.write("RIFF", 0);
		expected.writeUInt32LE(0xffffffff, 4);
		expected.write("WAVE", 8);
		expected.write("fmt ", 12);
		expected.writeUInt32LE(16, 16);
		expected.writeUInt16LE(3, 20);
		expected.writeUInt16LE(2, 22);
		expected.writeUInt32LE(48000, 24);
		expected.writeUInt32LE(48000 * 8, 28);
		expected.writeUInt16LE(8, 32);
		expected.writeUInt16LE(32, 34);
		expected.write("data", 36);
		expected.writeUInt32LE(0xffffffff, 40);

		expect(header).toEqual(expected);
	});
});

describe("WavStreamParser", () => {
	const stereo = wav({ audioFormat: 3, bits: 32, channels: 2, data: float32([0.5, -0.25, 0.125, -0.5, 0.75, 1]) });

	it("decodes the same frames whichever byte boundary splits the stream, returning the header once", () => {
		for (let split = 1; split < stereo.length; split++) {
			const parser = new WavStreamParser();
			const first = parser.push(stereo.subarray(0, split));
			const second = parser.push(stereo.subarray(split));
			const headers = [first.header, second.header].filter((header) => header !== undefined);
			const channels = [0, 1].map((channel) => [
				...(first.samples?.[channel] ?? []),
				...(second.samples?.[channel] ?? []),
			]);

			expect(headers).toHaveLength(1);
			expect(channels).toEqual([
				[0.5, 0.125, 0.75],
				[-0.25, -0.5, 1],
			]);
		}
	});

	// Each pair of raw values encodes 0.5 and -0.25, which every format represents exactly.
	it.each([
		{ name: "8-bit PCM", audioFormat: 1, bits: 8, raw: [192, 96] },
		{ name: "16-bit PCM", audioFormat: 1, bits: 16, raw: [0x4000, -0x2000] },
		{ name: "24-bit PCM", audioFormat: 1, bits: 24, raw: [0x400000, -0x200000] },
		{ name: "32-bit PCM", audioFormat: 1, bits: 32, raw: [0x40000000, -0x20000000] },
		{ name: "32-bit float", audioFormat: 3, bits: 32, raw: [0.5, -0.25] },
		{ name: "64-bit float", audioFormat: 3, bits: 64, raw: [0.5, -0.25] },
	])("decodes $name", ({ audioFormat, bits, raw }) => {
		const bytes = bits / 8;
		const data = Buffer.alloc(raw.length * bytes);

		raw.forEach((value, index) => {
			const offset = index * bytes;

			if (audioFormat === 3 && bits === 32) data.writeFloatLE(value, offset);
			else if (audioFormat === 3) data.writeDoubleLE(value, offset);
			else if (bits === 8) data.writeUInt8(value, offset);
			else data.writeIntLE(value, offset, bytes);
		});

		expect(collect(new WavStreamParser(), [wav({ audioFormat, bits, channels: 1, data })])).toEqual([[0.5, -0.25]]);
	});

	it("decodes WAVE_FORMAT_EXTENSIBLE float as float", () => {
		const bytes = wav({ audioFormat: 3, bits: 32, channels: 1, extensible: true, data: float32([0.5, -0.25]) });

		expect(collect(new WavStreamParser(), [bytes])).toEqual([[0.5, -0.25]]);
	});

	it("stops an RF64 stream at its ds64 data size and discards the trailing bytes", () => {
		const bytes = wav({
			magic: "RF64",
			audioFormat: 3,
			bits: 32,
			channels: 1,
			dataSize: 0xffffffff,
			ds64DataSize: 8n,
			data: float32([0.5, -0.25, 0.75]),
		});

		expect(collect(new WavStreamParser(), [bytes])).toEqual([[0.5, -0.25]]);
	});

	it("reads an RF64 stream whose ds64 data size is 0 to EOF", () => {
		const bytes = wav({
			magic: "RF64",
			audioFormat: 3,
			bits: 32,
			channels: 1,
			dataSize: 0xffffffff,
			ds64DataSize: 0n,
			data: float32([0.5, -0.25]),
		});

		expect(collect(new WavStreamParser(), [bytes, float32([0.75])])).toEqual([[0.5, -0.25, 0.75]]);
	});

	it.each([
		{ name: "0", dataSize: 0 },
		{ name: "0xFFFFFFFF", dataSize: 0xffffffff },
	])("reads a data size of $name to EOF", ({ dataSize }) => {
		const bytes = wav({ audioFormat: 3, bits: 32, channels: 1, dataSize, data: float32([0.5]) });

		expect(collect(new WavStreamParser(), [bytes, float32([-0.25, 0.75])])).toEqual([[0.5, -0.25, 0.75]]);
	});

	it("stops at an exact data size and discards the trailing bytes", () => {
		const bytes = wav({ audioFormat: 3, bits: 32, channels: 1, dataSize: 8, data: float32([0.5, -0.25, 0.75]) });

		expect(collect(new WavStreamParser(), [bytes, float32([1])])).toEqual([[0.5, -0.25]]);
	});

	it("rejects a stream that is not RIFF", () => {
		expect(() => new WavStreamParser().push(Buffer.from("Error opening input"))).toThrow(
			'Not a WAV stream (first bytes "Erro")',
		);
	});

	it("throws at the end when the header never completed", () => {
		const parser = new WavStreamParser();

		parser.push(stereo.subarray(0, 20));

		expect(() => parser.end()).toThrow("WAV stream ended before its header completed");
	});
});
