import { createHash } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export function s3AssetUrl(bucket: string, region: string, sha256: string): string {
	return `https://${bucket}.s3.${region}.amazonaws.com/sha256/${sha256}`;
}

export async function sha256File(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	const handle = await fs.open(filePath, "r");

	try {
		const stream = handle.createReadStream();

		for await (const chunk of stream) {
			hash.update(chunk as Buffer);
		}
	} finally {
		await handle.close();
	}

	return hash.digest("hex");
}

export async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);

		return true;
	} catch {
		return false;
	}
}

export async function downloadAndVerify(url: string, destination: string, expectedSha256: string): Promise<void> {
	const tempPath = `${destination}.tmp`;

	await fs.mkdir(path.dirname(destination), { recursive: true });

	const response = await fetch(url);

	if (!response.ok || response.body === null) {
		throw new Error(`Download failed for ${url}: HTTP ${response.status} ${response.statusText}`);
	}

	const hash = createHash("sha256");
	const writeStream = createWriteStream(tempPath);
	const bodyStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);

	try {
		await pipeline(
			bodyStream,
			async function* (source: AsyncIterable<Buffer | Uint8Array>) {
				for await (const chunk of source) {
					const buffer = chunk instanceof Buffer ? chunk : Buffer.from(chunk);

					hash.update(buffer);
					yield buffer;
				}
			},
			writeStream,
		);
	} catch (error) {
		await fs.rm(tempPath, { force: true });

		throw error;
	}

	const actualSha256 = hash.digest("hex");

	if (actualSha256 !== expectedSha256) {
		await fs.rm(tempPath, { force: true });

		throw new Error(`sha256 mismatch for ${url} — expected ${expectedSha256}, got ${actualSha256}`);
	}

	await fs.rename(tempPath, destination);
}
