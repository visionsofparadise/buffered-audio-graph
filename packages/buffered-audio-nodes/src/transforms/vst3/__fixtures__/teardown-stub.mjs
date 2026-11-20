#!/usr/bin/env node
// Stub `vst-host` for the teardown and held-stdout tests. Every mode writes its pid to --pid-file first. Modes (--mode):
//   hold-stdio-after-ready            READY, spawn a silent grandchild that inherits stdio, then hang.
//   ignore-sigterm-after-ready        ignore SIGTERM, READY, then hang.
//   ignore-sigterm-before-ready       ignore SIGTERM, then hang without printing READY.
//   exit-3-before-ready-holding-stdio spawn a grandchild that inherits stdio, write "crashed" to stderr, exit 3
//                                     after 100 ms. The grandchild writes "end of crash report" to the inherited
//                                     stderr 500 ms after its start, so after that exit, and holds the pipes for 12 s.
//                                     It appends its pid and a space to <--pid-file>.grandchildren, so a test can end it.
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

function spawnReportingGrandchild() {
	const pidList = `${pidFile ?? join(process.cwd(), "teardown-stub.pid")}.grandchildren`;

	if (process.platform !== "win32") {
		// exec keeps the shell's pid for the final sleep, so the recorded pid is the process holding the pipes.
		spawn(
			"sh",
			["-c", 'printf "%s " "$$" >> "$0"; sleep 0.5; echo end of crash report >&2; exec sleep 12', pidList],
			{
				stdio: "inherit",
			},
		);

		return;
	}

	// A Node started by cmd's `start /b` holds the pipes it inherits, unlike one this stub spawns directly. Verbatim
	// arguments keep the inner quotes, which spawn would escape as \" and cmd would reject.
	const script =
		"require('fs').appendFileSync(process.argv[1],process.pid+' ');" +
		"setTimeout(function(){console.error('end of crash report')},500);setTimeout(function(){},12000)";

	spawn("cmd.exe", ["/d", "/s", "/c", `"start /b "" "${process.execPath}" -e "${script}" "${pidList}""`], {
		stdio: "inherit",
		windowsVerbatimArguments: true,
	});
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
} else if (mode === "ignore-sigterm-before-ready") {
	process.on("SIGTERM", () => {});
	hang();
} else if (mode === "ignore-sigterm-after-ready") {
	process.on("SIGTERM", () => {});
	process.stdout.write("READY\n");
	hang();
} else if (mode === "exit-3-before-ready-holding-stdio") {
	spawnReportingGrandchild();
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
