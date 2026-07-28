import { mulberry32 } from "./mulberry32";

export const VIEW_W = 1200;
export const VIEW_H = 700;

const CENTER_X = VIEW_W / 2;
const CENTER_Y = VIEW_H / 2;

const V_SQUASH = 0.6;

const MAIN_COUNT = 30;
const MAIN_RADIUS = 130;

const OFFSHOOT_COUNT = 3;
const OFFSHOOT_DIST = 270;
const OFFSHOOT_DIST_JITTER = 40;
const OFFSHOOT_RADIUS_MIN = 50;
const OFFSHOOT_RADIUS_MAX = 75;
const OFFSHOOT_POINTS_MIN = 5;
const OFFSHOOT_POINTS_MAX = 8;

const ANCHOR_DIST = 400;
const ANCHOR_DIST_JITTER = 50;
const ANCHOR_X_CLAMP = 130;
const ANCHOR_Y_CLAMP = 60;

export const LABEL_WIDTH = 280;
export const LABEL_HEIGHT = 44;

interface PointLayout {
	readonly baseX: number;
	readonly baseY: number;
	readonly phaseX: number;
	readonly phaseY: number;
	readonly speed: number;
	readonly amp: number;
	readonly isAnchor: boolean;
}

interface EdgeLayout {
	readonly endpointA: number;
	readonly endpointB: number;
}

interface AnnotationLayout {
	readonly anchorIndex: number;
	readonly pointIndex: number;
	readonly labelOffsetX: number;
	readonly labelOffsetY: number;
	readonly align: "start" | "end";
}

export interface Layout {
	readonly points: ReadonlyArray<PointLayout>;
	readonly edges: ReadonlyArray<EdgeLayout>;
	readonly annotations: ReadonlyArray<AnnotationLayout>;
}

interface MutablePoint {
	baseX: number;
	baseY: number;
	phaseX: number;
	phaseY: number;
	speed: number;
	amp: number;
	isAnchor: boolean;
}

interface ClusterRange {
	readonly startIndex: number;
	readonly endIndex: number;
}

function dist(left: MutablePoint, right: MutablePoint) {
	return Math.hypot(left.baseX - right.baseX, left.baseY - right.baseY);
}

export function buildLayout(anchorCount: number, seed: number): Layout {
	const rand = mulberry32(seed);
	const points: Array<MutablePoint> = [];

	function pushPoint(seedPoint: { baseX: number; baseY: number; amp: number; isAnchor: boolean }) {
		points.push({
			baseX: seedPoint.baseX,
			baseY: seedPoint.baseY,
			phaseX: rand() * Math.PI * 2,
			phaseY: rand() * Math.PI * 2,
			speed: 0.32 + rand() * 0.4,
			amp: seedPoint.amp,
			isAnchor: seedPoint.isAnchor,
		});
	}

	for (let mainIndex = 0; mainIndex < MAIN_COUNT; mainIndex++) {
		const radius = MAIN_RADIUS * Math.sqrt(rand());
		const angle = rand() * Math.PI * 2;

		pushPoint({
			baseX: CENTER_X + Math.cos(angle) * radius,
			baseY: CENTER_Y + Math.sin(angle) * radius * V_SQUASH,
			amp: 6 + rand() * 5,
			isAnchor: false,
		});
	}

	const offshootRanges: Array<ClusterRange> = [];

	for (let offshootIndex = 0; offshootIndex < OFFSHOOT_COUNT; offshootIndex++) {
		const baseAngle = (offshootIndex / OFFSHOOT_COUNT) * Math.PI * 2 + (rand() - 0.5) * 0.5;
		const distance = OFFSHOOT_DIST + rand() * OFFSHOOT_DIST_JITTER;
		const centerX = CENTER_X + Math.cos(baseAngle) * distance;
		const centerY = CENTER_Y + Math.sin(baseAngle) * distance * V_SQUASH;
		const clusterRadius = OFFSHOOT_RADIUS_MIN + rand() * (OFFSHOOT_RADIUS_MAX - OFFSHOOT_RADIUS_MIN);
		const clusterCount = OFFSHOOT_POINTS_MIN + Math.floor(rand() * (OFFSHOOT_POINTS_MAX - OFFSHOOT_POINTS_MIN + 1));
		const startIndex = points.length;

		for (let inner = 0; inner < clusterCount; inner++) {
			const innerRadius = clusterRadius * Math.sqrt(rand());
			const innerAngle = rand() * Math.PI * 2;

			pushPoint({
				baseX: centerX + Math.cos(innerAngle) * innerRadius,
				baseY: centerY + Math.sin(innerAngle) * innerRadius,
				amp: 8 + rand() * 7,
				isAnchor: false,
			});
		}

		offshootRanges.push({ startIndex, endIndex: points.length });
	}

	const anchorAngles: Array<number> = [];

	for (let anchorIndex = 0; anchorIndex < anchorCount; anchorIndex++) {
		const base = (anchorIndex / Math.max(1, anchorCount)) * Math.PI * 2 + Math.PI / Math.max(1, anchorCount);
		const jitter = (rand() - 0.5) * 0.4;

		anchorAngles.push(base + jitter);
	}

	const anchorStartIndex = points.length;

	for (let anchorIndex = 0; anchorIndex < anchorCount; anchorIndex++) {
		const angle = anchorAngles[anchorIndex] ?? 0;
		const distance = ANCHOR_DIST + rand() * ANCHOR_DIST_JITTER;
		const rawX = CENTER_X + Math.cos(angle) * distance;
		const rawY = CENTER_Y + Math.sin(angle) * distance * V_SQUASH;

		const clampedX = Math.max(ANCHOR_X_CLAMP, Math.min(VIEW_W - ANCHOR_X_CLAMP, rawX));
		const clampedY = Math.max(ANCHOR_Y_CLAMP, Math.min(VIEW_H - ANCHOR_Y_CLAMP, rawY));

		pushPoint({
			baseX: clampedX,
			baseY: clampedY,
			amp: 0,
			isAnchor: true,
		});
	}

	const edges: Array<EdgeLayout> = [];
	const seen = new Set<string>();

	function addEdge(indexA: number, indexB: number) {
		if (indexA === indexB) return;

		const lo = Math.min(indexA, indexB);
		const hi = Math.max(indexA, indexB);
		const key = `${lo}-${hi}`;

		if (seen.has(key)) return;

		seen.add(key);
		edges.push({ endpointA: indexA, endpointB: indexB });
	}

	function connectKNearestWithinRange(range: ClusterRange, neighborCount: number) {
		for (let index = range.startIndex; index < range.endIndex; index++) {
			const here = points[index];

			if (!here) continue;

			const candidates: Array<{ neighborIndex: number; distance: number }> = [];

			for (let other = range.startIndex; other < range.endIndex; other++) {
				if (other === index) continue;

				const otherPoint = points[other];

				if (!otherPoint) continue;

				candidates.push({ neighborIndex: other, distance: dist(here, otherPoint) });
			}

			candidates.sort((left, right) => left.distance - right.distance);

			for (let slot = 0; slot < neighborCount && slot < candidates.length; slot++) {
				const candidate = candidates[slot];

				if (!candidate) continue;

				addEdge(index, candidate.neighborIndex);
			}
		}
	}

	connectKNearestWithinRange({ startIndex: 0, endIndex: MAIN_COUNT }, 4);

	offshootRanges.forEach((range) => {
		connectKNearestWithinRange(range, 3);
	});

	const OFFSHOOT_BRIDGES = 3;

	offshootRanges.forEach((range) => {
		const pairs: Array<{ offshootIdx: number; mainIdx: number; distance: number }> = [];

		for (let offshootIdx = range.startIndex; offshootIdx < range.endIndex; offshootIdx++) {
			const offshootPoint = points[offshootIdx];

			if (!offshootPoint) continue;

			for (let mainIdx = 0; mainIdx < MAIN_COUNT; mainIdx++) {
				const mainPoint = points[mainIdx];

				if (!mainPoint) continue;

				pairs.push({
					offshootIdx,
					mainIdx,
					distance: dist(offshootPoint, mainPoint),
				});
			}
		}

		pairs.sort((left, right) => left.distance - right.distance);

		for (let slot = 0; slot < OFFSHOOT_BRIDGES && slot < pairs.length; slot++) {
			const pair = pairs[slot];

			if (!pair) continue;

			addEdge(pair.offshootIdx, pair.mainIdx);
		}
	});

	for (let firstIdx = 0; firstIdx < offshootRanges.length; firstIdx++) {
		const first = offshootRanges[firstIdx];

		if (!first) continue;

		let bestSecondRange: ClusterRange | undefined;
		let bestPair: { firstPointIdx: number; secondPointIdx: number; distance: number } | undefined;

		for (let secondIdx = firstIdx + 1; secondIdx < offshootRanges.length; secondIdx++) {
			const second = offshootRanges[secondIdx];

			if (!second) continue;

			for (let pointA = first.startIndex; pointA < first.endIndex; pointA++) {
				const pointAValue = points[pointA];

				if (!pointAValue) continue;

				for (let pointB = second.startIndex; pointB < second.endIndex; pointB++) {
					const pointBValue = points[pointB];

					if (!pointBValue) continue;

					const distance = dist(pointAValue, pointBValue);

					if (!bestPair || distance < bestPair.distance) {
						bestPair = { firstPointIdx: pointA, secondPointIdx: pointB, distance };
						bestSecondRange = second;
					}
				}
			}
		}

		if (bestPair && bestSecondRange) {
			addEdge(bestPair.firstPointIdx, bestPair.secondPointIdx);
		}
	}

	for (let anchorIdx = anchorStartIndex; anchorIdx < points.length; anchorIdx++) {
		const anchor = points[anchorIdx];

		if (!anchor) continue;

		let bestOther = 0;
		let bestDist = Number.POSITIVE_INFINITY;

		for (let other = 0; other < anchorStartIndex; other++) {
			const otherPoint = points[other];

			if (!otherPoint) continue;

			const distance = dist(anchor, otherPoint);

			if (distance < bestDist) {
				bestDist = distance;
				bestOther = other;
			}
		}

		addEdge(anchorIdx, bestOther);
	}

	const annotations: Array<AnnotationLayout> = [];

	for (let anchorIndex = 0; anchorIndex < anchorCount; anchorIndex++) {
		const pointIndex = anchorStartIndex + anchorIndex;
		const anchor = points[pointIndex];

		if (!anchor) continue;

		const dx = anchor.baseX - CENTER_X;
		const dy = anchor.baseY - CENTER_Y;
		const length = Math.hypot(dx, dy) || 1;
		const dirX = dx / length;
		const dirY = dy / length;
		const labelDistance = 50;

		const labelOffsetX = dirX * labelDistance;
		const labelOffsetY = dirY * labelDistance;
		const align: "start" | "end" = labelOffsetX < 0 ? "end" : "start";

		annotations.push({
			anchorIndex,
			pointIndex,
			labelOffsetX,
			labelOffsetY,
			align,
		});
	}

	return { points, edges, annotations };
}
