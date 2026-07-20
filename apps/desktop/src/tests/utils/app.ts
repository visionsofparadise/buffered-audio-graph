import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import http from "node:http";
import { createServer } from "node:net";

import type { Browser, Page } from "puppeteer-core";

import { PROFILE_DIR, REPO_ROOT } from "./constants";
import { sleep } from "./page";

export const pageErrors: Array<string> = [];
const collectorAttached = new WeakSet<Page>();

export function log(message: string): void {
	process.stdout.write(`${message}\n`);
}

/**
 * Attach the console/pageerror collectors to a page, deduped. Registered against
 * every page target as early as it is created (before any interaction) so a
 * load-time renderer crash ahead of page acquisition is still caught — Phase 1
 * review note.
 */
export function attachCollectors(page: Page): void {
	if (collectorAttached.has(page)) return;

	collectorAttached.add(page);

	page.on("pageerror", (error: unknown) => {
		pageErrors.push(error instanceof Error ? error.message : String(error));
	});
	page.on("console", (message) => {
		if (message.type() === "error") log(`  [console.error] ${message.text()}`);
	});
}

export function getFreePort(): Promise<number> {
	return new Promise((resolvePort, rejectPort) => {
		const server = createServer();

		server.on("error", rejectPort);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();

			if (address !== null && typeof address === "object") {
				const { port } = address;

				server.close(() => resolvePort(port));
			} else {
				server.close(() => rejectPort(new Error("Could not resolve a free port")));
			}
		});
	});
}

export function httpGetStatus(url: string): Promise<number> {
	return new Promise((resolveStatus, rejectStatus) => {
		const request = http.get(url, (response) => {
			response.resume();
			resolveStatus(response.statusCode ?? 0);
		});

		request.on("error", rejectStatus);
	});
}

export async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		try {
			const status = await httpGetStatus(`http://127.0.0.1:${port}/json/version`);

			if (status === 200) return;
		} catch {
			// Endpoint not up yet.
		}

		await sleep(500);
	}

	throw new Error(`CDP endpoint on port ${port} did not come up`);
}

export async function findAppPage(browser: Browser, timeoutMs: number): Promise<Page> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const pages = await browser.pages();
		const appPage = pages.find((candidate) => /^https?:\/\/localhost:\d+/.test(candidate.url()));

		if (appPage) return appPage;

		await sleep(500);
	}

	throw new Error("Could not find the app renderer page over CDP");
}

/**
 * Launch the desktop app over Electron Forge's dev start with a remote debugging
 * port, against the isolated smoke profile. Stdout/stderr are piped to this
 * process's stderr with an `[app]` prefix. `BAG_VST3_SMOKE_CLOSE_MS` makes the
 * Vst3/launchEditor handler append --close-after-ms so an opened plugin GUI
 * auto-closes.
 */
export function launchApp(port: number): ChildProcess {
	const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
	const child: ChildProcess = spawn(
		npmCommand,
		["run", "start", "--workspace", "desktop", "--", "--", `--remote-debugging-port=${port}`],
		{
			cwd: REPO_ROOT,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, BAG_USER_DATA: PROFILE_DIR, BAG_VST3_SMOKE_CLOSE_MS: "3000" },
			windowsHide: true,
			shell: true,
		},
	);

	child.stdout?.on("data", (chunk: Buffer) => process.stderr.write(`[app] ${chunk.toString()}`));
	child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[app] ${chunk.toString()}`));

	return child;
}

export function killProcessTree(child: ChildProcess): void {
	const { pid } = child;

	if (pid === undefined) return;

	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Process group already gone.
		}
	}
}
