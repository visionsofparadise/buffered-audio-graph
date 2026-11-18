import type { CliStreamInput } from "../../cli";

const AUDIO_COMMANDS: ReadonlyArray<string> = ["tp-norm", "lufs-norm", "target", "crest"];

const STREAM_OWNED_PATTERNS: ReadonlyArray<RegExp> = [
	/^-(f|ar|ac|ch_layout|channel_layout|sample_rate)(:.*)?$/s,
	/^(-o|--output)/,
	/^--scratch-dir/,
	/^pipe:/,
];

const STREAM_OWNED_TOKENS: ReadonlySet<string> = new Set(["-", "--", "-h", "--help", "-V", "--version"]);

export function validateLoudnessToolArgs(args: ReadonlyArray<string>): string | undefined {
	const command = args[0];

	if (command === undefined || !AUDIO_COMMANDS.includes(command)) {
		return `args must start with tp-norm, lufs-norm, target or crest, got ${command === undefined ? "nothing" : `"${command}"`}`;
	}

	const owned = args.find(
		(token) => STREAM_OWNED_TOKENS.has(token) || STREAM_OWNED_PATTERNS.some((pattern) => pattern.test(token)),
	);

	if (owned !== undefined) {
		return `args must not contain "${owned}", because the node owns loudness-tool's stdin, stdout, stream formats and scratch directory`;
	}

	return undefined;
}

export function buildLoudnessToolArgs(
	args: ReadonlyArray<string>,
	scratchDirectory: string,
	input: CliStreamInput,
): Array<string> {
	return [
		"--scratch-dir",
		scratchDirectory,
		...args,
		"-f",
		"f32le",
		"-ar",
		String(input.sampleRate),
		"-ac",
		String(input.channels),
		"-",
		"-f",
		"f32le",
		"-o",
		"-",
	];
}
