import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RenderTemporaryDirectoryOptions {
	readonly rootDirectory?: string;
	readonly processIsAbsent?: (pid: number) => boolean;
}

const defaultRootDirectory = join(tmpdir(), "buffered-audio");

function processIsAbsent(pid: number): boolean {
	try {
		process.kill(pid, 0);

		return false;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
	}
}

export async function createRenderTemporaryDirectory(options?: RenderTemporaryDirectoryOptions): Promise<string> {
	const rootDirectory = options?.rootDirectory ?? defaultRootDirectory;

	await mkdir(rootDirectory, { recursive: true });

	return mkdtemp(join(rootDirectory, `render-${process.pid}-`));
}

export async function scavengeRenderTemporaryDirectories(options?: RenderTemporaryDirectoryOptions): Promise<void> {
	const rootDirectory = options?.rootDirectory ?? defaultRootDirectory;
	let entries;

	try {
		entries = await readdir(rootDirectory, { withFileTypes: true });
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;

		throw error;
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;

		const match = /^render-(\d+)-.+$/.exec(entry.name);

		if (!match) continue;

		try {
			if (!(options?.processIsAbsent ?? processIsAbsent)(Number(match[1]))) continue;

			await rm(join(rootDirectory, entry.name), { recursive: true, force: true });
		} catch {
			continue;
		}
	}
}
