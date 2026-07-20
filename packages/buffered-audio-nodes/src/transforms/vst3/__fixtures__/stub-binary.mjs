#!/usr/bin/env node
// Stub `vst-host` binary for tests. Contract:
//   1. Parse the canonical args (--stages-json, --sample-rate, --channels).
//   2. Print `READY\n`.
//   3. Emit diagnostic stderr fixtures.
//   4. Echo all stdin back to stdout verbatim.
//   5. Close stdout and exit cleanly when stdin closes.

import { readFileSync } from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);

function readArg(name, fallback) {
	const idx = args.indexOf(name);

	if (idx === -1) return fallback;

	return args[idx + 1];
}

const stagesJson = readArg("--stages-json", null);
const sampleRate = Number.parseInt(readArg("--sample-rate", "0"), 10);
const channels = Number.parseInt(readArg("--channels", "0"), 10);

if (!stagesJson) {
	process.stderr.write("stub-binary: missing --stages-json\n");
	process.exit(2);
}

if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
	process.stderr.write(`stub-binary: invalid --sample-rate ${String(sampleRate)}\n`);
	process.exit(2);
}

if (!Number.isFinite(channels) || channels <= 0) {
	process.stderr.write(`stub-binary: invalid --channels ${String(channels)}\n`);
	process.exit(2);
}

try {
	const parsed = JSON.parse(readFileSync(stagesJson, "utf-8"));

	if (!Array.isArray(parsed) || parsed.length === 0) {
		process.stderr.write("stub-binary: stages JSON must be a non-empty array\n");
		process.exit(2);
	}
} catch (error) {
	process.stderr.write(`stub-binary: failed to read stages JSON: ${String(error)}\n`);
	process.exit(2);
}

process.stdout.write("READY\n");
process.stderr.write("stub-binary: ordinary diagnostic\n");

await new Promise((resolve) => setTimeout(resolve, 100));

process.stdin.on("data", (chunk) => {
	process.stdout.write(chunk);
});

process.stdin.on("end", () => {
	process.stderr.write("stub-binary: incomplete final diagnostic");
	process.stdout.end();
});
