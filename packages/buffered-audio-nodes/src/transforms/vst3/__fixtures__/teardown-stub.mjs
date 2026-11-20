#!/usr/bin/env node
// Stub `vst-host` for the teardown and held-stdout tests. Every mode writes its pid to --pid-file first. Modes (--mode):
//   hold-stdio-after-ready            READY, spawn a silent grandchild that inherits stdio, then hang.
//   ignore-sigterm-after-ready        ignore SIGTERM, READY, then hang.
//   exit-3-before-ready-holding-stdio spawn a silent grandchild, write "crashed" to stderr, exit 3 after 100 ms.
//   echo-then-exit-holding-stdio      READY, read stdin to its end, wait 200 ms, echo it all, spawn a grandchild,
//                                     exit 0. --short-output drops the echo's last 4 bytes. --exit-code <n> writes
//                                     "failed" to stderr and exits n. --holder-writes makes the grandchild write
//                                     "held" to the inherited stdout every 200 ms, from 500 ms after the exit
//                                     (on Windows it needs --holder-dir <dir> for its generated holder.cmd).
// Every exit after a grandchild spawn waits at least one timer turn: on Windows a process.exit() in the same turn
// as the spawn leaves the grandchild holding nothing.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const args = process.argv.slice(2);

function readArg(name, fallback) {
	const index = args.indexOf(name);

	if (index === -1) return fallback;

	return args[index + 1];
}

const mode = readArg("--mode", "");
const pidFile = readArg("--pid-file", null);
const shortOutput = args.includes("--short-output");
const exitCode = Number.parseInt(readArg("--exit-code", "0"), 10);
const holderWrites = args.includes("--holder-writes");
const holderDir = readArg("--holder-dir", null);

if (pidFile) writeFileSync(pidFile, String(process.pid));

function spawnSilentGrandchild() {
	// A native grandchild: a Node grandchild does not keep the inherited pipes open on Windows.
	if (process.platform === "win32") spawn("cmd.exe", ["/d", "/c", "ping -n 13 127.0.0.1 >nul"], { stdio: "inherit" });
	else spawn("sleep", ["12"], { stdio: "inherit" });
}

function spawnWritingGrandchild() {
	if (process.platform !== "win32") {
		spawn("sh", ["-c", "sleep 0.5; i=0; while [ $i -lt 30 ]; do echo held; sleep 0.2; i=$((i+1)); done"], {
			stdio: "inherit",
		});

		return;
	}

	if (!holderDir) {
		process.stderr.write("teardown-stub: --holder-writes needs --holder-dir on Windows\n");
		process.exit(2);
	}

	const file = join(holderDir, "holder.cmd");
	const script =
		"setTimeout(function(){require('fs').writeFileSync(process.argv[1],String(process.pid));" +
		"setInterval(function(){console.log('held')},200)},500);setTimeout(function(){process.exit()},6500)";

	writeFileSync(
		file,
		`@start /b "" "${process.execPath}" -e "${script}" "${join(holderDir, "holder.pid")}"\r\n@exit 0\r\n`,
	);
	spawn("cmd.exe", ["/d", "/c", file], { stdio: "inherit" });
}

function hang() {
	setInterval(() => {}, 60_000);
}

if (mode === "hold-stdio-after-ready") {
	spawnSilentGrandchild();
	process.stdout.write("READY\n");
	hang();
} else if (mode === "ignore-sigterm-after-ready") {
	process.on("SIGTERM", () => {});
	process.stdout.write("READY\n");
	hang();
} else if (mode === "exit-3-before-ready-holding-stdio") {
	spawnSilentGrandchild();
	process.stderr.write("crashed\n");
	setTimeout(() => process.exit(3), 100);
} else if (mode === "echo-then-exit-holding-stdio") {
	process.stdout.write("READY\n");

	const chunks = [];

	process.stdin.on("data", (chunk) => chunks.push(chunk));
	process.stdin.on("end", () => {
		setTimeout(() => {
			const echo = Buffer.concat(chunks);

			process.stdout.write(shortOutput ? echo.subarray(0, Math.max(0, echo.length - 4)) : echo, () => {
				if (holderWrites) spawnWritingGrandchild();
				else spawnSilentGrandchild();

				const exit = () => setTimeout(() => process.exit(exitCode), 50);

				if (exitCode !== 0) process.stderr.write("failed\n", exit);
				else exit();
			});
		}, 200);
	});
} else {
	process.stderr.write(`teardown-stub: unknown --mode ${String(mode)}\n`);
	process.exit(2);
}
