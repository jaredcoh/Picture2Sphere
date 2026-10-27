import { nearestPatternPaletteIndex } from "./fullSpectrumPatterns";
import { get2dContext } from "./imageProcessing";
import { triangleSampleUv } from "./sphereMesh";
import type { MeshTriangle, MeshVertex, Rgb, RotationDeg, SphereMesh } from "./types";

interface OrientationCandidate {
  label: string;
  rotation: RotationDeg;
}

export interface OrientationResult extends OrientationCandidate {
  score: number;
}

const CANDIDATES: OrientationCandidate[] = [
  { label: "Natural panorama axis", rotation: { x: 0, y: 0, z: 0 } },
  { label: "Tilt forward 90 deg", rotation: { x: 90, y: 0, z: 0 } },
  { label: "Tilt backward 90 deg", rotation: { x: -90, y: 0, z: 0 } },
  { label: "Roll right 90 deg", rotation: { x: 0, y: 0, z: 90 } },
  { label: "Roll left 90 deg", rotation: { x: 0, y: 0, z: -90 } },
  { label: "Yaw 90 deg", rotation: { x: 0, y: 90, z: 0 } },
  { label: "Yaw 180 deg", rotation: { x: 0, y: 180, z: 0 } },
];

export function getOrientationCandidates(): OrientationCandidate[] {
  return CANDIDATES;
}

export function chooseBestOrientation(
  meshes: SphereMesh[],
  textureCanvas: HTMLCanvasElement,
  palette: Rgb[],
): OrientationResult {
  return CANDIDATES.map((candidate) => ({
    ...candidate,
    score: estimateColorChangeScore(meshes, textureCanvas, palette, candidate.rotation),
  })).sort((a, b) => a.score - b.score)[0];
}

export function estimateColorChangeScore(
  meshes: SphereMesh[],
  textureCanvas: HTMLCanvasElement,
  palette: Rgb[],
  rotation: RotationDeg,
): number {
  const context = get2dContext(textureCanvas);
  const image = context.getImageData(0, 0, textureCanvas.width, textureCanvas.height);
  const bands = new Map<number, Array<{ angle: number; color: number }>>();
  const bandCount = 72;

  meshes.forEach((mesh) => {
    const radius = mesh.settings.diameterMm / 2;
    mesh.triangles.forEach((triangle) => {
      if (triangle.surface !== "outer") {
        return;
      }

      const centroid = rotatePoint(triangleCentroid(mesh, triangle), rotation);
      const band = Math.min(
        bandCount - 1,
        Math.max(0, Math.floor(((centroid.z + radius) / Math.max(1, radius * 2)) * bandCount)),
      );
      const uv = triangleSampleUv(mesh, triangle);
      const x = Math.min(textureCanvas.width - 1, Math.max(0, Math.floor(uv.u * textureCanvas.width)));
      const y = Math.min(textureCanvas.height - 1, Math.max(0, Math.floor(uv.v * textureCanvas.height)));
      const offset = (y * textureCanvas.width + x) * 4;
      const color = nearestPatternPaletteIndex(
        { r: image.data[offset], g: image.data[offset + 1], b: image.data[offset + 2] },
        palette,
      );
      const entries = bands.get(band) ?? [];
      entries.push({ angle: Math.atan2(centroid.y, centroid.x), color });
      bands.set(band, entries);
    });
  });

  let score = 0;
  bands.forEach((entries) => {
    if (entries.length < 2) {
      return;
    }

    entries.sort((a, b) => a.angle - b.angle);
    const uniqueColors = new Set(entries.map((entry) => entry.color)).size;
    let transitions = 0;

    for (let index = 1; index < entries.length; index += 1) {
      if (entries[index].color !== entries[index - 1].color) {
        transitions += 1;
      }
    }
    if (entries[0].color !== entries[entries.length - 1].color) {
      transitions += 1;
    }

    score += transitions + uniqueColors * 2;
  });

  return Math.round(score);
}

export function applyMeshRotation(mesh: SphereMesh, rotation: RotationDeg): SphereMesh {
  if (rotation.x === 0 && rotation.y === 0 && rotation.z === 0) {
    return mesh;
  }

  return {
    ...mesh,
    vertices: mesh.vertices.map((vertex) => ({
      ...vertex,
      ...rotatePoint(vertex, rotation),
    })),
  };
}

function triangleCentroid(mesh: SphereMesh, triangle: MeshTriangle): { x: number; y: number; z: number } {
  const a = mesh.vertices[triangle.a];
  const b = mesh.vertices[triangle.b];
  const c = mesh.vertices[triangle.c];
  return {
    x: (a.x + b.x + c.x) / 3,
    y: (a.y + b.y + c.y) / 3,
    z: (a.z + b.z + c.z) / 3,
  };
}

function rotatePoint(point: Pick<MeshVertex, "x" | "y" | "z">, rotation: RotationDeg): { x: number; y: number; z: number } {
  const rx = degreesToRadians(rotation.x);
  const ry = degreesToRadians(rotation.y);
  const rz = degreesToRadians(rotation.z);

  let { x, y, z } = point;

  const cosX = Math.cos(rx);
  const sinX = Math.sin(rx);
  [y, z] = [y * cosX - z * sinX, y * sinX + z * cosX];

  const cosY = Math.cos(ry);
  const sinY = Math.sin(ry);
  [x, z] = [x * cosY + z * sinY, -x * sinY + z * cosY];

  const cosZ = Math.cos(rz);
  const sinZ = Math.sin(rz);
  [x, y] = [x * cosZ - y * sinZ, x * sinZ + y * cosZ];

  return { x, y, z };
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}
