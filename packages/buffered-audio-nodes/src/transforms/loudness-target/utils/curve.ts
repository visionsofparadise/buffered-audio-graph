/**
 * Transfer curve for the loudnessTarget node — three-segment, anchor-
 * based shape with direct dB gain values at each anchor and a brick-
 * wall extension above the limit anchor.
 *
 * Per design-loudness-target §"Curve shape" (post `plan-loudness-target-
 * limit-axis` rewrite).
 *
 * Three anchors as `(level, gainDb)` pairs:
 *   (floorDb,  0)            optional pass-through anchor; absent when
 *                            anchors.floorDb === null.
 *   (pivotDb,  B)            body anchor; B iterated for target LUFS.
 *   (limitDb,  peakGainDb)   limit anchor; closed-form
 *                            peakGainDb = effectiveTargetTp - limitDb.
 *                            `limitDb` defaults to `sourcePeakDb` (no
 *                            limiting) when peak control is disengaged,
 *                            and is iterated downward toward `pivotDb`
 *                            as the LRA-axis lever otherwise.
 *
 * The curve has up to three segments plus a brick-wall extension:
 *   - lower segment (only when floorDb !== null): linear ramp from
 *     gainDb = 0 at floorDb to gainDb = B at pivotDb.
 *   - mid (upper-body) segment: linear ramp from gainDb = B at pivotDb
 *     to gainDb = peakGainDb at limitDb.
 *   - brick-wall above limitDb: gainDb decreases 1 dB per 1 dB of
 *     additional absXDb so the apparent output level stays clamped at
 *     `effectiveTargetTp = limitDb + peakGainDb`.
 *
 * The brick-wall derivation:
 *   effectiveTargetTp = limitDb + peakGainDb       (closed-form rearranged)
 *   apparent output   = absXDb + gainDb
 *   set to ceiling    = effectiveTargetTp
 *   ⇒ gainDb          = effectiveTargetTp - absXDb
 *                     = limitDb + peakGainDb - absXDb
 *
 * Sonically: brick-wall in the gain envelope is sample-by-sample; in
 * the time domain it is smoothed by the bidirectional IIR (see
 * envelope.ts and §"Smoothing — peak-respecting two-stage envelope").
 *
 * Direct anchor gains, not a normalised 0–1 shape scaled by a single
 * boost factor. With two independent anchors (body `B` and limit
 * `peakGainDb`), a normalised formulation would force awkward
 * arithmetic to recover each anchor's absolute gain; direct
 * interpolation between (level, gainDb) pairs is shorter and
 * segment-local.
 */

export interface Anchors {
	/**
	 * Optional pass-through anchor (dB). When non-null, samples at or
	 * below floorDb receive gainDb = 0 (pass-through), and the lower
	 * segment ramps linearly from 0 at floorDb to B at pivotDb.
	 *
	 * When null, no pass-through region exists — samples below pivotDb
	 * receive uniform body gain B.
	 */
	floorDb: number | null;
	/** Body anchor level (dB). Gain at this level is exactly B. */
	pivotDb: number;
	/**
	 * Limit anchor level (dB). Gain at this level is exactly
	 * peakGainDb; above this level the curve brick-walls (see file
	 * header). Iterated downward from `sourcePeakDb` toward `pivotDb`
	 * as the LRA-axis lever per design-loudness-target §"Iteration".
	 */
	limitDb: number;
	/** Body gain in dB. Iterated for target LUFS. */
	B: number;
	/**
	 * Limit-anchor gain in dB. Closed-form from
	 * `peakGainDb = (targetTp ?? sourcePeakDb) - limitDb`.
	 * Can be 0 (limit unchanged), positive (headroom above limit
	 * restored), or negative (limit attenuated).
	 */
	peakGainDb: number;
}

/**
 * Per-sample gain in dB for a single absolute level (in dB).
 *
 * Segment selection:
 *   - floorDb !== null and absXDb <= floorDb  →  0 (pass-through)
 *   - floorDb !== null and absXDb < pivotDb   →  linear from 0 to B
 *   - floorDb === null and absXDb < pivotDb   →  B (uniform body gain)
 *   - absXDb < limitDb                         →  linear from B to peakGainDb
 *   - absXDb >= limitDb                        →  limitDb + peakGainDb − absXDb
 *                                                 (brick-wall — see header)
 *
 * The upper-body segment is plain linear interpolation (no tension).
 * The brick-wall branch's closed form `limitDb + peakGainDb − absXDb`
 * is continuous with the linear-segment value at absXDb = limitDb
 * (both evaluate to `peakGainDb`).
 */
export function gainDbAt(absXDb: number, anchors: Anchors): number {
	const { floorDb, pivotDb, limitDb, B: boost, peakGainDb } = anchors;

	if (floorDb !== null && absXDb <= floorDb) return 0;

	if (absXDb < pivotDb) {
		if (floorDb === null) return boost;

		const position = (absXDb - floorDb) / (pivotDb - floorDb);

		return position * boost;
	}

	if (absXDb < limitDb) {
		const position = (absXDb - pivotDb) / (limitDb - pivotDb);

		return boost + position * (peakGainDb - boost);
	}

	// Brick-wall above the limit anchor: keep apparent output (absXDb
	// + gainDb) clamped at effectiveTargetTp = limitDb + peakGainDb.
	return limitDb + peakGainDb - absXDb;
}
