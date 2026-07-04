#!/usr/bin/env node
// Crash-then-ready stub `vst-host` for the init-crash retry tests. For the first N spawns
// it exits with a configurable code BEFORE printing READY, then behaves like stub-binary.
// Spawn count is tracked across processes via a counter file. Flags:
//   --crash-file <path>   counter file; incremented once per spawn (required)
//   --crash-count <n>     crash on spawns 1..n (default 0 = never crash)
//   --crash-code <code>   exit code used for the crash (default 3221225477)

import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);

function readArg(name, fallback) {
	const idx = args.indexOf(name);

	if (idx === -1) return fallback;

	return args[idx + 1];
}

const crashFile = readArg("--crash-file", null);
const crashCount = Number.parseInt(readArg("--crash-count", "0"), 10);
const crashCode = Number.parseInt(readArg("--crash-code", "3221225477"), 10);

if (!crashFile) {
	process.stderr.write("crash-then-ready: missing --crash-file\n");
	process.exit(2);
}

let attempt = 0;

try {
	attempt = Number.parseInt(readFileSync(crashFile, "utf-8"), 10) || 0;
} catch {
	attempt = 0;
}

attempt += 1;
writeFileSync(crashFile, String(attempt));

if (attempt <= crashCount) {
	process.stderr.write(`crash-then-ready: simulated init crash on spawn ${String(attempt)} (code ${String(crashCode)})\n`);
	process.exit(crashCode);
}

const stagesJson = readArg("--stages-json", null);
const sampleRate = Number.parseInt(readArg("--sample-rate", "0"), 10);
const channels = Number.parseInt(readArg("--channels", "0"), 10);

if (!stagesJson) {
	process.stderr.write("crash-then-ready: missing --stages-json\n");
	process.exit(2);
}

if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
	process.stderr.write(`crash-then-ready: invalid --sample-rate ${String(sampleRate)}\n`);
	process.exit(2);
}

if (!Number.isFinite(channels) || channels <= 0) {
	process.stderr.write(`crash-then-ready: invalid --channels ${String(channels)}\n`);
	process.exit(2);
}

try {
	const parsed = JSON.parse(readFileSync(stagesJson, "utf-8"));

	if (!Array.isArray(parsed) || parsed.length === 0) {
		process.stderr.write("crash-then-ready: stages JSON must be a non-empty array\n");
		process.exit(2);
	}
} catch (error) {
	process.stderr.write(`crash-then-ready: failed to read stages JSON: ${String(error)}\n`);
	process.exit(2);
}

process.stdout.write("READY\n");

process.stdin.on("data", (chunk) => {
	process.stdout.write(chunk);
});

process.stdin.on("end", () => {
	process.stdout.end();
	process.exit(0);
});
