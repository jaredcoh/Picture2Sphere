import type { FilamentChannel, FilamentRole, Rgb } from "./types";

export const FOURTH_CHANNELS = {
  white: { id: "white", name: "White PLA", hex: "#f7f2dc" },
  black: { id: "black", name: "Black PLA", hex: "#171717" },
} as const;

export type FilamentPreset = "black" | "white" | "blackWhite";

export function clamp(value: number, min = 0, max = 255): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeHex(hex: string): string {
  const trimmed = hex.trim();
  const raw = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw
      .split("")
      .map((ch) => ch + ch)
      .join("")
      .toUpperCase()}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) {
    return `#${raw.toUpperCase()}`;
  }
  return "#000000";
}

export function hexToRgb(hex: string): Rgb {
  const normalized = normalizeHex(hex).slice(1);
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

export function rgbToHex(rgb: Rgb): string {
  const toHex = (value: number) =>
    Math.round(clamp(value))
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`.toUpperCase();
}

export function createFilament(id: string, name: string, hex: string, role?: FilamentRole): FilamentChannel {
  const normalized = normalizeHex(hex);
  return {
    id,
    name,
    hex: normalized,
    rgb: hexToRgb(normalized),
    role: role ?? inferFilamentRole(id, name),
  };
}

export function inferFilamentRole(id: string, name: string): FilamentRole {
  const label = `${id} ${name}`.toLowerCase();
  if (/\bcyan\b/.test(label)) {
    return "cyan";
  }
  if (/\bmagenta\b/.test(label)) {
    return "magenta";
  }
  if (/\byellow\b/.test(label)) {
    return "yellow";
  }
  if (/\bblack\b/.test(label)) {
    return "black";
  }
  if (/\bwhite\b/.test(label)) {
    return "white";
  }
  return "custom";
}

export function createDefaultFilaments(preset: FilamentPreset = "white"): FilamentChannel[] {
  const base = [
    createFilament("cyan", "Cyan PLA", "#00A8E8"),
    createFilament("magenta", "Magenta PLA", "#D7267D"),
    createFilament("yellow", "Yellow PLA", "#FFD23F"),
  ];
  const fourthChannels =
    preset === "blackWhite"
      ? [FOURTH_CHANNELS.black, FOURTH_CHANNELS.white]
      : [FOURTH_CHANNELS[preset]];

  return [
    ...base,
    ...fourthChannels.map((filament) => createFilament(filament.id, filament.name, filament.hex)),
  ];
}

export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
}

export function colorDistance(a: Rgb, b: Rgb): number {
  const lumA = relativeLuminance(a);
  const lumB = relativeLuminance(b);
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  const dl = lumA - lumB;
  return dr * dr * 0.35 + dg * dg * 0.45 + db * db * 0.2 + dl * dl * 0.25;
}

export function nearestFilamentIndex(rgb: Rgb, filaments: FilamentChannel[]): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  filaments.forEach((filament, index) => {
    const distance = colorDistance(rgb, filament.rgb);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });

  return bestIndex;
}

export function applyColorAdjustments(
  input: Rgb,
  options: {
    brightness: number;
    contrast: number;
    saturation: number;
    gamma: number;
  },
): Rgb {
  const brightness = (options.brightness / 100) * 255;
  const contrast = options.contrast / 100;
  const saturation = options.saturation / 100;
  const gamma = Math.max(0.1, options.gamma);

  let r = (input.r - 128) * contrast + 128 + brightness;
  let g = (input.g - 128) * contrast + 128 + brightness;
  let b = (input.b - 128) * contrast + 128 + brightness;

  const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  r = gray + (r - gray) * saturation;
  g = gray + (g - gray) * saturation;
  b = gray + (b - gray) * saturation;

  return {
    r: clamp(255 * Math.pow(clamp(r) / 255, 1 / gamma)),
    g: clamp(255 * Math.pow(clamp(g) / 255, 1 / gamma)),
    b: clamp(255 * Math.pow(clamp(b) / 255, 1 / gamma)),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${Math.max(1, Math.round(bytes))} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function safeFileStamp(date = new Date()): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}
