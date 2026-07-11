import type { ComponentPropsWithRef } from "react";
import { cn } from "../utils/cn";

export interface BarcodeProps extends Omit<ComponentPropsWithRef<"div">, "color"> {
	readonly text: string;
	readonly height?: number;
	readonly narrow?: number;
	readonly wide?: number;
	readonly gap?: number;
	readonly color?: string;
	/** When set, wide bars render in this color instead of `color` (the accent weave). */
	readonly accentColor?: string;
}

// Code 39 alphabet → 9-element pattern of 'n' (narrow) and 'w' (wide), 5 bars + 4 spaces.
const CODE_39: Record<string, string> = {
	"0": "nnnwwnwnn",
	"1": "wnnwnnnnw",
	"2": "nnwwnnnnw",
	"3": "wnwwnnnnn",
	"4": "nnnwwnnnw",
	"5": "wnnwwnnnn",
	"6": "nnwwwnnnn",
	"7": "nnnwnnwnw",
	"8": "wnnwnnwnn",
	"9": "nnwwnnwnn",
	A: "wnnnnwnnw",
	B: "nnwnnwnnw",
	C: "wnwnnwnnn",
	D: "nnnnwwnnw",
	E: "wnnnwwnnn",
	F: "nnwnwwnnn",
	G: "nnnnnwwnw",
	H: "wnnnnwwnn",
	I: "nnwnnwwnn",
	J: "nnnnwwwnn",
	K: "wnnnnnnww",
	L: "nnwnnnnww",
	M: "wnwnnnnwn",
	N: "nnnnwnnww",
	O: "wnnnwnnwn",
	P: "nnwnwnnwn",
	Q: "nnnnnnwww",
	R: "wnnnnnwwn",
	S: "nnwnnnwwn",
	T: "nnnnwnwwn",
	U: "wwnnnnnnw",
	V: "nwwnnnnnw",
	W: "wwwnnnnnn",
	X: "nwnnwnnnw",
	Y: "wwnnwnnnn",
	Z: "nwwnwnnnn",
	"-": "nwnnnnwnw",
	".": "wwnnnnwnn",
	" ": "nwwnnnwnn",
	$: "nwnwnwnnn",
	"/": "nwnwnnnwn",
	"+": "nwnnnwnwn",
	"%": "nnnwnwnwn",
	"*": "nwnnwnwnn",
};

function encodeToElements(text: string): Array<"n" | "w"> {
	const elements: Array<"n" | "w"> = [];
	const framed = `*${text.toUpperCase()}*`;

	for (let charIndex = 0; charIndex < framed.length; charIndex++) {
		const char = framed[charIndex] ?? "";
		const pattern = CODE_39[char];

		if (!pattern) continue;

		for (const element of pattern) {
			elements.push(element === "w" ? "w" : "n");
		}

		if (charIndex < framed.length - 1) elements.push("n");
	}

	return elements;
}

export function Barcode({ text, height = 48, narrow = 1, wide = 3, gap = 0, color = "var(--color-text-primary)", accentColor, className, style, ref, ...rest }: BarcodeProps) {
	const elements = encodeToElements(text);

	return (
		<div
			ref={ref}
			className={cn("flex items-end", className)}
			style={{ height, gap, ...style }}
			{...rest}
		>
			{elements.map((element, ix) => {
				const isWide = element === "w";
				const isVisible = ix % 2 === 0;

				return (
					<div
						key={`bar-${ix}`}
						style={{
							width: isWide ? wide : narrow,
							height: "100%",
							backgroundColor: isVisible ? (accentColor && isWide ? accentColor : color) : "transparent",
						}}
					/>
				);
			})}
		</div>
	);
}

/** Pixel width the Barcode will render for `text` at the given widths. */
export function barcodeWidth(text: string, narrow: number, wide: number, gap: number): number {
	const elements = encodeToElements(text);
	const narrowCount = elements.filter((element) => element === "n").length;
	const wideCount = elements.length - narrowCount;

	return narrowCount * narrow + wideCount * wide + gap * Math.max(0, elements.length - 1);
}
