import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
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
	const target = parseTargetArgs(process.argv.slice(2));
	const [cmd, ...dvcArgs] = await readDvcCommand();

	if (cmd === undefined) throw new Error('package.json "dvc" script is empty');

	const args = [...dvcArgs, "pull", "assets/binaries/all.dvc", `assets/binaries/${formatTarget(target)}.dvc`];

	console.warn(`[pull] target: ${formatTarget(target)}`);

	const useShell = process.platform === "win32";
	const result = spawnSync(cmd, useShell ? args.map(quoteForShell) : args, {
		cwd: resolveRepoRoot(),
		stdio: "inherit",
		shell: useShell,
	});

	if (result.error !== undefined) throw result.error;

	if (result.status !== 0) process.exit(result.status ?? 1);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
