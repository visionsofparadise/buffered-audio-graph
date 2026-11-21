import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

const SLOW_TEARDOWN_PACKAGE = "slow-teardown";

function writeSignalBag(
	path: string,
	inputPath: string,
	outputPath: string,
	marker: string,
	slowTeardown: boolean,
): void {
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
			...(slowTeardown
				? [{ id: "slow", packageName: SLOW_TEARDOWN_PACKAGE, packageVersion: "1.0.0", nodeName: "Slow Teardown" }]
				: []),
			{
				id: "write",
				packageName: "@buffered-audio/nodes",
				packageVersion: nodesVersion,
				nodeName: "Write",
				parameters: { path: outputPath, ffmpegPath, encoding: { format: "flac" } },
			},
		],
		edges: slowTeardown
			? [
					{ from: "read", to: "echo" },
					{ from: "echo", to: "slow" },
					{ from: "slow", to: "write" },
				]
			: [
					{ from: "read", to: "echo" },
					{ from: "echo", to: "write" },
				],
	};

	writeFileSync(path, JSON.stringify(definition));
}

/**
 * A local package with two nodes that each take 3 s to tear down. "Slow Teardown" is a Gain at 0 dB, so a render
 * aborted by a first signal is still tearing down when a second one arrives. "Slow Write" is a Write target whose
 * teardown starts after it has closed its finished output, so a successful render is still settling when its output
 * is complete. The nodes bundle their own copy of core, and a render job checks streams against its source's copy,
 * so each node extends the nodes' own class, imported by the URL the CLI's `--resolve` import uses.
 */
function writeSlowTeardownPackage(directory: string): string {
	const packageDir = join(directory, SLOW_TEARDOWN_PACKAGE);
	const nodesEntryUrl = pathToFileURL(join(nodesDir, "dist", "index.js")).href;

	mkdirSync(packageDir);
	writeFileSync(
		join(packageDir, "package.json"),
		JSON.stringify({ name: SLOW_TEARDOWN_PACKAGE, version: "1.0.0", main: "index.mjs" }),
	);
	writeFileSync(
		join(packageDir, "index.mjs"),
		[
			`import { GainNode, GainStream, WriteNode, WriteStream } from ${JSON.stringify(nodesEntryUrl)};`,
			"class SlowTeardownStream extends GainStream {",
			"\tasync _destroy() { await new Promise((resolve) => setTimeout(resolve, 3000)); }",
			"}",
			"export class SlowTeardownNode extends GainNode {",
			'\tstatic nodeName = "Slow Teardown";',
			`\tstatic packageName = ${JSON.stringify(SLOW_TEARDOWN_PACKAGE)};`,
			"\tstatic Stream = SlowTeardownStream;",
			"}",
			"class SlowWriteStream extends WriteStream {",
			"\tasync _destroy() { await super._destroy(); await new Promise((resolve) => setTimeout(resolve, 3000)); }",
			"}",
			"export class SlowWriteNode extends WriteNode {",
			'\tstatic nodeName = "Slow Write";',
			`\tstatic packageName = ${JSON.stringify(SLOW_TEARDOWN_PACKAGE)};`,
			"\tstatic Stream = SlowWriteStream;",
			"}",
			"",
		].join("\n"),
	);

	return packageDir;
}

const SLOW_PACKAGE = "slow-package";
const SLOW_PACKAGE_LOADING = "slow-package is loading";

/** A local package whose module takes 8 s to evaluate, announcing on stderr when it starts. */
function writeSlowPackage(directory: string): string {
	const packageDir = join(directory, SLOW_PACKAGE);

	mkdirSync(packageDir);
	writeFileSync(
		join(packageDir, "package.json"),
		JSON.stringify({ name: SLOW_PACKAGE, version: "1.0.0", main: "index.mjs" }),
	);
	writeFileSync(
		join(packageDir, "index.mjs"),
		[
			`process.stderr.write(${JSON.stringify(`${SLOW_PACKAGE_LOADING}\n`)});`,
			"await new Promise((resolve) => setTimeout(resolve, 8000));",
			"export const loaded = true;",
			"",
		].join("\n"),
	);

	return packageDir;
}

function isRunning(pattern: string): boolean {
	return spawnSync("pgrep", ["-f", pattern]).status === 0;
}

/** Whether the WAV at `path` holds audio under its final header, whose RIFF size counts every byte after it. */
function isFinishedWav(path: string): boolean {
	if (!existsSync(path)) return false;

	const bytes = readFileSync(path);

	return bytes.length > 80 && bytes.readUInt32LE(4) === bytes.length - 8;
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = performance.now() + timeoutMs;

	while (performance.now() < deadline) {
		if (condition()) return true;

		await delay(50);
	}

	return condition();
}

type HandledSignal = "SIGINT" | "SIGTERM";

interface CliExit {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

interface CliRun {
	readonly child: ChildProcess;
	readonly output: { stdout: string; stderr: string };
	readonly closed: Promise<CliExit>;
}

/** Spawns the CLI as the leader of its own process group, so a test can always kill everything it started. */
function spawnDetachedCli(args: ReadonlyArray<string>): CliRun {
	const child = spawn(process.execPath, [cliPath, ...args], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
	const output = { stdout: "", stderr: "" };

	child.stdout.setEncoding("utf-8");
	child.stdout.on("data", (chunk: string) => {
		output.stdout += chunk;
	});
	child.stderr.setEncoding("utf-8");
	child.stderr.on("data", (chunk: string) => {
		output.stderr += chunk;
	});

	const closed = new Promise<CliExit>((resolve) => {
		child.once("close", (code, signal) => {
			resolve({ code, signal });
		});
	});

	return { child, output, closed };
}

function killProcessGroup(child: ChildProcess): void {
	if (child.pid === undefined) return;

	try {
		process.kill(-child.pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

function isAlive(child: ChildProcess): boolean {
	return child.exitCode === null && child.signalCode === null;
}

interface SignalPlan {
	readonly signal: HandledSignal;
	/** Send the first signal to the CLI's whole process group, as a terminal's Ctrl+C does. */
	readonly group?: boolean;
	/** Send the same signal to the CLI again, this long after the first. */
	readonly repeatAfterMs?: number;
	/** Put a transform that takes 3 s to tear down between the echo child and the encoder. */
	readonly slowTeardown?: boolean;
}

interface SignalledRender extends CliExit {
	readonly elapsedMs: number;
	readonly stderr: string;
	readonly echoRunning: boolean;
	readonly encoderRunning: boolean;
	readonly outputDir: string;
	readonly outputPath: string;
}

describe.skipIf(process.platform === "win32" || !hasBinaryFixtures || !hasPgrep)("bag render signals", () => {
	const directories: Array<string> = [];

	afterAll(() => {
		for (const directory of directories) rmSync(directory, { recursive: true, force: true });
	});

	async function renderAndSignal(plan: SignalPlan): Promise<SignalledRender> {
		const workDir = mkdtempSync(join(tmpdir(), "bag-cli-signal-"));
		const outputDir = join(workDir, "out");
		const inputPath = join(workDir, "input.wav");
		const outputPath = join(outputDir, "out.flac");
		const bagPath = join(workDir, "graph.bag");
		const marker = randomUUID();
		const slowTeardown = plan.slowTeardown ?? false;

		directories.push(workDir);
		mkdirSync(outputDir);
		writeWav(
			inputPath,
			Array.from({ length: 60 * 8000 }, (_, i) => Math.round(Math.sin(i / 8) * 10000)),
			8000,
		);
		writeSignalBag(bagPath, inputPath, outputPath, marker, slowTeardown);

		const args = ["render", bagPath, "--resolve", `@buffered-audio/nodes=${nodesDir}`];

		if (slowTeardown) args.push("--resolve", `${SLOW_TEARDOWN_PACKAGE}=${writeSlowTeardownPackage(workDir)}`);

		const run = spawnDetachedCli(args);

		try {
			const started = await waitFor(() => isRunning(marker) && existsSync(outputPath), 20_000);

			if (!started)
				throw new Error(`The render never reached its echo child and encoder. stderr: ${run.output.stderr}`);

			const pid = run.child.pid;

			if (pid === undefined) throw new Error("The CLI has no pid");

			const signalledAt = performance.now();

			process.kill(plan.group ? -pid : pid, plan.signal);

			if (plan.repeatAfterMs !== undefined) {
				await delay(plan.repeatAfterMs);

				if (isAlive(run.child)) process.kill(pid, plan.signal);
			}

			const exit = await Promise.race([run.closed, delay(10_000, undefined)]);

			if (exit === undefined) {
				throw new Error(`The CLI did not exit within 10 s of ${plan.signal}. stderr: ${run.output.stderr}`);
			}

			return {
				...exit,
				elapsedMs: performance.now() - signalledAt,
				stderr: run.output.stderr,
				echoRunning: isRunning(marker),
				encoderRunning: isRunning(outputDir),
				outputDir,
				outputPath,
			};
		} finally {
			killProcessGroup(run.child);
		}
	}

	function expectCleanTeardown(result: SignalledRender, code: number): void {
		expect.soft(result.code, result.stderr).toBe(code);
		expect.soft(result.elapsedMs).toBeLessThan(10_000);
		expect.soft(result.echoRunning).toBe(false);
		expect.soft(result.encoderRunning).toBe(false);
		expect.soft(existsSync(result.outputPath)).toBe(false);
		expect.soft(readdirSync(result.outputDir)).toEqual([]);
	}

	it("tears down and exits 130 on SIGINT, leaving no output and no process", async () => {
		const result = await renderAndSignal({ signal: "SIGINT" });

		expectCleanTeardown(result, 130);
		expect.soft(result.stderr).toContain("Aborted by SIGINT");
		expect.soft(result.stderr).not.toMatch(/^Error:/m);
	}, 60_000);

	it("tears down and exits 143 on SIGTERM, leaving no output and no process", async () => {
		const result = await renderAndSignal({ signal: "SIGTERM" });

		expectCleanTeardown(result, 143);
		expect.soft(result.stderr).toContain("Aborted by SIGTERM");
		expect.soft(result.stderr).not.toMatch(/^Error:/m);
	}, 60_000);

	it("tears down and exits 130 when SIGINT reaches its whole process group", async () => {
		const result = await renderAndSignal({ signal: "SIGINT", group: true });

		expectCleanTeardown(result, 130);
		expect.soft(result.stderr).toContain("Aborted by SIGINT");
	}, 60_000);

	it("treats a second SIGINT 1 ms after the first as the same interrupt and tears down", async () => {
		const result = await renderAndSignal({ signal: "SIGINT", repeatAfterMs: 1 });

		expectCleanTeardown(result, 130);
		expect.soft(result.stderr).toContain("Aborted by SIGINT");
		expect.soft(result.stderr).not.toContain("Forced exit");
		expect.soft(result.stderr).not.toMatch(/^Error:/m);
	}, 60_000);

	it("forces the exit on a second SIGINT 1 s after the first, while teardown is still running", async () => {
		const result = await renderAndSignal({ signal: "SIGINT", repeatAfterMs: 1000, slowTeardown: true });

		expect.soft(result.code, result.stderr).toBe(130);
		expect.soft(result.elapsedMs).toBeLessThan(2000);
		expect.soft(result.stderr).toMatch(/^Forced exit by SIGINT$/m);
		expect.soft(result.stderr).not.toContain("Aborted by SIGINT");
	}, 60_000);
});

describe.skipIf(process.platform === "win32")("bag render signals during package resolution", () => {
	let workDir: string;

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "bag-cli-resolve-signal-"));
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	it("exits 130 at once on SIGINT while a package module is still loading, and never renders", async () => {
		const bagPath = join(workDir, "graph.bag");
		const packageDir = writeSlowPackage(workDir);

		writeFileSync(
			bagPath,
			JSON.stringify({
				id: randomUUID(),
				name: "cli-resolve-signal",
				apiVersion: 1,
				nodes: [{ id: "slow", packageName: SLOW_PACKAGE, packageVersion: "1.0.0", nodeName: "Slow" }],
				edges: [],
			}),
		);

		const run = spawnDetachedCli(["render", bagPath, "--resolve", `${SLOW_PACKAGE}=${packageDir}`]);

		try {
			const loading = await waitFor(() => run.output.stderr.includes(SLOW_PACKAGE_LOADING), 20_000);

			if (!loading) throw new Error(`The CLI never started loading ${SLOW_PACKAGE}. stderr: ${run.output.stderr}`);

			const pid = run.child.pid;

			if (pid === undefined) throw new Error("The CLI has no pid");

			const signalledAt = performance.now();

			process.kill(pid, "SIGINT");

			const exit = await Promise.race([run.closed, delay(15_000, undefined)]);

			if (exit === undefined)
				throw new Error(`The CLI did not exit within 15 s of SIGINT. stderr: ${run.output.stderr}`);

			expect.soft(exit.code, run.output.stderr).toBe(130);
			expect.soft(performance.now() - signalledAt).toBeLessThan(1000);
			expect.soft(run.output.stderr).toContain("Aborted by SIGINT");
			expect.soft(run.output.stdout).not.toContain("Rendering graph");
		} finally {
			killProcessGroup(run.child);
		}
	}, 60_000);
});

describe.skipIf(process.platform === "win32")("bag render signals after the render's output is complete", () => {
	let workDir: string;

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "bag-cli-late-signal-"));
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	it("exits 0 without an abort line when SIGINT arrives while a successful render tears down", async () => {
		const inputPath = join(workDir, "input.wav");
		const outputPath = join(workDir, "output.wav");
		const bagPath = join(workDir, "graph.bag");

		writeWav(
			inputPath,
			Array.from({ length: 8000 }, (_, i) => Math.round(Math.sin(i / 8) * 10000)),
			8000,
		);
		writeFileSync(
			bagPath,
			JSON.stringify({
				id: randomUUID(),
				name: "cli-late-signal",
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
						id: "write",
						packageName: SLOW_TEARDOWN_PACKAGE,
						packageVersion: "1.0.0",
						nodeName: "Slow Write",
						parameters: { path: outputPath, bitDepth: "16" },
					},
				],
				edges: [{ from: "read", to: "write" }],
			}),
		);

		const run = spawnDetachedCli([
			"render",
			bagPath,
			"--resolve",
			`@buffered-audio/nodes=${nodesDir}`,
			"--resolve",
			`${SLOW_TEARDOWN_PACKAGE}=${writeSlowTeardownPackage(workDir)}`,
		]);

		try {
			// The Slow Write target writes its final header when it closes and then tears down for 3 s, so a finished
			// output means the render has done its work and has not yet settled.
			const written = await waitFor(() => isFinishedWav(outputPath), 20_000);

			if (!written) throw new Error(`The render never wrote its output. stderr: ${run.output.stderr}`);

			await delay(200);

			const pid = run.child.pid;

			if (pid === undefined) throw new Error("The CLI has no pid");

			process.kill(pid, "SIGINT");

			const exit = await Promise.race([run.closed, delay(15_000, undefined)]);

			if (exit === undefined) throw new Error(`The CLI did not exit within 15 s. stderr: ${run.output.stderr}`);

			expect.soft(exit.code, run.output.stderr).toBe(0);
			expect.soft(run.output.stdout).toContain("Done.");
			expect.soft(run.output.stderr).not.toContain("Aborted by");
			expect.soft(existsSync(outputPath)).toBe(true);
		} finally {
			killProcessGroup(run.child);
		}
	}, 60_000);
});
