import { applyColorAdjustments, nearestFilamentIndex } from "./colorUtils";
import { nearestPatternPaletteIndex, type FullSpectrumPattern } from "./fullSpectrumPatterns";
import type { FilamentChannel, ProcessingSettings, Rgb } from "./types";

export const MAX_SOURCE_EDGE = 4096;
export const DEFAULT_SAMPLE_DENSITY = 1024;
export const MAX_UPLOAD_IMAGE_BYTES = 24 * 1024 * 1024;
export const MAX_UPLOAD_IMAGE_PIXELS = 64 * 1024 * 1024;

export interface LoadedImageInfo {
  fileName: string;
  originalWidth: number;
  originalHeight: number;
  canvas: HTMLCanvasElement;
  aspectRatio: number;
  likelyPanorama: boolean;
  downscaled: boolean;
  warnings: string[];
}

export interface ProcessedTexture {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  modeLabel: string;
}

export function fitInside(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const edge = Math.max(width, height);
  if (edge <= maxEdge) {
    return { width, height };
  }
  const scale = maxEdge / edge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export async function loadImageFile(file: File): Promise<LoadedImageInfo> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    throw new Error("Upload a PNG, JPG, or WebP image.");
  }
  if (file.size > MAX_UPLOAD_IMAGE_BYTES) {
    throw new Error("Image is too large. Choose a PNG, JPG, or WebP smaller than 24 MB.");
  }

  const bitmap = await fileToBitmap(file);
  const originalWidth = bitmap.width;
  const originalHeight = bitmap.height;
  if (originalWidth * originalHeight > MAX_UPLOAD_IMAGE_PIXELS) {
    bitmap.close?.();
    throw new Error("Image dimensions are too large. Choose an image smaller than 64 megapixels.");
  }
  const target = fitInside(originalWidth, originalHeight, MAX_SOURCE_EDGE);
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;

  const context = get2dContext(canvas);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, target.width, target.height);
  bitmap.close?.();

  const aspectRatio = originalWidth / Math.max(1, originalHeight);
  const likelyPanorama = Math.abs(aspectRatio - 2) <= 0.12;
  const warnings: string[] = [];

  if (!likelyPanorama) {
    warnings.push(`Image ratio is ${aspectRatio.toFixed(2)}:1. Equirectangular panoramas are normally 2:1.`);
  }
  if (target.width !== originalWidth || target.height !== originalHeight) {
    warnings.push(`Image was resized to ${target.width} x ${target.height} for browser-safe processing.`);
  }

  return {
    fileName: file.name,
    originalWidth,
    originalHeight,
    canvas,
    aspectRatio,
    likelyPanorama,
    downscaled: target.width !== originalWidth || target.height !== originalHeight,
    warnings,
  };
}

async function fileToBitmap(file: File): Promise<ImageBitmap> {
  if ("createImageBitmap" in window) {
    return createImageBitmap(file, { imageOrientation: "from-image" });
  }

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    const url = URL.createObjectURL(file);
    element.onload = () => {
      URL.revokeObjectURL(url);
      resolve(element);
    };
    element.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode the image file."));
    };
    element.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  get2dContext(canvas).drawImage(image, 0, 0);
  return createImageBitmap(canvas);
}

export function cloneCanvasToDensity(source: HTMLCanvasElement, maxEdge: number): HTMLCanvasElement {
  const size = fitInside(source.width, source.height, maxEdge);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = get2dContext(canvas);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, size.width, size.height);
  return canvas;
}

export function wrapPanoramaCanvas(
  source: HTMLCanvasElement,
  offsetX: number,
  offsetY: number,
  imageRotationDeg = 0,
): HTMLCanvasElement {
  const rotated = rotateCanvasRightAngles(source, imageRotationDeg);
  const canvas = document.createElement("canvas");
  canvas.width = rotated.width;
  canvas.height = rotated.height;
  const context = get2dContext(canvas);
  drawWrappedPanorama(context, rotated, canvas.width, canvas.height, offsetX, offsetY);
  return canvas;
}

export function rotateCanvasRightAngles(source: HTMLCanvasElement, rotationDeg: number): HTMLCanvasElement {
  const normalized = ((Math.round(rotationDeg / 90) * 90) % 360 + 360) % 360;
  if (normalized === 0) {
    return source;
  }

  const swap = normalized === 90 || normalized === 270;
  const canvas = document.createElement("canvas");
  canvas.width = swap ? source.height : source.width;
  canvas.height = swap ? source.width : source.height;
  const context = get2dContext(canvas);

  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate((normalized * Math.PI) / 180);
  context.drawImage(source, -source.width / 2, -source.height / 2);

  return canvas;
}

export function drawWrappedPanorama(
  context: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
): void {
  const shiftX = positiveModulo(offsetX, 1) * width;
  const shiftY = positiveModulo(offsetY, 1) * height;
  const startX = shiftX - width;
  const startY = shiftY - height;

  context.clearRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";

  for (let y = startY; y < height; y += height) {
    for (let x = startX; x < width; x += width) {
      context.drawImage(source, x, y, width, height);
    }
  }
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

export function processTexture(
  source: HTMLCanvasElement,
  settings: ProcessingSettings,
  filaments: FilamentChannel[],
): ProcessedTexture {
  const started = performance.now();
  console.info("[SpherePanorama] Processing texture started.", {
    sourceWidth: source.width,
    sourceHeight: source.height,
    sampleDensity: settings.sampleDensity,
    mode: settings.mode,
    filamentCount: filaments.length,
  });
  const canvas = cloneCanvasToDensity(source, settings.sampleDensity);
  const context = get2dContext(canvas);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  const regionCache = new Map<string, Rgb>();
  const fullSpectrumRgbCache = new Map<string, Rgb>();

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const offset = (y * canvas.width + x) * 4;
      let adjusted = applyColorAdjustments(
        { r: data[offset], g: data[offset + 1], b: data[offset + 2] },
        settings,
      );

      if (settings.mode === "nearest" || settings.mode === "dither") {
        const regionTarget =
          settings.mode === "dither"
            ? getAdjustedRegionTarget(data, canvas.width, canvas.height, x, y, settings, regionCache)
            : adjusted;
        const rgb =
          settings.mode === "dither"
            ? fullSpectrumLayerRgb(regionTarget, x, y, filaments, settings.ditherStrength, settings, fullSpectrumRgbCache)
            : filaments[nearestFilamentIndex(regionTarget, filaments)].rgb;
        data[offset] = rgb.r;
        data[offset + 1] = rgb.g;
        data[offset + 2] = rgb.b;
      } else {
        data[offset] = adjusted.r;
        data[offset + 1] = adjusted.g;
        data[offset + 2] = adjusted.b;
      }

      data[offset + 3] = 255;
    }
  }

  context.putImageData(imageData, 0, 0);
  console.info("[SpherePanorama] Processing texture finished.", {
    width: canvas.width,
    height: canvas.height,
    elapsedMs: Math.round(performance.now() - started),
    cachedRegions: regionCache.size,
    cachedFullSpectrumColors: fullSpectrumRgbCache.size,
  });

  return {
    canvas,
    width: canvas.width,
    height: canvas.height,
    modeLabel:
      settings.mode === "dither"
        ? "FullSpectrum filament"
        : settings.mode === "nearest"
          ? "Nearest filament"
          : "Full texture",
  };
}

export function createGeneratedColorTexture(
  source: HTMLCanvasElement,
  settings: ProcessingSettings,
  palette: Rgb[],
): ProcessedTexture {
  const canvas = cloneCanvasToDensity(source, settings.sampleDensity);
  const context = get2dContext(canvas);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const offset = (y * canvas.width + x) * 4;
      const adjusted = applyColorAdjustments(
        { r: data[offset], g: data[offset + 1], b: data[offset + 2] },
        settings,
      );
      const generated = palette.length > 0 ? palette[nearestPatternPaletteIndex(adjusted, palette)] : adjusted;

      data[offset] = generated.r;
      data[offset + 1] = generated.g;
      data[offset + 2] = generated.b;
      data[offset + 3] = 255;
    }
  }

  context.putImageData(imageData, 0, 0);

  return {
    canvas,
    width: canvas.width,
    height: canvas.height,
    modeLabel: "Generated color sphere",
  };
}

export function simulateFullSpectrumPrintedTexture(
  source: HTMLCanvasElement,
  diameterMm: number,
  layerHeightMm: number,
  filaments: FilamentChannel[],
  patterns: FullSpectrumPattern[],
): ProcessedTexture {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const sourceContext = get2dContext(source);
  const sourceData = sourceContext.getImageData(0, 0, source.width, source.height);
  const context = get2dContext(canvas);
  const output = context.createImageData(canvas.width, canvas.height);
  const radius = diameterMm / 2;
  const safeLayerHeight = Math.max(0.04, layerHeightMm);
  const palette = [...filaments.map((filament) => filament.rgb), ...patterns.map((pattern) => pattern.rgb)];

  for (let y = 0; y < canvas.height; y += 1) {
    const v = y / Math.max(1, canvas.height - 1);
    const modelY = radius * Math.cos(v * Math.PI);
    const layer = Math.floor((modelY + radius) / safeLayerHeight);
    const nextV = Math.min(1, (y + 1) / Math.max(1, canvas.height - 1));
    const nextLayer = Math.floor((radius * Math.cos(nextV * Math.PI) + radius) / safeLayerHeight);
    const lineDarken = nextLayer !== layer ? 0.72 : 1;

    for (let x = 0; x < canvas.width; x += 1) {
      const sourceOffset = (y * canvas.width + x) * 4;
      const targetOffset = (y * canvas.width + x) * 4;
      const colorIndex = nearestPatternPaletteIndex(
        {
          r: sourceData.data[sourceOffset],
          g: sourceData.data[sourceOffset + 1],
          b: sourceData.data[sourceOffset + 2],
        },
        palette,
      );
      const rgb = physicalRgbForGeneratedColor(colorIndex, layer, filaments, patterns);

      output.data[targetOffset] = rgb.r * lineDarken;
      output.data[targetOffset + 1] = rgb.g * lineDarken;
      output.data[targetOffset + 2] = rgb.b * lineDarken;
      output.data[targetOffset + 3] = 255;
    }
  }

  context.putImageData(output, 0, 0);

  return {
    canvas,
    width: canvas.width,
    height: canvas.height,
    modeLabel: "FullSpectrum print preview",
  };
}

export function simulatePrintedLayerTexture(
  source: HTMLCanvasElement,
  diameterMm: number,
  layerHeightMm: number,
): ProcessedTexture {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const sourceContext = get2dContext(source);
  const sourceData = sourceContext.getImageData(0, 0, source.width, source.height);
  const context = get2dContext(canvas);
  const output = context.createImageData(canvas.width, canvas.height);
  const radius = diameterMm / 2;
  const safeLayerHeight = Math.max(0.04, layerHeightMm);
  const layerRows = new Map<number, number>();

  for (let y = 0; y < canvas.height; y += 1) {
    const v = y / Math.max(1, canvas.height - 1);
    const modelY = radius * Math.cos(v * Math.PI);
    const layer = Math.floor((modelY + radius) / safeLayerHeight);
    if (!layerRows.has(layer)) {
      layerRows.set(layer, y);
    }
  }

  for (let y = 0; y < canvas.height; y += 1) {
    const v = y / Math.max(1, canvas.height - 1);
    const modelY = radius * Math.cos(v * Math.PI);
    const layer = Math.floor((modelY + radius) / safeLayerHeight);
    const sampleY = layerRows.get(layer) ?? y;
    const nextV = Math.min(1, (y + 1) / Math.max(1, canvas.height - 1));
    const nextLayer = Math.floor((radius * Math.cos(nextV * Math.PI) + radius) / safeLayerHeight);
    const lineDarken = nextLayer !== layer ? 0.72 : 1;

    for (let x = 0; x < canvas.width; x += 1) {
      const sourceOffset = (sampleY * canvas.width + x) * 4;
      const targetOffset = (y * canvas.width + x) * 4;
      output.data[targetOffset] = sourceData.data[sourceOffset] * lineDarken;
      output.data[targetOffset + 1] = sourceData.data[sourceOffset + 1] * lineDarken;
      output.data[targetOffset + 2] = sourceData.data[sourceOffset + 2] * lineDarken;
      output.data[targetOffset + 3] = 255;
    }
  }

  context.putImageData(output, 0, 0);

  return {
    canvas,
    width: canvas.width,
    height: canvas.height,
    modeLabel: "Printed layer simulation",
  };
}

function getAdjustedRegionTarget(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  settings: ProcessingSettings,
  cache: Map<string, Rgb>,
): Rgb {
  const regionSize = Math.max(2, Math.round(settings.sampleDensity / 480));
  const regionX = Math.floor(x / regionSize);
  const regionY = Math.floor(y / regionSize);
  const key = `${regionX}:${regionY}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const startX = regionX * regionSize;
  const startY = regionY * regionSize;
  const endX = Math.min(width, startX + regionSize);
  const endY = Math.min(height, startY + regionSize);
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (let sampleY = startY; sampleY < endY; sampleY += 1) {
    for (let sampleX = startX; sampleX < endX; sampleX += 1) {
      const offset = (sampleY * width + sampleX) * 4;
      r += data[offset];
      g += data[offset + 1];
      b += data[offset + 2];
      count += 1;
    }
  }

  const adjusted = applyColorAdjustments(
    {
      r: r / Math.max(1, count),
      g: g / Math.max(1, count),
      b: b / Math.max(1, count),
    },
    settings,
  );
  cache.set(key, adjusted);
  return adjusted;
}

function physicalRgbForGeneratedColor(
  colorIndex: number,
  layer: number,
  filaments: FilamentChannel[],
  patterns: FullSpectrumPattern[],
): Rgb {
  if (colorIndex < filaments.length) {
    return filaments[colorIndex]?.rgb ?? { r: 0, g: 0, b: 0 };
  }

  const pattern = patterns[colorIndex - filaments.length];
  if (!pattern || pattern.expandedPattern.length === 0) {
    return filaments[0]?.rgb ?? { r: 0, g: 0, b: 0 };
  }

  const step = pattern.expandedPattern[Math.abs(layer) % pattern.expandedPattern.length];
  const filamentIndex = Math.min(Math.max(Number(step) - 1, 0), Math.max(0, filaments.length - 1));
  return filaments[filamentIndex]?.rgb ?? { r: 0, g: 0, b: 0 };
}

function fullSpectrumLayerRgb(
  target: Rgb,
  x: number,
  y: number,
  filaments: FilamentChannel[],
  strength: number,
  settings?: ProcessingSettings,
  cache?: Map<string, Rgb>,
): Rgb {
  const layerCount = Math.max(
    16,
    Math.round((settings?.fullSpectrumDiameterMm ?? 80) / Math.max(0.04, settings?.fullSpectrumLayerHeightMm ?? 0.2)),
  );
  const textureLayer = Math.floor((y / Math.max(1, settings?.sampleDensity ?? 1024)) * layerCount);
  const cacheKey = `${Math.round(target.r / 4)},${Math.round(target.g / 4)},${Math.round(target.b / 4)}:${textureLayer}`;
  const cached = cache?.get(cacheKey);
  if (cached) {
    return cached;
  }

  const weights = estimateFullSpectrumWeights(target, filaments, settings?.fullSpectrumComboColors ?? 0);
  const phase = textureLayer % layerCount;
  const layerFilament = chooseWeightedLayer(weights, phase, layerCount, strength);
  const rgb = filaments[layerFilament].rgb;
  cache?.set(cacheKey, rgb);
  return rgb;
}

function estimateFullSpectrumWeights(target: Rgb, filaments: FilamentChannel[], comboColors: number): number[] {
  const normalized = {
    r: target.r / 255,
    g: target.g / 255,
    b: target.b / 255,
  };
  const cyanIndex = filaments.findIndex((filament) => filament.role === "cyan");
  const magentaIndex = filaments.findIndex((filament) => filament.role === "magenta");
  const yellowIndex = filaments.findIndex((filament) => filament.role === "yellow");
  const blackIndex = filaments.findIndex((filament) => filament.role === "black");
  const whiteIndex = filaments.findIndex((filament) => filament.role === "white");
  const raw = Array.from({ length: filaments.length }, () => 0);
  const c = 1 - normalized.r;
  const m = 1 - normalized.g;
  const y = 1 - normalized.b;

  if (cyanIndex < 0 || magentaIndex < 0 || yellowIndex < 0) {
    raw[nearestFilamentIndex(target, filaments)] = 1;
  } else if (blackIndex >= 0) {
    const grayComponent = Math.min(c, m, y);
    const darkness = 1 - Math.max(normalized.r, normalized.g, normalized.b);
    const k = Math.max(0, Math.min(grayComponent, darkness) * 0.65);
    raw[blackIndex] = k;
    raw[cyanIndex] = Math.max(0, c - k * 0.85);
    raw[magentaIndex] = Math.max(0, m - k * 0.85);
    raw[yellowIndex] = Math.max(0, y - k * 0.85);
  } else {
    raw[cyanIndex] = Math.max(0, c);
    raw[magentaIndex] = Math.max(0, m);
    raw[yellowIndex] = Math.max(0, y);
  }

  if (whiteIndex >= 0) {
    const highlight = Math.min(normalized.r, normalized.g, normalized.b);
    raw[whiteIndex] = Math.max(0, highlight * (blackIndex >= 0 ? 0.45 : 1));
  }

  const baseWeights = normalizeWeights(raw, filaments);
  const combo = findBestVirtualCombo(target, filaments, comboColors, baseWeights);
  return combo ?? baseWeights;
}

function findBestVirtualCombo(
  target: Rgb,
  filaments: FilamentChannel[],
  comboColors: number,
  baseWeights: number[],
): number[] | null {
  if (comboColors <= 0) {
    return null;
  }

  const candidates = [baseWeights, ...getCachedVirtualCombos(filaments.length, comboColors)];
  let bestWeights: number[] | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  candidates.forEach((weights) => {
    const mixed = mixWeights(weights, filaments);
    const distance = rgbDistance(target, mixed);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestWeights = weights;
    }
  });

  return bestWeights;
}

const virtualComboCache = new Map<string, number[][]>();

function getCachedVirtualCombos(channelCount: number, comboColors: number): number[][] {
  const key = `${channelCount}:${comboColors}`;
  const cached = virtualComboCache.get(key);
  if (cached) {
    return cached;
  }

  const combos = generateVirtualCombos(channelCount, comboColors);
  virtualComboCache.set(key, combos);
  return combos;
}

function generateVirtualCombos(channelCount: number, comboColors: number): number[][] {
  const combos = new Map<string, number[]>();
  const add = (weights: number[]) => {
    const normalized = normalizeWeightArray(weights);
    combos.set(normalized.map((value) => value.toFixed(3)).join(","), normalized);
  };

  const denominators = [4, 6, 8, 12, 16, 24, 32];
  for (const denominator of denominators) {
    for (let a = 0; a < channelCount; a += 1) {
      for (let b = a; b < channelCount; b += 1) {
        for (let aParts = 0; aParts <= denominator; aParts += 1) {
          const weights = Array.from({ length: channelCount }, () => 0);
          weights[a] += aParts / denominator;
          weights[b] += (denominator - aParts) / denominator;
          add(weights);
          if (combos.size >= comboColors + 1) {
            return [...combos.values()];
          }
        }
      }
    }

    for (let c = 0; c <= denominator; c += 1) {
      for (let m = 0; m <= denominator - c; m += 1) {
        for (let y = 0; y <= denominator - c - m; y += 1) {
          const k = denominator - c - m - y;
          add([c / denominator, m / denominator, y / denominator, k / denominator].slice(0, channelCount));
          if (combos.size >= comboColors + 1) {
            return [...combos.values()];
          }
        }
      }
    }
  }

  return [...combos.values()];
}

function normalizeWeightArray(weights: number[]): number[] {
  const total = weights.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0.0001) {
    return weights.map((_, index) => (index === 0 ? 1 : 0));
  }
  return weights.map((value) => Math.max(0, value) / total);
}

function mixWeights(weights: number[], filaments: FilamentChannel[]): Rgb {
  return filaments.reduce(
    (acc, filament, index) => ({
      r: acc.r + filament.rgb.r * (weights[index] ?? 0),
      g: acc.g + filament.rgb.g * (weights[index] ?? 0),
      b: acc.b + filament.rgb.b * (weights[index] ?? 0),
    }),
    { r: 0, g: 0, b: 0 },
  );
}

function rgbDistance(a: Rgb, b: Rgb): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr * 0.35 + dg * dg * 0.45 + db * db * 0.2;
}

function normalizeWeights(weights: number[], filaments: FilamentChannel[]): number[] {
  const available = filaments.map((_, index) => Math.max(0, weights[index] ?? 0));
  const total = available.reduce((sum, value) => sum + value, 0);
  if (total <= 0.0001) {
    return filaments.map((_, index) => (index === nearestFilamentIndex({ r: 255, g: 255, b: 255 }, filaments) ? 1 : 0));
  }
  return available.map((value) => value / total);
}

function chooseWeightedLayer(weights: number[], phase: number, layerCount: number, strength: number): number {
  const slots = Math.max(4, Math.min(64, Math.round(layerCount * Math.max(0.08, strength))));
  const slot = (phase * 37) % slots;
  let cumulative = 0;

  for (let index = 0; index < weights.length; index += 1) {
    cumulative += weights[index] * slots;
    if (slot < cumulative) {
      return index;
    }
  }

  return weights.length - 1;
}

export function createPlaceholderPanorama(width = 1024, height = 512): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = get2dContext(canvas);
  const image = context.createImageData(width, height);

  for (let y = 0; y < height; y += 1) {
    const lat = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x += 1) {
      const lon = x / Math.max(1, width - 1);
      const offset = (y * width + x) * 4;
      const horizon = Math.exp(-Math.pow((lat - 0.52) * 5, 2));
      image.data[offset] = 32 + 160 * lon + 32 * horizon;
      image.data[offset + 1] = 78 + 122 * (1 - Math.abs(lat - 0.5)) + 24 * Math.sin(lon * Math.PI * 6);
      image.data[offset + 2] = 168 + 62 * (1 - lat) + 35 * Math.cos(lon * Math.PI * 4);
      image.data[offset + 3] = 255;
    }
  }

  context.putImageData(image, 0, 0);
  context.globalAlpha = 0.28;
  context.strokeStyle = "#ffffff";
  context.lineWidth = 2;
  for (let x = 0; x <= width; x += width / 8) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
  for (let y = 0; y <= height; y += height / 4) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }

  context.globalAlpha = 1;
  context.fillStyle = "rgba(0, 0, 0, 0.48)";
  context.fillRect(28, 28, 384, 76);
  context.fillStyle = "#ffffff";
  context.font = "600 28px system-ui, sans-serif";
  context.fillText("Sample 2:1 Panorama", 52, 72);
  context.font = "16px system-ui, sans-serif";
  context.fillText("Upload a PNG, JPG, or WebP to replace it", 52, 96);

  return canvas;
}

export function get2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Browser canvas 2D context is unavailable.");
  }
  return context;
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Could not encode PNG texture."));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}
