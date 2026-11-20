import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import packageJson from "../package.json";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const nodesDir = join(here, "..", "..", "buffered-audio-nodes");
const nodesVersion = "0.21.0";
const ffmpegPath = join(here, "..", "..", "..", "fixtures", "binaries", "ffmpeg");
const hasBinaryFixtures = existsSync(ffmpegPath);
const hasPgrep = spawnSync("pgrep", ["-V"]).status === 0;

let buildParent = "";
let buildDir: string;
let cliPath: string;

beforeAll(() => {
	buildParent = join(packageRoot, "node_modules", ".bag-cli-test");

	mkdirSync(buildParent, { recursive: true });

	buildDir = mkdtempSync(join(buildParent, "build-"));

	const tsupCli = createRequire(import.meta.url).resolve("tsup/dist/cli-default.js");
	const build = spawnSync(process.execPath, [tsupCli, "--out-dir", buildDir], {
		cwd: packageRoot,
		encoding: "utf-8",
	});

	if (build.status !== 0) {
		throw new Error(
			`Building the CLI under test failed (exit ${String(build.status)}): ${build.error?.message ?? ""}\n${build.stderr}`,
		);
	}

	cliPath = join(buildDir, "cli.js");

	if (!existsSync(cliPath)) {
		throw new Error(`Building the CLI under test produced no ${cliPath}`);
	}
}, 120_000);

afterAll(() => {
	if (buildParent) rmSync(buildParent, { recursive: true, force: true });
});

describe("bag --version", () => {
	it("prints the package version", () => {
		const result = spawnSync(process.execPath, [cliPath, "--version"], { encoding: "utf-8" });

		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toBe(`${packageJson.version}\n`);
	});
});

function writeWav(path: string, samples: ReadonlyArray<number>, sampleRate: number): void {
	const bytesPerSample = 2;
	const dataSize = samples.length * bytesPerSample;
	const buffer = Buffer.alloc(44 + dataSize);

	buffer.write("RIFF", 0, "ascii");
	buffer.writeUInt32LE(36 + dataSize, 4);
	buffer.write("WAVE", 8, "ascii");
	buffer.write("fmt ", 12, "ascii");
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20);
	buffer.writeUInt16LE(1, 22);
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
	buffer.writeUInt16LE(bytesPerSample, 32);
	buffer.writeUInt16LE(16, 34);
	buffer.write("data", 36, "ascii");
	buffer.writeUInt32LE(dataSize, 40);

	for (let i = 0; i < samples.length; i++) {
		buffer.writeInt16LE(samples[i] ?? 0, 44 + i * bytesPerSample);
	}

	writeFileSync(path, buffer);
}

function writeBag(path: string, packageVersion: string, inputPath: string, outputPath: string): void {
	const definition = {
		id: randomUUID(),
		name: "cli-integration",
		apiVersion: 1,
		nodes: [
			{
				id: "read",
				packageName: "@buffered-audio/nodes",
				packageVersion,
				nodeName: "Read WAV",
				parameters: { path: inputPath },
			},
			{
				id: "write",
				packageName: "@buffered-audio/nodes",
				packageVersion,
				nodeName: "Write",
				parameters: { path: outputPath, bitDepth: "16" },
			},
		],
		edges: [{ from: "read", to: "write" }],
	};

	writeFileSync(path, JSON.stringify(definition));
}

describe("bag render", () => {
	let workDir: string;

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "bag-cli-"));
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	it("renders a bag when the pinned package is provided via --resolve", () => {
		const inputPath = join(workDir, "input.wav");
		const outputPath = join(workDir, "output.wav");
		const bagPath = join(workDir, "graph.bag");

		writeWav(
			inputPath,
			Array.from({ length: 256 }, (_, i) => Math.round(Math.sin(i / 8) * 10000)),
			8000,
		);
		writeBag(bagPath, nodesVersion, inputPath, outputPath);

		const result = spawnSync(
			process.execPath,
			[cliPath, "render", bagPath, "--resolve", `@buffered-audio/nodes=${nodesDir}`],
			{ encoding: "utf-8" },
		);

		expect(result.status, result.stderr).toBe(0);
		expect(existsSync(outputPath)).toBe(true);
		expect(result.stderr).toContain("overrides pin @buffered-audio/nodes");
	});

	it("exits non-zero naming the package when --no-install meets an unsatisfiable pin", () => {
		const inputPath = join(workDir, "input2.wav");
		const outputPath = join(workDir, "output2.wav");
		const bagPath = join(workDir, "graph2.bag");

		writeWav(
			inputPath,
			Array.from({ length: 64 }, () => 0),
			8000,
		);
		writeBag(bagPath, "999.0.0", inputPath, outputPath);

		const result = spawnSync(process.execPath, [cliPath, "render", bagPath, "--no-install"], { encoding: "utf-8" });

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("@buffered-audio/nodes");
		expect(existsSync(outputPath)).toBe(false);
	});
});

const ECHO_SCRIPT =
	"let c = Promise.resolve(); process.stdin.on('data', (d) => { c = c.then(() => new Promise((r) => setTimeout(r, 200))).then(() => process.stdout.write(d)); }); process.stdin.on('end', () => c.then(() => process.stdout.end()));";

function writeSignalBag(path: string, inputPath: string, outputPath: string, marker: string): void {
	const definition = {
		id: randomUUID(),
		name: "cli-signal",
		apiVersion: 1,
		nodes: [
			{
				id: "read",
				packageName: "@buffered-audio/nodes",
				packageVersion: nodesVersion,
				nodeName: "Read WAV",
				parameters: { path: inputPath },
			},
			{
				id: "echo",
				packageName: "@buffered-audio/nodes",
				packageVersion: nodesVersion,
				nodeName: "CLI",
				parameters: { command: process.execPath, args: ["-e", ECHO_SCRIPT, marker] },
			},
			{
				id: "write",
				packageName: "@buffered-audio/nodes",
				packageVersion: nodesVersion,
				nodeName: "Write",
				parameters: { path: outputPath, ffmpegPath, encoding: { format: "flac" } },
			},
		],
		edges: [
			{ from: "read", to: "echo" },
			{ from: "echo", to: "write" },
		],
	};

	writeFileSync(path, JSON.stringify(definition));
}

function isRunning(pattern: string): boolean {
	return spawnSync("pgrep", ["-f", pattern]).status === 0;
}

function partialFiles(directory: string): Array<string> {
	return readdirSync(directory).filter((name) => name.includes(".partial-"));
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = performance.now() + timeoutMs;

	while (performance.now() < deadline) {
		if (condition()) return true;

		await delay(50);
	}

	return condition();
}

interface SignalledRender {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly elapsedMs: number;
	readonly stderr: string;
	readonly marker: string;
	readonly outputDir: string;
	readonly outputPath: string;
}

describe.skipIf(process.platform === "win32" || !hasBinaryFixtures || !hasPgrep)("bag render signals", () => {
	const directories: Array<string> = [];

	afterAll(() => {
		for (const directory of directories) rmSync(directory, { recursive: true, force: true });
	});

	async function renderAndSignal(signal: "SIGINT" | "SIGTERM", group: boolean): Promise<SignalledRender> {
		const workDir = mkdtempSync(join(tmpdir(), "bag-cli-signal-"));
		const outputDir = join(workDir, "out");
		const inputPath = join(workDir, "input.wav");
		const outputPath = join(outputDir, "out.flac");
		const bagPath = join(workDir, "graph.bag");
		const marker = randomUUID();

		directories.push(workDir);
		mkdirSync(outputDir);
		writeWav(
			inputPath,
			Array.from({ length: 60 * 8000 }, (_, i) => Math.round(Math.sin(i / 8) * 10000)),
			8000,
		);
		writeSignalBag(bagPath, inputPath, outputPath, marker);

		const child = spawn(
			process.execPath,
			[cliPath, "render", bagPath, "--resolve", `@buffered-audio/nodes=${nodesDir}`],
			{
				detached: group,
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		let stderr = "";

		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			child.once("close", (code, closeSignal) => {
				resolve({ code, signal: closeSignal });
			});
		});

		try {
			const started = await waitFor(() => isRunning(marker) && partialFiles(outputDir).length > 0, 20_000);

			if (!started) throw new Error(`The render never reached its echo child and encoder. stderr: ${stderr}`);

			const pid = child.pid;

			if (pid === undefined) throw new Error("The CLI has no pid");

			const signalledAt = performance.now();

			if (group) process.kill(-pid, signal);
			else process.kill(pid, signal);

			const exit = await Promise.race([closed, delay(10_000, undefined)]);

			if (exit === undefined) throw new Error(`The CLI did not exit within 10 s of ${signal}. stderr: ${stderr}`);

			return { ...exit, elapsedMs: performance.now() - signalledAt, stderr, marker, outputDir, outputPath };
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
	}

	function expectCleanTeardown(result: SignalledRender, code: number): void {
		expect.soft(result.code, result.stderr).toBe(code);
		expect.soft(result.elapsedMs).toBeLessThan(10_000);
		expect.soft(isRunning(result.marker)).toBe(false);
		expect.soft(isRunning(result.outputDir)).toBe(false);
		expect.soft(existsSync(result.outputPath)).toBe(false);
		expect.soft(partialFiles(result.outputDir)).toEqual([]);
	}

	it("tears down and exits 130 on SIGINT, leaving no output and no process", async () => {
		const result = await renderAndSignal("SIGINT", false);

		expectCleanTeardown(result, 130);
		expect.soft(result.stderr).toContain("Aborted by SIGINT");
		expect.soft(result.stderr).not.toMatch(/^Error:/m);
	}, 60_000);

	it("tears down and exits 143 on SIGTERM, leaving no output and no process", async () => {
		const result = await renderAndSignal("SIGTERM", false);

		expectCleanTeardown(result, 143);
		expect.soft(result.stderr).toContain("Aborted by SIGTERM");
		expect.soft(result.stderr).not.toMatch(/^Error:/m);
	}, 60_000);

	it("tears down and exits 130 when SIGINT reaches its whole process group", async () => {
		const result = await renderAndSignal("SIGINT", true);

		expectCleanTeardown(result, 130);
		expect.soft(result.stderr).toContain("Aborted by SIGINT");
	}, 60_000);
});
