export type ResolutionLevel = "draft" | "standard" | "high" | "ultra";
export type FlatBaseMode = "none" | "small" | "large" | "pedestal";
export type SplitMode = "full" | "hemispheres";
export type MeshPart = "full" | "top" | "bottom" | "pedestal";
export type ProcessingMode = "nearest" | "dither" | "fullTexture";
export type PreviewMode = "photo" | "original" | "filament" | "printed";
export type OrientationMode = "auto" | "manual";
export type ExportProfile = "bambuOrca" | "snapmakerOrca" | "texture3mf" | "standard3mf";

export interface RotationDeg {
  x: number;
  y: number;
  z: number;
}

export interface SphereSettings {
  diameterMm: number;
  resolution: ResolutionLevel;
  hollow: boolean;
  wallThicknessMm: number;
  layerHeightMm: number;
  flatBase: FlatBaseMode;
  pedestalWidthMm: number;
  pedestalLengthMm: number;
  pedestalHeightMm: number;
  splitMode: SplitMode;
  orientationMode: OrientationMode;
  rotationDeg: RotationDeg;
}

export interface ProcessingSettings {
  mode: ProcessingMode;
  brightness: number;
  contrast: number;
  saturation: number;
  gamma: number;
  ditherStrength: number;
  fullSpectrumComboColors: number;
  fullSpectrumPatternCount: number;
  sampleDensity: number;
  fullSpectrumDiameterMm?: number;
  fullSpectrumLayerHeightMm?: number;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export type FilamentRole = "cyan" | "magenta" | "yellow" | "black" | "white" | "custom";

export interface FilamentChannel {
  id: string;
  name: string;
  hex: string;
  rgb: Rgb;
  role: FilamentRole;
}

export interface MeshVertex {
  x: number;
  y: number;
  z: number;
  u: number;
  v: number;
  surface: "outer" | "inner" | "cap";
}

export interface MeshTriangle {
  a: number;
  b: number;
  c: number;
  surface: "outer" | "inner" | "cap";
}

export interface SphereMesh {
  vertices: MeshVertex[];
  triangles: MeshTriangle[];
  part: MeshPart;
  settings: SphereSettings;
  longitudeSegments: number;
  latitudeSegments: number;
}

export interface MeshStats {
  vertices: number;
  triangles: number;
  diameterMm: number;
  textureWidth: number;
  textureHeight: number;
  estimatedColorMeshBytes: number;
}
