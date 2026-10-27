import JSZip from "jszip";
import { validateMesh } from "./sphereMesh";
import type { MeshVertex, SphereMesh } from "./types";

export interface StlEntry {
  name: string;
  mesh: SphereMesh;
}

export function createStlBlob(entry: StlEntry): Blob {
  return new Blob([createStlArrayBuffer(entry)], { type: "model/stl" });
}

export async function createStlZip(entries: StlEntry[]): Promise<Blob> {
  const zip = new JSZip();

  entries.forEach((entry) => {
    zip.file(`${entry.name}.stl`, createStlArrayBuffer(entry));
  });

  return zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

function createStlArrayBuffer(entry: StlEntry): ArrayBuffer {
  const errors = validateMesh(entry.mesh);
  if (errors.length > 0) {
    throw new Error(`Mesh validation failed for ${entry.name}: ${errors.join(" ")}`);
  }

  const triangleCount = entry.mesh.triangles.length;
  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const view = new DataView(buffer);
  const header = `360 panoramic image to 3D-Printable Sphere ${entry.name}`.slice(0, 80);

  for (let i = 0; i < header.length; i += 1) {
    view.setUint8(i, header.charCodeAt(i));
  }
  view.setUint32(80, triangleCount, true);

  entry.mesh.triangles.forEach((triangle, index) => {
    const a = entry.mesh.vertices[triangle.a];
    const b = entry.mesh.vertices[triangle.b];
    const c = entry.mesh.vertices[triangle.c];
    const normal = faceNormal(a, b, c);
    let offset = 84 + index * 50;

    [normal.x, normal.y, normal.z, a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z].forEach((value) => {
      view.setFloat32(offset, value, true);
      offset += 4;
    });

    view.setUint16(offset, 0, true);
  });

  return buffer;
}

function faceNormal(a: MeshVertex, b: MeshVertex, c: MeshVertex): { x: number; y: number; z: number } {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const vx = c.x - a.x;
  const vy = c.y - a.y;
  const vz = c.z - a.z;
  const x = uy * vz - uz * vy;
  const y = uz * vx - ux * vz;
  const z = ux * vy - uy * vx;
  const length = Math.hypot(x, y, z) || 1;
  return {
    x: x / length,
    y: y / length,
    z: z / length,
  };
}
