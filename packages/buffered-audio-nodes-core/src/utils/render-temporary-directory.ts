import { chmod, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RenderTemporaryDirectoryOptions {
	readonly rootDirectory?: string;
	readonly processIsAbsent?: (pid: number) => boolean;
}

const uid = process.getuid?.();
const defaultRootDirectory = join(tmpdir(), uid === undefined ? "buffered-audio" : `buffered-audio-${uid}`);

function errorCode(error: unknown): unknown {
	return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function processIsAbsent(pid: number): boolean {
	try {
		process.kill(pid, 0);

		return false;
	} catch (error) {
		return errorCode(error) === "ESRCH";
	}
}

async function isOwnRoot(rootDirectory: string): Promise<boolean> {
	if (uid === undefined) return true;

	try {
		const stats = await lstat(rootDirectory);

		return stats.isDirectory() && stats.uid === uid;
	} catch {
		return false;
	}
}

async function prepareRoot(rootDirectory: string): Promise<boolean> {
	if (uid === undefined) {
		await mkdir(rootDirectory, { recursive: true });

		return true;
	}

	await mkdir(rootDirectory, { recursive: true, mode: 0o700 }).catch(() => undefined);

	if (!(await isOwnRoot(rootDirectory))) return false;

	await chmod(rootDirectory, 0o700);

	return true;
}

export async function createRenderTemporaryDirectory(options?: RenderTemporaryDirectoryOptions): Promise<string> {
	const rootDirectory = options?.rootDirectory ?? defaultRootDirectory;

	if (!(await prepareRoot(rootDirectory))) return mkdtemp(join(tmpdir(), "buffered-audio-"));

	return mkdtemp(join(rootDirectory, `render-${process.pid}-`));
}

export async function scavengeRenderTemporaryDirectories(options?: RenderTemporaryDirectoryOptions): Promise<void> {
	const rootDirectory = options?.rootDirectory ?? defaultRootDirectory;

	if (!(await isOwnRoot(rootDirectory))) return;

	let entries;

	try {
		entries = await readdir(rootDirectory, { withFileTypes: true });
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;

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
