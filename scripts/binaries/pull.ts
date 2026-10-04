import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stageFixtureBinaries } from "../fixtures/stage-binaries";
import { formatTarget, parseTargetArgs, resolveRepoRoot } from "./manifest";

async function readDvcCommand(): Promise<Array<string>> {
	const packageJson = JSON.parse(await readFile(path.join(resolveRepoRoot(), "package.json"), "utf8")) as {
		scripts?: Record<string, string>;
	};
	const command = packageJson.scripts?.dvc;

	if (command === undefined) throw new Error('package.json has no "dvc" script');

	return [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? "");
}

function quoteForShell(arg: string): string {
	return /^[\w./:=-]+$/.test(arg) ? arg : `"${arg}"`;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const isPrepare = argv.includes("--prepare");

	if (isPrepare && process.env.CI !== undefined) {
		console.warn("[assets:pull] CI: skipped in prepare; the workflow pulls its own target");

		return;
	}

	const target = parseTargetArgs(argv.filter((arg) => arg !== "--prepare"));
	const [cmd, ...dvcArgs] = await readDvcCommand();

	if (cmd === undefined) throw new Error('package.json "dvc" script is empty');

	const args = [
		...dvcArgs,
		"pull",
		"--remote",
		"public",
		"assets/binaries/all.dvc",
		`assets/binaries/${formatTarget(target)}.dvc`,
		"fixtures/audio.dvc",
	];

	console.warn(`[assets:pull] target: ${formatTarget(target)}`);

	const options = { cwd: resolveRepoRoot(), stdio: "inherit" } as const;
	const result =
		process.platform === "win32"
			? spawnSync([cmd, ...args].map(quoteForShell).join(" "), { ...options, shell: true })
			: spawnSync(cmd, args, options);

	if (result.error !== undefined) throw result.error;

	if (result.status !== 0) process.exit(result.status ?? 1);

	await stageFixtureBinaries(target);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
