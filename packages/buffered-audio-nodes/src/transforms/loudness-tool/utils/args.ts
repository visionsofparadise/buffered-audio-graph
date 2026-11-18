import type { CliStreamInput } from "../../cli";

const AUDIO_COMMANDS: ReadonlyArray<string> = ["tp-norm", "lufs-norm", "target", "crest"];

const STREAM_OWNED_PATTERNS: ReadonlyArray<RegExp> = [
	/^-(f|ar|ac|ch_layout|channel_layout|sample_rate)(:.*)?$/s,
	/^(-o|--output)/,
	/^-V/,
	/^--scratch-dir/,
	/^pipe:/,
];

const STREAM_OWNED_TOKENS: ReadonlySet<string> = new Set(["-", "--", "-h", "--help", "--version"]);

const VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"--floor",
	"--limit-db",
	"--limit-percentile",
	"--lufs",
	"--oversampling",
	"--pivot",
	"--smoothing",
	"--spread",
	"--steps",
	"--tolerance",
	"--tp",
]);

const NEGATIVE_NUMBER = /^-(\d+|\d*\.\d+)(e[+-]?\d+)?$/;

function isOptionToken(token: string): boolean {
	return token.length > 1 && token.startsWith("-") && !NEGATIVE_NUMBER.test(token);
}

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

	const valueless = args.find((token, index) => {
		const next = args[index + 1];

		return VALUE_OPTIONS.has(token) && (next === undefined || isOptionToken(next));
	});

	if (valueless !== undefined) return `args must give "${valueless}" a value`;

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
		"wav",
		"-o",
		"-",
	];
}
