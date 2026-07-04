// All state is per-instance — instances are safe for concurrent use.
export class MixedRadixFft {
	private readonly size: number;
	private readonly radices: Array<number>;
	private readonly permutation: Uint16Array;
	private readonly twiddleRe: Float32Array;
	private readonly twiddleIm: Float32Array;

	readonly frameRe: Float32Array;
	readonly frameIm: Float32Array;
	readonly outRe: Float32Array;
	readonly outIm: Float32Array;
	private readonly auxIm: Float32Array;

	constructor(size: number) {
		this.size = size;
		this.radices = factorize(size);

		this.frameRe = new Float32Array(size);
		this.frameIm = new Float32Array(size);
		this.outRe = new Float32Array(size);
		this.outIm = new Float32Array(size);
		this.auxIm = new Float32Array(size);

		this.permutation = computePermutation(size, this.radices);
		const { twiddleRe, twiddleIm } = computeTwiddles(this.radices);

		this.twiddleRe = twiddleRe;
		this.twiddleIm = twiddleIm;
	}

	fft(xRe: Float32Array, xIm: Float32Array, outRe: Float32Array, outIm: Float32Array): void {
		const perm = this.permutation;
		const nn = this.size;

		for (let index = 0; index < nn; index++) {
			const pp = perm[index] ?? 0;

			outRe[index] = xRe[pp] ?? 0;
			outIm[index] = xIm[pp] ?? 0;
		}

		let groupSize = 1;
		let twOffset = 0;

		for (const radix of this.radices) {
			groupSize *= radix;
			const subSize = groupSize / radix;

			if (radix === 2) {
				twOffset = this.radix2(outRe, outIm, nn, groupSize, subSize, twOffset);
			} else if (radix === 3) {
				twOffset = this.radix3(outRe, outIm, nn, groupSize, subSize, twOffset);
			} else if (radix === 5) {
				twOffset = this.radix5(outRe, outIm, nn, groupSize, subSize, twOffset);
			}
		}
	}

	ifft(xRe: Float32Array, xIm: Float32Array, outRe: Float32Array, outIm: Float32Array): void {
		const auxIm = this.auxIm;
		const nn = this.size;

		for (let index = 0; index < nn; index++) {
			auxIm[index] = -(xIm[index] ?? 0);
		}

		this.fft(xRe, auxIm, outRe, outIm);

		for (let index = 0; index < nn; index++) {
			outRe[index] = (outRe[index] ?? 0) / nn;
			outIm[index] = -(outIm[index] ?? 0) / nn;
		}
	}

	private radix2(outRe: Float32Array, outIm: Float32Array, nn: number, groupSize: number, subSize: number, twOffset: number): number {
		for (let group = 0; group < nn; group += groupSize) {
			for (let ni = 0; ni < subSize; ni++) {
				const idx0 = group + ni;
				const idx1 = idx0 + subSize;

				const twRe = ni === 0 ? 1 : (this.twiddleRe[twOffset + ni - 1] ?? 0);
				const twIm = ni === 0 ? 0 : (this.twiddleIm[twOffset + ni - 1] ?? 0);

				const tRe = (outRe[idx1] ?? 0) * twRe - (outIm[idx1] ?? 0) * twIm;
				const tIm = (outRe[idx1] ?? 0) * twIm + (outIm[idx1] ?? 0) * twRe;

				outRe[idx1] = (outRe[idx0] ?? 0) - tRe;
				outIm[idx1] = (outIm[idx0] ?? 0) - tIm;
				outRe[idx0] = (outRe[idx0] ?? 0) + tRe;
				outIm[idx0] = (outIm[idx0] ?? 0) + tIm;
			}
		}

		return twOffset + subSize - 1;
	}

	private radix3(outRe: Float32Array, outIm: Float32Array, nn: number, groupSize: number, subSize: number, twOffset: number): number {
		const c3 = -0.5;
		const s3 = -Math.sqrt(3) / 2;

		for (let group = 0; group < nn; group += groupSize) {
			for (let ni = 0; ni < subSize; ni++) {
				const idx0 = group + ni;
				const idx1 = idx0 + subSize;
				const idx2 = idx0 + 2 * subSize;

				let tw1Re: number, tw1Im: number, tw2Re: number, tw2Im: number;

				if (ni === 0) {
					tw1Re = 1; tw1Im = 0; tw2Re = 1; tw2Im = 0;
				} else {
					tw1Re = this.twiddleRe[twOffset + ni - 1] ?? 0;
					tw1Im = this.twiddleIm[twOffset + ni - 1] ?? 0;
					tw2Re = this.twiddleRe[twOffset + subSize - 1 + ni - 1] ?? 0;
					tw2Im = this.twiddleIm[twOffset + subSize - 1 + ni - 1] ?? 0;
				}

				const x1Re = (outRe[idx1] ?? 0) * tw1Re - (outIm[idx1] ?? 0) * tw1Im;
				const x1Im = (outRe[idx1] ?? 0) * tw1Im + (outIm[idx1] ?? 0) * tw1Re;
				const x2Re = (outRe[idx2] ?? 0) * tw2Re - (outIm[idx2] ?? 0) * tw2Im;
				const x2Im = (outRe[idx2] ?? 0) * tw2Im + (outIm[idx2] ?? 0) * tw2Re;

				const x0Re = outRe[idx0] ?? 0;
				const x0Im = outIm[idx0] ?? 0;

				const sumRe = x1Re + x2Re;
				const sumIm = x1Im + x2Im;
				const diffRe = x1Re - x2Re;
				const diffIm = x1Im - x2Im;

				outRe[idx0] = x0Re + sumRe;
				outIm[idx0] = x0Im + sumIm;
				outRe[idx1] = x0Re + c3 * sumRe - s3 * diffIm;
				outIm[idx1] = x0Im + c3 * sumIm + s3 * diffRe;
				outRe[idx2] = x0Re + c3 * sumRe + s3 * diffIm;
				outIm[idx2] = x0Im + c3 * sumIm - s3 * diffRe;
			}
		}

		return twOffset + 2 * (subSize - 1);
	}

	private radix5(outRe: Float32Array, outIm: Float32Array, nn: number, groupSize: number, subSize: number, twOffset: number): number {
		const cos1 = Math.cos((2 * Math.PI) / 5);
		const cos2 = Math.cos((4 * Math.PI) / 5);
		const sin1 = -Math.sin((2 * Math.PI) / 5);
		const sin2 = -Math.sin((4 * Math.PI) / 5);

		for (let group = 0; group < nn; group += groupSize) {
			for (let ni = 0; ni < subSize; ni++) {
				const idx0 = group + ni;
				const idx1 = idx0 + subSize;
				const idx2 = idx0 + 2 * subSize;
				const idx3 = idx0 + 3 * subSize;
				const idx4 = idx0 + 4 * subSize;

				let tw1Re: number, tw1Im: number;
				let tw2Re: number, tw2Im: number;
				let tw3Re: number, tw3Im: number;
				let tw4Re: number, tw4Im: number;

				if (ni === 0) {
					tw1Re = 1; tw1Im = 0; tw2Re = 1; tw2Im = 0;
					tw3Re = 1; tw3Im = 0; tw4Re = 1; tw4Im = 0;
				} else {
					tw1Re = this.twiddleRe[twOffset + ni - 1] ?? 0;
					tw1Im = this.twiddleIm[twOffset + ni - 1] ?? 0;
					tw2Re = this.twiddleRe[twOffset + subSize - 1 + ni - 1] ?? 0;
					tw2Im = this.twiddleIm[twOffset + subSize - 1 + ni - 1] ?? 0;
					tw3Re = this.twiddleRe[twOffset + 2 * (subSize - 1) + ni - 1] ?? 0;
					tw3Im = this.twiddleIm[twOffset + 2 * (subSize - 1) + ni - 1] ?? 0;
					tw4Re = this.twiddleRe[twOffset + 3 * (subSize - 1) + ni - 1] ?? 0;
					tw4Im = this.twiddleIm[twOffset + 3 * (subSize - 1) + ni - 1] ?? 0;
				}

				const x0Re = outRe[idx0] ?? 0;
				const x0Im = outIm[idx0] ?? 0;
				const x1Re = (outRe[idx1] ?? 0) * tw1Re - (outIm[idx1] ?? 0) * tw1Im;
				const x1Im = (outRe[idx1] ?? 0) * tw1Im + (outIm[idx1] ?? 0) * tw1Re;
				const x2Re = (outRe[idx2] ?? 0) * tw2Re - (outIm[idx2] ?? 0) * tw2Im;
				const x2Im = (outRe[idx2] ?? 0) * tw2Im + (outIm[idx2] ?? 0) * tw2Re;
				const x3Re = (outRe[idx3] ?? 0) * tw3Re - (outIm[idx3] ?? 0) * tw3Im;
				const x3Im = (outRe[idx3] ?? 0) * tw3Im + (outIm[idx3] ?? 0) * tw3Re;
				const x4Re = (outRe[idx4] ?? 0) * tw4Re - (outIm[idx4] ?? 0) * tw4Im;
				const x4Im = (outRe[idx4] ?? 0) * tw4Im + (outIm[idx4] ?? 0) * tw4Re;

				const sum14Re = x1Re + x4Re;
				const sum14Im = x1Im + x4Im;
				const diff14Re = x1Re - x4Re;
				const diff14Im = x1Im - x4Im;
				const sum23Re = x2Re + x3Re;
				const sum23Im = x2Im + x3Im;
				const diff23Re = x2Re - x3Re;
				const diff23Im = x2Im - x3Im;

				outRe[idx0] = x0Re + sum14Re + sum23Re;
				outIm[idx0] = x0Im + sum14Im + sum23Im;
				outRe[idx1] = x0Re + cos1 * sum14Re + cos2 * sum23Re - sin1 * diff14Im - sin2 * diff23Im;
				outIm[idx1] = x0Im + cos1 * sum14Im + cos2 * sum23Im + sin1 * diff14Re + sin2 * diff23Re;
				outRe[idx2] = x0Re + cos2 * sum14Re + cos1 * sum23Re - sin2 * diff14Im + sin1 * diff23Im;
				outIm[idx2] = x0Im + cos2 * sum14Im + cos1 * sum23Im + sin2 * diff14Re - sin1 * diff23Re;
				outRe[idx3] = x0Re + cos2 * sum14Re + cos1 * sum23Re + sin2 * diff14Im - sin1 * diff23Im;
				outIm[idx3] = x0Im + cos2 * sum14Im + cos1 * sum23Im - sin2 * diff14Re + sin1 * diff23Re;
				outRe[idx4] = x0Re + cos1 * sum14Re + cos2 * sum23Re + sin1 * diff14Im + sin2 * diff23Im;
				outIm[idx4] = x0Im + cos1 * sum14Im + cos2 * sum23Im - sin1 * diff14Re - sin2 * diff23Re;
			}
		}

		return twOffset + 4 * (subSize - 1);
	}
}

function factorize(size: number): Array<number> {
	const factors: Array<number> = [];
	let remaining = size;

	for (const prime of [5, 3, 2]) {
		while (remaining % prime === 0) {
			factors.push(prime);
			remaining /= prime;
		}
	}

	if (remaining !== 1) {
		throw new Error(`MixedRadixFft: size ${size} has unsupported prime factor ${remaining} (only 2, 3, 5 supported)`);
	}

	factors.sort((lhs, rhs) => lhs - rhs);

	return factors;
}

function computePermutation(size: number, radices: Array<number>): Uint16Array {
	const permutation = new Uint16Array(size);

	for (let index = 0; index < size; index++) {
		let remainder = index;
		let permuted = 0;
		let base = size;

		for (const radix of radices) {
			base = base / radix;
			const digit = remainder % radix;

			remainder = Math.floor(remainder / radix);
			permuted += digit * base;
		}

		permutation[index] = permuted;
	}

	return permutation;
}

function computeTwiddles(radices: Array<number>): { twiddleRe: Float32Array; twiddleIm: Float32Array } {
	let totalTwiddles = 0;
	let groupSize = 1;

	for (const radix of radices) {
		groupSize *= radix;
		totalTwiddles += (radix - 1) * (groupSize / radix - 1);
	}

	const twiddleRe = new Float32Array(totalTwiddles);
	const twiddleIm = new Float32Array(totalTwiddles);

	let twOffset = 0;

	groupSize = 1;

	for (const radix of radices) {
		groupSize *= radix;
		const subSize = groupSize / radix;

		for (let kk = 1; kk < radix; kk++) {
			for (let ni = 1; ni < subSize; ni++) {
				const angle = (-2 * Math.PI * kk * ni) / groupSize;

				twiddleRe[twOffset] = Math.cos(angle);
				twiddleIm[twOffset] = Math.sin(angle);
				twOffset++;
			}
		}
	}

	return { twiddleRe, twiddleIm };
}
