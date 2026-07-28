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

export function encodeToElements(text: string): Array<"n" | "w"> {
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
