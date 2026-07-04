/* eslint-disable @typescript-eslint/no-non-null-assertion -- tight DSP loop with bounds-checked typed array access */

import type { TransferFunction } from "./cross-spectral";

export interface SeedValidation {
	readonly degenerate: boolean;
	readonly reason: string;
}

export function validateTransferSeed(transfer: TransferFunction): SeedValidation {
	const numBins = transfer.real.length;

	if (numBins === 0) return { degenerate: true, reason: "empty seed" };

	let maxMag = 0;
	let nanCount = 0;
	let nonFiniteCount = 0;

	for (let bin = 0; bin < numBins; bin++) {
		const hReBin = transfer.real[bin]!;
		const hImBin = transfer.imag[bin]!;

		if (Number.isNaN(hReBin) || Number.isNaN(hImBin)) {
			nanCount++;
			continue;
		}

		if (!Number.isFinite(hReBin) || !Number.isFinite(hImBin)) {
			nonFiniteCount++;
			continue;
		}

		// Denormals are finite but break Kalman propagation; flag anything between 0 and the float32 minimum normal (~1.18e-38). Real zeros pass.
		const minNormal = 1.175494e-38;
		const reAbs = hReBin < 0 ? -hReBin : hReBin;
		const imAbs = hImBin < 0 ? -hImBin : hImBin;

		if ((reAbs > 0 && reAbs < minNormal) || (imAbs > 0 && imAbs < minNormal)) {
			nonFiniteCount++;
			continue;
		}

		const mag = Math.sqrt(hReBin * hReBin + hImBin * hImBin);

		if (mag > maxMag) maxMag = mag;
	}

	if (nanCount > 0) return { degenerate: true, reason: `NaN in ${nanCount} bin(s)` };
	if (nonFiniteCount > 0) return { degenerate: true, reason: `Inf/denormal in ${nonFiniteCount} bin(s)` };

	if (maxMag === 0) return { degenerate: true, reason: "all-zero seed" };

	const silenceThreshold = 1e-4 * maxMag;
	let silentBins = 0;

	for (let bin = 0; bin < numBins; bin++) {
		const hReBin = transfer.real[bin]!;
		const hImBin = transfer.imag[bin]!;
		const mag = Math.sqrt(hReBin * hReBin + hImBin * hImBin);

		if (mag < silenceThreshold) silentBins++;
	}

	if (silentBins >= 0.8 * numBins) {
		return { degenerate: true, reason: `${silentBins}/${numBins} bins below 1e-4 × max-bin-magnitude` };
	}

	return { degenerate: false, reason: "" };
}

export function coldStartSeed(numBins: number): TransferFunction {
	return {
		real: new Float32Array(numBins),
		imag: new Float32Array(numBins),
	};
}
