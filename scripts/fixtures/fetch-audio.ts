/**
 * Fetch the audio test fixtures into `<repo>/../fixtures/audio/`.
 *
 * The kept `@buffered-audio/nodes` and `@buffered-audio/utils` test
 * suites read WAV fixtures from the out-of-repo `../fixtures/audio/`
 * directory (see `packages/buffered-audio-nodes/src/utils/test-binaries.ts`
 * and `packages/buffered-audio-nodes-utils/src/test-fixtures.ts`). Those
 * WAVs are not committed to the repo; they are hosted in the dedicated
 * public, content-addressed `buffered-audio-test-fixtures` S3 bucket
 * (managed by the `Fixtures` CDK stack in `apps/service/`) and fetched
 * here so CI / publish runs can execute the fixture-dependent tests.
 *
 * Reads are public, so this uses Node's built-in `fetch`/`crypto` and
 * intentionally does NOT pull in the AWS SDK (mirrors
 * `scripts/binaries/fetch.ts`).
 *
 * Usage: npm run fixtures:audio
 *
 * Exit codes:
 *   0 — every asset present in `../fixtures/audio/` with verified sha256.
 *   1 — download failure, hash mismatch, or any other fatal error.
 */
import { createHash } from "node:crypto"
import { createWriteStream, promises as fs } from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"

interface FixtureAsset {
	filename: string
	sha256: string
	size: number
}

interface FixturesManifest {
	version: number
	bucket: string
	region: string
	assets: Array<FixtureAsset>
}

function resolveRepoRoot(): string {
	const scriptDir = path.dirname(fileURLToPath(import.meta.url))

	return path.resolve(scriptDir, "..", "..")
}

function resolveAudioDir(): string {
	// Matches the `../fixtures/audio` location read by test-binaries.ts /
	// test-fixtures.ts (fixturesDir = <repoRoot>/../fixtures).
	return path.resolve(resolveRepoRoot(), "..", "fixtures", "audio")
}

function assetUrl(manifest: FixturesManifest, asset: FixtureAsset): string {
	return `https://${manifest.bucket}.s3.${manifest.region}.amazonaws.com/sha256/${asset.sha256}`
}

async function sha256File(filePath: string): Promise<string> {
	const hash = createHash("sha256")
	const handle = await fs.open(filePath, "r")

	try {
		const stream = handle.createReadStream()

		for await (const chunk of stream) {
			hash.update(chunk as Buffer)
		}
	} finally {
		await handle.close()
	}

	return hash.digest("hex")
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath)

		return true
	} catch {
		return false
	}
}

async function downloadAndVerify(
	url: string,
	destination: string,
	expectedSha256: string,
): Promise<void> {
	const tempPath = `${destination}.tmp`

	await fs.mkdir(path.dirname(destination), { recursive: true })

	const response = await fetch(url)

	if (!response.ok || response.body === null) {
		throw new Error(
			`Download failed for ${url}: HTTP ${response.status} ${response.statusText}`,
		)
	}

	const hash = createHash("sha256")
	const writeStream = createWriteStream(tempPath)
	const bodyStream = Readable.fromWeb(
		response.body as Parameters<typeof Readable.fromWeb>[0],
	)

	try {
		await pipeline(
			bodyStream,
			async function* (source: AsyncIterable<Buffer | Uint8Array>) {
				for await (const chunk of source) {
					const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk)

					hash.update(buf)
					yield buf
				}
			},
			writeStream,
		)
	} catch (error) {
		await fs.rm(tempPath, { force: true })
		throw error
	}

	const actualSha256 = hash.digest("hex")

	if (actualSha256 !== expectedSha256) {
		await fs.rm(tempPath, { force: true })
		throw new Error(
			`sha256 mismatch for ${url} — expected ${expectedSha256}, got ${actualSha256}`,
		)
	}

	await fs.rename(tempPath, destination)
}

async function main(): Promise<void> {
	const manifestPath = path.join(resolveRepoRoot(), "fixtures.manifest.json")
	const manifest = JSON.parse(
		await fs.readFile(manifestPath, "utf8"),
	) as FixturesManifest

	const audioDir = resolveAudioDir()

	console.warn(`[fixtures] audio dir: ${audioDir}`)
	console.warn(`[fixtures] assets:    ${manifest.assets.length}`)

	for (const asset of manifest.assets) {
		const destination = path.join(audioDir, asset.filename)

		if (await fileExists(destination)) {
			const existing = await sha256File(destination)

			if (existing === asset.sha256) {
				console.warn(`[fixtures] cache hit  ${asset.filename}`)
				continue
			}

			console.warn(
				`[fixtures] stale      ${asset.filename} (sha256 ${existing} != ${asset.sha256}) — re-downloading`,
			)
			await fs.rm(destination, { force: true })
		}

		const url = assetUrl(manifest, asset)

		console.warn(`[fixtures] download   ${asset.filename} <- ${url}`)
		await downloadAndVerify(url, destination, asset.sha256)
	}

	console.warn(`[fixtures] done — ${manifest.assets.length} audio fixture(s) ready`)
}

main().catch((error: unknown) => {
	console.error(error)
	process.exit(1)
})
