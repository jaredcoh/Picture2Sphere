import JSZip from "jszip";
import { canvasToPngBlob } from "./imageProcessing";
import { validateMesh } from "./sphereMesh";
import type { SphereMesh } from "./types";

export interface ObjEntry {
  name: string;
  mesh: SphereMesh;
}

export async function createObjTextureZip(
  entries: ObjEntry[],
  originalTexture: HTMLCanvasElement,
  filamentTexture: HTMLCanvasElement,
  useOriginalTexture: boolean,
): Promise<Blob> {
  const zip = new JSZip();
  const selectedTextureName = useOriginalTexture ? "texture_original.png" : "texture_filament.png";
  const mtl = buildMtl(selectedTextureName);

  for (const entry of entries) {
    const errors = validateMesh(entry.mesh);
    if (errors.length > 0) {
      throw new Error(`Mesh validation failed for ${entry.name}: ${errors.join(" ")}`);
    }
    const obj = buildObj(entry.mesh, `${entry.name}.mtl`, "panorama_texture");
    const objErrors = validateObj(obj, entry.mesh);
    if (objErrors.length > 0) {
      throw new Error(`OBJ validation failed for ${entry.name}: ${objErrors.join(" ")}`);
    }
    zip.file(`${entry.name}.obj`, obj);
    zip.file(`${entry.name}.mtl`, mtl);
  }

  zip.file("texture_original.png", await canvasToPngBlob(originalTexture));
  zip.file("texture_filament.png", await canvasToPngBlob(filamentTexture));
  zip.file(
    "README_OBJ_TEXTURE.txt",
    [
      "OBJ/MTL texture bundle exported by 360 panoramic image to 3D-Printable Sphere.",
      `The OBJ material references ${selectedTextureName}.`,
      "Both original and filament-simulated textures are included so downstream tools can be switched manually.",
      "OBJ texture support varies by slicer; Blender, Fusion, MeshLab, and conversion tools are usually more reliable than direct slicer import.",
    ].join("\n"),
  );

  return zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

function buildObj(mesh: SphereMesh, materialFile: string, materialName: string): string {
  const lines: string[] = [
    "# 360 panoramic image to 3D-Printable Sphere",
    `# Part: ${mesh.part}`,
    `mtllib ${materialFile}`,
    `o ${mesh.part}_panorama_sphere`,
  ];

  mesh.vertices.forEach((vertex) => {
    lines.push(`v ${round(vertex.x)} ${round(vertex.y)} ${round(vertex.z)}`);
  });

  mesh.vertices.forEach((vertex) => {
    lines.push(`vt ${round(vertex.u)} ${round(1 - vertex.v)}`);
  });

  lines.push(`usemtl ${materialName}`);
  mesh.triangles.forEach((triangle) => {
    const a = triangle.a + 1;
    const b = triangle.b + 1;
    const c = triangle.c + 1;
    lines.push(`f ${a}/${a} ${b}/${b} ${c}/${c}`);
  });

  return `${lines.join("\n")}\n`;
}

function buildMtl(textureName: string): string {
  return [
    "# 360 panoramic image to 3D-Printable Sphere",
    "newmtl panorama_texture",
    "Ka 1.000 1.000 1.000",
    "Kd 1.000 1.000 1.000",
    "Ks 0.000 0.000 0.000",
    "d 1.0",
    "illum 2",
    `map_Kd ${textureName}`,
    "",
  ].join("\n");
}

export function validateObj(obj: string, mesh: SphereMesh): string[] {
  const vertexCount = (obj.match(/^v /gm) ?? []).length;
  const uvCount = (obj.match(/^vt /gm) ?? []).length;
  const faceCount = (obj.match(/^f /gm) ?? []).length;
  const errors: string[] = [];

  if (vertexCount !== mesh.vertices.length) {
    errors.push(`OBJ vertex count ${vertexCount} does not match mesh vertex count ${mesh.vertices.length}.`);
  }
  if (uvCount !== mesh.vertices.length) {
    errors.push(`OBJ UV count ${uvCount} does not match mesh vertex count ${mesh.vertices.length}.`);
  }
  if (faceCount !== mesh.triangles.length) {
    errors.push(`OBJ face count ${faceCount} does not match mesh triangle count ${mesh.triangles.length}.`);
  }

  return errors;
}

function round(value: number): string {
  return Number(value.toFixed(6)).toString();
}
