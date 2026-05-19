import { getThemeColors } from "@buffered-audio/design-system";
import type { ComputeResult } from "spectral-display";
import { WaveformCanvas, useSpectralCompute } from "spectral-display";
import { useEffect, useState } from "react";
import type { Logger } from "../../../../../shared/models/Logger";
import type { Main } from "../../../../models/Main";

const PREVIEW_HEIGHT = 48;
const PREVIEW_WIDTH = 260;

const RIFF = 0x52494646;
const WAVE = 0x57415645;
const FMT = 0x666d7420;
const DATA = 0x64617461;
const PCM_FORMAT = 1;
const IEEE_FLOAT_FORMAT = 3;

interface ParsedWav {
	readonly sampleRate: number;
	readonly channelCount: number;
	readonly totalSamples: number;
	readonly durationMs: number;
	readSamples: (channel: number, sampleOffset: number, sampleCount: number) => Promise<Float32Array>;
}

interface LoadedSnapshot {
	readonly wav: ParsedWav;
	readonly audioPath: string;
}

function findChunk(view: DataView, chunkId: number, searchStart: number): number {
	let offset = searchStart;

	while (offset + 8 <= view.byteLength) {
		const id = view.getUint32(offset, false);

		if (id === chunkId) return offset;
		const size = view.getUint32(offset + 4, true);

		offset += 8 + size;
		// Chunks are word-aligned
		if (size % 2 !== 0) offset += 1;
	}

	return -1;
}

function parseWav(bytes: Uint8Array): ParsedWav {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	if (view.getUint32(0, false) !== RIFF) throw new Error("Not a RIFF file");
	if (view.getUint32(8, false) !== WAVE) throw new Error("Not a WAVE file");

	const fmtOffset = findChunk(view, FMT, 12);

	if (fmtOffset === -1) throw new Error("Missing fmt chunk");

	const audioFormat = view.getUint16(fmtOffset + 8, true);

	if (audioFormat !== PCM_FORMAT && audioFormat !== IEEE_FLOAT_FORMAT) {
		throw new Error(`Unsupported audio format: ${audioFormat}`);
	}

	const channelCount = view.getUint16(fmtOffset + 10, true);
	const sampleRate = view.getUint32(fmtOffset + 12, true);
	const blockAlign = view.getUint16(fmtOffset + 20, true);
	const bitsPerSample = view.getUint16(fmtOffset + 22, true);

	const dataChunkOffset = findChunk(view, DATA, 12);

	if (dataChunkOffset === -1) throw new Error("Missing data chunk");

	const dataSize = view.getUint32(dataChunkOffset + 4, true);
	const dataOffset = dataChunkOffset + 8;

	const bytesPerSample = bitsPerSample / 8;
	const totalSamples = Math.floor(dataSize / (channelCount * bytesPerSample));
	const durationMs = (totalSamples / sampleRate) * 1000;

	function readSamples(channel: number, sampleOffset: number, sampleCount: number): Promise<Float32Array> {
		const output = new Float32Array(sampleCount);

		for (let si = 0; si < sampleCount; si++) {
			const frameByteOffset = dataOffset + (sampleOffset + si) * blockAlign;
			const sampleByteOffset = frameByteOffset + channel * bytesPerSample;

			if (sampleByteOffset + bytesPerSample > dataOffset + dataSize) break;

			if (audioFormat === IEEE_FLOAT_FORMAT && bitsPerSample === 32) {
				output[si] = view.getFloat32(sampleByteOffset, true);
			} else if (bitsPerSample === 16) {
				output[si] = view.getInt16(sampleByteOffset, true) / 32768;
			} else if (bitsPerSample === 24) {
				const b0 = view.getUint8(sampleByteOffset);
				const b1 = view.getUint8(sampleByteOffset + 1);
				const b2 = view.getUint8(sampleByteOffset + 2);
				let value = b0 | (b1 << 8) | (b2 << 16);

				if (value >= 0x800000) value -= 0x1000000;
				output[si] = value / 8388608;
			} else {
				throw new Error(`Unsupported bit depth: ${bitsPerSample}`);
			}
		}

		return Promise.resolve(output);
	}

	return { sampleRate, channelCount, totalSamples, durationMs, readSamples };
}

async function loadLatestSnapshot(main: Main, snapshotsDir: string): Promise<LoadedSnapshot> {
	const entries = await main.readDirectory(snapshotsDir);

	if (entries.length === 0) {
		throw new Error("No snapshots found");
	}

	const hash = entries[entries.length - 1];

	if (hash === undefined) {
		throw new Error("No snapshot hash found");
	}

	const audioPath = `${snapshotsDir}${hash}/audio.wav`;
	const fileStat = await main.stat(audioPath);
	const bytes = await main.readFileChunk(audioPath, 0, fileStat.size);

	return { wav: parseWav(bytes), audioPath };
}

interface Props {
	readonly main: Main;
	readonly logger: Logger;
	readonly userDataPath: string;
	readonly bagId: string;
	readonly nodeId: string;
}

export function SnapshotPreview({ main, logger, userDataPath, bagId, nodeId }: Props) {
	const [loaded, setLoaded] = useState<LoadedSnapshot | null>(null);
	const [hasError, setHasError] = useState(false);

	const snapshotsDir = `${userDataPath}/snapshots/${bagId}/${nodeId}/`;

	useEffect(() => {
		let stale = false;

		setLoaded(null);
		setHasError(false);

		loadLatestSnapshot(main, snapshotsDir)
			.then((result) => {
				if (!stale) setLoaded(result);
			})
			.catch(() => {
				if (!stale) setHasError(true);
			});

		return () => {
			stale = true;
		};
	}, [main, snapshotsDir]);

	if (hasError) return null;

	if (!loaded) {
		return <div className="bg-void" style={{ height: PREVIEW_HEIGHT }} />;
	}

	return (
		<SnapshotPreviewInner
			main={main}
			logger={logger}
			loaded={loaded}
		/>
	);
}

interface InnerProps {
	readonly main: Main;
	readonly logger: Logger;
	readonly loaded: LoadedSnapshot;
}

function SnapshotPreviewInner({ main, logger, loaded }: InnerProps) {
	const { wav, audioPath } = loaded;
	const themeColors = getThemeColors("lava");

	const computeResult: ComputeResult = useSpectralCompute({
		metadata: {
			sampleRate: wav.sampleRate,
			sampleCount: wav.totalSamples,
			channelCount: wav.channelCount,
		},
		query: { startMs: 0, endMs: wav.durationMs, width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT },
		readSamples: wav.readSamples,
		config: { spectrogram: false, loudness: false, truePeak: false },
	});

	const openSnapshot = async () => {
		const result = await main.openPath(audioPath);

		if (result !== "") {
			logger.error("Failed to open snapshot in OS", new Error(result), { namespace: "snapshot-preview" });
		}
	};

	return (
		<button
			type="button"
			onClick={() => void openSnapshot()}
			title="Open snapshot in default audio player"
			className="block w-full cursor-pointer overflow-hidden bg-void [&>canvas]:block [&>canvas]:h-full [&>canvas]:w-full"
			style={{ height: PREVIEW_HEIGHT }}
		>
			{computeResult.status === "ready" && (
				<WaveformCanvas
					computeResult={computeResult}
					color={themeColors.waveform}
				/>
			)}
		</button>
	);
}
