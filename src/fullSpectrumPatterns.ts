import { colorDistance, rgbToHex } from "./colorUtils";
import type { FilamentChannel, Rgb } from "./types";

export interface FullSpectrumPattern {
  id: string;
  name: string;
  componentA: number;
  componentB: number;
  manualPattern: string;
  expandedPattern: string;
  layerCount: number;
  mixBPercent: number;
  rgb: Rgb;
  hex: string;
}

interface PatternCandidate extends FullSpectrumPattern {
  priority: number;
}

const USER_PAIR_LADDER = ["11211", "12121", "21212", "22122"];
const MIN_PATTERN_COUNT = 30;
const MAX_PATTERN_COUNT = 120;
const PAIR_RATIO_LAYER_COUNTS = [4, 5, 6, 7];
const MIN_PAIR_COMPONENT_RATIO = 0.2;
const PAIR_RATIO_BUCKET_PERCENT = 5;

export function clampFullSpectrumPatternCount(count: number): number {
  return Math.min(MAX_PATTERN_COUNT, Math.max(MIN_PATTERN_COUNT, Math.round(count)));
}

export function generateFullSpectrumPatterns(
  filaments: FilamentChannel[],
  requestedCount: number,
): FullSpectrumPattern[] {
  const physicalCount = Math.min(9, filaments.length);
  if (physicalCount < 2) {
    return [];
  }

  const targetCount = clampFullSpectrumPatternCount(requestedCount);
  const candidates = buildFullSpectrumPatternCandidates(filaments, physicalCount, targetCount);

  const priority = [...candidates.values()]
    .filter((candidate) => candidate.priority <= 1)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const selected =
    priority.length >= targetCount
      ? selectDiversePatterns(priority, filaments, [], targetCount)
      : [
          ...priority,
          ...selectDiversePatterns(
            [...candidates.values()].filter((candidate) => candidate.priority > 1),
            filaments,
            priority,
            targetCount - priority.length,
          ),
        ];

  return selected.map(({ priority: _priority, ...pattern }) => pattern);
}

export function estimateFullSpectrumPatternCapacity(filaments: FilamentChannel[]): number {
  const physicalCount = Math.min(9, filaments.length);
  if (physicalCount < 2) {
    return 0;
  }

  return Math.min(MAX_PATTERN_COUNT, buildFullSpectrumPatternCandidates(filaments, physicalCount, MAX_PATTERN_COUNT).size);
}

export function fullSpectrumPatternDefinitions(patterns: FullSpectrumPattern[]): string {
  return patterns
    .map((pattern, index) => {
      const stableId = index + 1;
      return [
        pattern.componentA,
        pattern.componentB,
        1,
        1,
        pattern.mixBPercent,
        0,
        "g",
        "w",
        "m2",
        "z0",
        "xa0",
        "xb0",
        "d0",
        "o0",
        `u${stableId}`,
        pattern.manualPattern,
      ].join(",");
    })
    .join(";");
}

export function nearestPatternPaletteIndex(rgb: Rgb, palette: Rgb[]): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  palette.forEach((candidate, index) => {
    const distance = colorDistance(rgb, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function createPairPattern(
  filaments: FilamentChannel[],
  componentA: number,
  componentB: number,
  manualPattern: string,
  offset: number,
): PatternCandidate {
  const expandedPattern = manualPattern
    .split("")
    .map((step) => (step === "1" ? componentA : componentB).toString())
    .join("");
  const rgb = mixPatternRgb(expandedPattern, filaments);
  const name = `${filaments[componentA - 1]?.name ?? `Filament ${componentA}`} + ${
    filaments[componentB - 1]?.name ?? `Filament ${componentB}`
  } ${manualPattern}`;

  return {
    id: `pair_${componentA}_${componentB}_${manualPattern}`,
    name,
    componentA,
    componentB,
    manualPattern,
    expandedPattern,
    layerCount: manualPattern.length,
    mixBPercent: mixBPercent(manualPattern),
    rgb,
    hex: rgbToHex(rgb),
    priority: offset === 0 ? 0 : 1,
  };
}

function createPairRatioPattern(
  filaments: FilamentChannel[],
  componentA: number,
  componentB: number,
  aCount: number,
  bCount: number,
  layerCount: number,
): PatternCandidate | null {
  if (!hasSufficientPairRatio(aCount, bCount)) {
    return null;
  }

  const expandedPattern = balancedLayerSequenceForPair(componentA, componentB, aCount, bCount);
  if (!expandedPattern) {
    return null;
  }

  const manualPattern = expandedPattern
    .split("")
    .map((step) => (Number(step) === componentA ? "1" : "2"))
    .join("");
  const rgb = mixPatternRgb(expandedPattern, filaments);
  const name = `${filaments[componentA - 1]?.name ?? `Filament ${componentA}`} + ${
    filaments[componentB - 1]?.name ?? `Filament ${componentB}`
  } ${manualPattern}`;

  return {
    id: `pair_ratio_${componentA}_${componentB}_${layerCount}_${aCount}_${bCount}_${manualPattern}`,
    name,
    componentA,
    componentB,
    manualPattern,
    expandedPattern,
    layerCount,
    mixBPercent: mixBPercent(manualPattern),
    rgb,
    hex: rgbToHex(rgb),
    priority: 2,
  };
}

function buildFullSpectrumPatternCandidates(
  filaments: FilamentChannel[],
  physicalCount: number,
  targetCount: number,
): Map<string, PatternCandidate> {
  const candidates = new Map<string, PatternCandidate>();

  for (let a = 1; a <= physicalCount; a += 1) {
    for (let b = a + 1; b <= physicalCount; b += 1) {
      USER_PAIR_LADDER.forEach((manualPattern, offset) => {
        addCandidate(candidates, createPairPattern(filaments, a, b, manualPattern, offset));
      });
    }
  }

  for (const layerCount of PAIR_RATIO_LAYER_COUNTS) {
    for (let a = 1; a <= physicalCount; a += 1) {
      for (let b = a + 1; b <= physicalCount; b += 1) {
        for (let bCount = 1; bCount < layerCount; bCount += 1) {
          const candidate = createPairRatioPattern(
            filaments,
            a,
            b,
            layerCount - bCount,
            bCount,
            layerCount,
          );
          if (candidate) {
            addCandidate(candidates, candidate);
          }
        }
      }
    }
  }

  // Snapmaker/Orca FullSpectrum definitions name two components, so every pattern stays pair-local.
  // Lengths 4-7 cover the useful 20-80% range without long ratio-near-duplicates.
  return candidates;
}

function balancedLayerSequenceForPair(
  componentA: number,
  componentB: number,
  aCount: number,
  bCount: number,
): string {
  if (aCount === bCount) {
    return Array.from({ length: aCount + bCount }, (_, index) =>
      (index % 2 === 0 ? componentA : componentB).toString(),
    ).join("");
  }

  return aCount > bCount
    ? balancedMajorMinorSequence(componentA, aCount, componentB, bCount)
    : balancedMajorMinorSequence(componentB, bCount, componentA, aCount);
}

function hasSufficientPairRatio(aCount: number, bCount: number): boolean {
  const total = aCount + bCount;
  if (total <= 0) {
    return false;
  }

  return Math.min(aCount, bCount) / total >= MIN_PAIR_COMPONENT_RATIO;
}

function balancedMajorMinorSequence(
  majorComponent: number,
  majorCount: number,
  minorComponent: number,
  minorCount: number,
): string {
  const sequence: string[] = [];
  const gapCount = minorCount + 1;
  let emittedMajor = 0;

  for (let gap = 0; gap < gapCount; gap += 1) {
    const targetMajor = Math.floor(((gap + 1) * majorCount) / gapCount);
    const gapSize = targetMajor - emittedMajor;
    for (let index = 0; index < gapSize; index += 1) {
      sequence.push(majorComponent.toString());
    }
    emittedMajor = targetMajor;
    if (gap < minorCount) {
      sequence.push(minorComponent.toString());
    }
  }

  return sequence.join("");
}

function selectDiversePatterns(
  candidates: PatternCandidate[],
  filaments: FilamentChannel[],
  existing: PatternCandidate[],
  targetCount: number,
): PatternCandidate[] {
  const selected: PatternCandidate[] = [];
  const remaining = [...candidates].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const anchors = filaments.map((filament) => filament.rgb);

  while (selected.length < targetCount && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    remaining.forEach((candidate, index) => {
      const comparison = [...anchors, ...existing.map((pattern) => pattern.rgb), ...selected.map((pattern) => pattern.rgb)];
      const nearestDistance = Math.min(...comparison.map((rgb) => colorDistance(candidate.rgb, rgb)));
      const score = nearestDistance - candidate.priority * 250;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });

    const [next] = remaining.splice(bestIndex, 1);
    selected.push(next);
  }

  return selected.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function addCandidate(candidates: Map<string, PatternCandidate>, candidate: PatternCandidate) {
  const key = candidateRatioKey(candidate);
  const existing = candidates.get(key);
  if (
    !existing ||
    candidate.priority < existing.priority ||
    (candidate.priority === existing.priority && candidate.layerCount < existing.layerCount)
  ) {
    candidates.set(key, candidate);
  }
}

function candidateRatioKey(candidate: PatternCandidate): string {
  const bucket = Math.round(candidate.mixBPercent / PAIR_RATIO_BUCKET_PERCENT) * PAIR_RATIO_BUCKET_PERCENT;
  return `${candidate.componentA}:${candidate.componentB}:ratio:${bucket}`;
}

function mixPatternRgb(pattern: string, filaments: FilamentChannel[]): Rgb {
  const totals = pattern.split("").reduce(
    (acc, step) => {
      const filament = filaments[Number(step) - 1];
      if (!filament) {
        return acc;
      }
      acc.r += filament.rgb.r;
      acc.g += filament.rgb.g;
      acc.b += filament.rgb.b;
      acc.count += 1;
      return acc;
    },
    { r: 0, g: 0, b: 0, count: 0 },
  );
  const count = Math.max(1, totals.count);
  return {
    r: totals.r / count,
    g: totals.g / count,
    b: totals.b / count,
  };
}

function mixBPercent(pattern: string): number {
  const steps = pattern.split("");
  const bCount = steps.filter((step) => step === "2").length;
  return Math.round((bCount / Math.max(1, steps.length)) * 100);
}
