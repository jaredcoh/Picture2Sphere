import JSZip from "jszip";
import { rgbToHex } from "./colorUtils";
import {
  fullSpectrumPatternDefinitions,
  nearestPatternPaletteIndex,
  type FullSpectrumPattern,
} from "./fullSpectrumPatterns";
import { canvasToPngBlob, get2dContext } from "./imageProcessing";
import { triangleSampleUv, validateMesh } from "./sphereMesh";
import { transformTextureUv, type TextureUv } from "./textureMapping";
import type { ExportProfile, FilamentChannel, ProcessingMode, Rgb, RotationDeg, SphereMesh, SphereSettings } from "./types";

export interface ThreeMfEntry {
  name: string;
  mesh: SphereMesh;
  colorMode?: "paintedSurface" | "singleColor";
  singleColorIndex?: number;
}

export interface ThreeMfOptions {
  filaments: FilamentChannel[];
  textureCanvas: HTMLCanvasElement;
  settings: SphereSettings;
  processingMode: ProcessingMode;
  exportRotationDeg: RotationDeg;
  textureRotationDeg?: number;
  pedestalColorRgb?: Rgb;
  pedestalFilamentIndex?: number;
  exportProfile: ExportProfile;
  fullSpectrumPatterns?: FullSpectrumPattern[];
}

interface ThreeMfModelPackage {
  rootModelXml: string;
  objectModelFiles: Array<{ fileName: string; xml: string }>;
}

interface TriangleTextureMapping {
  coordinates: TextureUv[];
  triangleCoordinateIndices: Array<[number, number, number]>;
}

export async function create3mfBlob(entries: ThreeMfEntry | ThreeMfEntry[], options: ThreeMfOptions): Promise<Blob> {
  const bytes = await create3mfBytes(Array.isArray(entries) ? entries : [entries], options);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: "model/3mf" });
}

export async function create3mfSplitZip(entries: ThreeMfEntry[], options: ThreeMfOptions): Promise<Blob> {
  const zip = new JSZip();

  for (const entry of entries) {
    const bytes = await create3mfBytes([entry], options);
    zip.file(`${entry.name}.3mf`, bytes);
  }

  return zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

async function create3mfBytes(entries: ThreeMfEntry[], options: ThreeMfOptions): Promise<Uint8Array> {
  const printableEntries = createPrintableEntries(entries, options);

  printableEntries.forEach((entry) => {
    const meshErrors = validateMesh(entry.mesh);
    if (meshErrors.length > 0) {
      throw new Error(`Mesh validation failed for ${entry.name}: ${meshErrors.join(" ")}`);
    }
  });

  const normalizedEntries = normalizeEntriesToBuildPlate(printableEntries);
  const modelPackage = build3mfModelPackage(normalizedEntries, options);
  const xmlErrors = validate3mfPackage(modelPackage);
  if (xmlErrors.length > 0) {
    throw new Error(`3MF XML validation failed: ${xmlErrors.join(" ")}`);
  }

  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypesXml());
  zip.folder("_rels")?.file(".rels", relationshipsXml());
  zip.folder("3D")?.file("3dmodel.model", modelPackage.rootModelXml);
  modelPackage.objectModelFiles.forEach((file) => {
    zip.folder("3D")?.folder("Objects")?.file(file.fileName, file.xml);
  });
  if (options.exportProfile === "texture3mf") {
    zip.folder("3D")?.folder("Textures")?.file("panorama_texture.png", await canvasToPngBlob(options.textureCanvas));
  }
  if (options.exportProfile !== "standard3mf" && options.exportProfile !== "texture3mf") {
    zip.folder("Metadata")?.file("project_settings.config", buildProjectSettingsConfig(options));
    zip.folder("Metadata")?.file("model_settings.config", buildModelSettingsConfig(normalizedEntries, options.exportProfile));
    if ((options.fullSpectrumPatterns?.length ?? 0) > 0) {
      zip.folder("Metadata")?.file("fullspectrum_patterns.json", buildFullSpectrumPatternManifest(options));
    }
  }

  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

function createPrintableEntries(entries: ThreeMfEntry[], options: ThreeMfOptions): ThreeMfEntry[] {
  if (options.exportProfile === "texture3mf") {
    return entries;
  }

  return entries.map((entry): ThreeMfEntry => {
    if (entry.mesh.part === "pedestal") {
      return { ...entry, colorMode: "singleColor", singleColorIndex: options.pedestalFilamentIndex ?? 0 };
    }

    if (options.settings.hollow) {
      return {
        name: `${entry.name}_hollow_color_shell`,
        mesh: entry.mesh,
        colorMode: "paintedSurface",
      };
    }

    return {
      name: `${entry.name}_solid_infill_sphere`,
      mesh: entry.mesh,
      colorMode: "paintedSurface",
    };
  });
}

function normalizeEntriesToBuildPlate(entries: ThreeMfEntry[]): ThreeMfEntry[] {
  const minY = entries.reduce((entryMin, entry) => {
    const meshMin = entry.mesh.vertices.reduce(
      (vertexMin, vertex) => Math.min(vertexMin, vertex.y),
      Number.POSITIVE_INFINITY,
    );
    return Math.min(entryMin, meshMin);
  }, Number.POSITIVE_INFINITY);

  if (!Number.isFinite(minY) || Math.abs(minY) < 0.00001) {
    return entries;
  }

  return entries.map((entry) => ({
    ...entry,
    mesh: {
      ...entry.mesh,
      vertices: entry.mesh.vertices.map((vertex) => ({
        ...vertex,
        y: vertex.y - minY,
      })),
    },
  }));
}

function buildExportPalette(options: ThreeMfOptions, isTextureExport: boolean): Rgb[] {
  if (isTextureExport) {
    return [options.pedestalColorRgb ?? { r: 220, g: 220, b: 220 }];
  }

  return [
    ...options.filaments.map((filament) => filament.rgb),
    ...(options.fullSpectrumPatterns ?? []).map((pattern) => pattern.rgb),
  ];
}

function build3mfModelXml(entries: ThreeMfEntry[], options: ThreeMfOptions): string {
  const isTextureExport = options.exportProfile === "texture3mf";
  const needsColorGroup = !isTextureExport || entries.some((entry) => entry.mesh.part === "pedestal");
  const palette = buildExportPalette(options, isTextureExport);
  const pedestalColorIndex = isTextureExport
    ? 0
    : options.pedestalFilamentIndex !== undefined
      ? clampColorIndex(options.pedestalFilamentIndex, palette.length)
      : options.pedestalColorRgb
      ? nearestPatternPaletteIndex(options.pedestalColorRgb, palette)
      : 0;
  const created = new Date().toISOString();
  const colorGroupId = 1;

  const colorLines = palette.map((rgb) => {
    const hex = rgbToHex(rgb);
    return `<m:color color="${hex}FF"/>`;
  });
  const colorGroupResource = needsColorGroup
    ? `<m:colorgroup id="${colorGroupId}">
      ${colorLines.join("\n      ")}
    </m:colorgroup>`
    : "";
  const textureResource =
    isTextureExport
      ? `<t:texture2d id="10" path="/3D/Textures/panorama_texture.png" contenttype="image/png" tilestyleu="wrap" tilestylev="wrap"/>`
      : "";

  const metadata = [
    ["Title", isTextureExport ? "360 panoramic image texture on 3D-Printable Sphere" : "360 panoramic image to 3D-Printable Sphere color mesh"],
    ["Application", applicationName(options.exportProfile)],
    ["CreationDate", created],
    ["Generator", "360 panoramic image to 3D-Printable Sphere"],
    ["DiameterMm", options.settings.diameterMm.toString()],
    ["Resolution", options.settings.resolution],
    ["ColorSource", isTextureExport ? "EmbeddedTextureImage" : "TriangleFilamentColors"],
    ...(isTextureExport
      ? [["PrintSettings", "SlicerControlled"]]
      : [["FilamentMode", options.processingMode === "dither" ? "FullSpectrum" : options.processingMode]]),
    ...(!isTextureExport ? [["FullSpectrumPatterns", (options.fullSpectrumPatterns?.length ?? 0).toString()]] : []),
    ["TextureAxisRotationDeg", (options.textureRotationDeg ?? 0).toString()],
    ["Parts", entries.map((entry) => entry.mesh.part).join(", ")],
    ["Hollow", options.settings.hollow ? "true" : "false"],
    ["WallThicknessMm", options.settings.wallThicknessMm.toString()],
    ["LayerHeightMm", options.settings.layerHeightMm.toString()],
    ["FlatBase", options.settings.flatBase],
    ["OrientationMode", options.settings.orientationMode],
    ["ExportRotationDeg", `X ${options.exportRotationDeg.x}, Y ${options.exportRotationDeg.y}, Z ${options.exportRotationDeg.z}`],
  ];

  const objectBlocks = entries.map((entry, entryIndex) => {
    const objectId = objectIdForIndex(entryIndex);
    const useTexture = isTextureExport && entry.mesh.part !== "pedestal";
    const textureGroupId = 100 + entryIndex;
    const textureMapping = useTexture ? buildTriangleTextureMapping(entry.mesh, options.textureRotationDeg ?? 0) : null;
    const colorIndices = useTexture
      ? []
      : assignTriangleColorIndices(
          entry.mesh,
          options.textureCanvas,
          palette,
          pedestalColorIndex,
          options.textureRotationDeg ?? 0,
        );
    const textureCoords = useTexture
      ? `<t:texture2dgroup id="${textureGroupId}" texid="10">
      ${textureMapping?.coordinates
        .map((coordinate) => `<t:tex2coord u="${round(coordinate.u)}" v="${round(coordinate.v)}"/>`)
        .join("\n      ")}
    </t:texture2dgroup>`
      : "";
    const vertexLines = entry.mesh.vertices.map(
      (vertex) =>
        `<vertex x="${round(vertex.x)}" y="${round(vertex.y)}" z="${round(vertex.z)}"/>`,
    );
    const triangleLines = entry.mesh.triangles.map((triangle, index) => {
      const unpaintedTriangle = `<triangle v1="${triangle.a}" v2="${triangle.b}" v3="${triangle.c}"/>`;
      const shouldPaint =
        entry.colorMode === "singleColor" ||
        entry.mesh.part === "pedestal" ||
        triangle.surface === "outer" ||
        shouldPaintInteriorShell(entry, options);
      if (!shouldPaint) {
        return unpaintedTriangle;
      }

      if (useTexture) {
        const [p1, p2, p3] = textureMapping?.triangleCoordinateIndices[index] ?? [triangle.a, triangle.b, triangle.c];
        return `<triangle v1="${triangle.a}" v2="${triangle.b}" v3="${triangle.c}" pid="${textureGroupId}" p1="${p1}" p2="${p2}" p3="${p3}"/>`;
      }

      const colorIndex = clampColorIndex(
        entry.colorMode === "singleColor"
          ? (entry.singleColorIndex ?? 0)
          : triangle.surface === "outer"
            ? (colorIndices[index] ?? 0)
            : interiorShellColorIndex(options),
        palette.length,
      );
      const paintCode = paintColorCode(colorIndex);
      const paintAttribute = options.exportProfile === "standard3mf" || options.exportProfile === "texture3mf" ? "" : ` paint_color="${paintCode}"`;
      return `<triangle v1="${triangle.a}" v2="${triangle.b}" v3="${triangle.c}" pid="${colorGroupId}" p1="${colorIndex}" p2="${colorIndex}" p3="${colorIndex}"${paintAttribute}/>`;
    });

    return `${textureCoords}
    <object id="${objectId}" type="model" name="${escapeXml(entry.name)}">
      <mesh>
        <vertices>
          ${vertexLines.join("\n          ")}
        </vertices>
        <triangles>
          ${triangleLines.join("\n          ")}
        </triangles>
      </mesh>
    </object>`;
  });
  const buildItems = entries
    .map((_, entryIndex) => `<item objectid="${objectIdForIndex(entryIndex)}"/>`)
    .join("\n    ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02" xmlns:t="http://schemas.microsoft.com/3dmanufacturing/texture/2015/02">
  ${metadata.map(([name, value]) => `<metadata name="${escapeXml(name)}">${escapeXml(value)}</metadata>`).join("\n  ")}
  <resources>
    ${colorGroupResource}
    ${textureResource}
    ${objectBlocks.join("\n    ")}
  </resources>
  <build>
    ${buildItems}
  </build>
</model>`;
}

function buildFullSpectrumPatternManifest(options: ThreeMfOptions): string {
  const physicalCount = options.filaments.length;
  const patterns = options.fullSpectrumPatterns ?? [];
  return JSON.stringify(
    {
      version: 1,
      generator: "360 panoramic image to 3D-Printable Sphere",
      mode: "Snapmaker Orca FullSpectrum mixed filament definitions",
      physical_filaments: options.filaments.map((filament, index) => ({
        id: index + 1,
        name: filament.name || filament.id,
        color: rgbToHex(filament.rgb),
      })),
      virtual_filament_start_id: physicalCount + 1,
      pattern_count: patterns.length,
      patterns: patterns.map((pattern, index) => ({
        virtual_filament_id: physicalCount + index + 1,
        paint_color: paintColorCode(physicalCount + index),
        name: pattern.name,
        component_a: pattern.componentA,
        component_b: pattern.componentB,
        manual_pattern: pattern.manualPattern,
        expanded_pattern: pattern.expandedPattern,
        layer_count: pattern.layerCount,
        display_color: pattern.hex,
        mix_b_percent: pattern.mixBPercent,
      })),
    },
    null,
    2,
  );
}

function build3mfModelPackage(entries: ThreeMfEntry[], options: ThreeMfOptions): ThreeMfModelPackage {
  return {
    rootModelXml: build3mfModelXml(entries, options),
    objectModelFiles: [],
  };
}

function buildNestedPaintModelPackage(entries: ThreeMfEntry[], options: ThreeMfOptions): ThreeMfModelPackage {
  const created = new Date().toISOString();
  const metadata = [
    ["Title", "360 panoramic image to 3D-Printable Sphere slicer-painted color mesh"],
    ["Application", applicationName(options.exportProfile)],
    ["CreationDate", created],
    ["Generator", "360 panoramic image to 3D-Printable Sphere"],
    ["DiameterMm", options.settings.diameterMm.toString()],
    ["Resolution", options.settings.resolution],
    ["ColorSource", "TrianglePaintColors"],
    ["FilamentMode", options.processingMode === "dither" ? "FullSpectrum" : options.processingMode],
    ["TextureAxisRotationDeg", (options.textureRotationDeg ?? 0).toString()],
    ["Parts", entries.map((entry) => entry.mesh.part).join(", ")],
    ["Hollow", options.settings.hollow ? "true" : "false"],
    ["WallThicknessMm", options.settings.wallThicknessMm.toString()],
    ["LayerHeightMm", options.settings.layerHeightMm.toString()],
    ["FlatBase", options.settings.flatBase],
    ["OrientationMode", options.settings.orientationMode],
    ["ExportRotationDeg", `X ${options.exportRotationDeg.x}, Y ${options.exportRotationDeg.y}, Z ${options.exportRotationDeg.z}`],
  ];
  const rootObjects = entries.map((entry, entryIndex) => {
    const rootObjectId = objectIdForIndex(entryIndex);
    const nestedObjectId = nestedObjectIdForIndex(entryIndex);
    const fileName = objectModelFileName(entry, entryIndex);
    return `<object id="${rootObjectId}" type="model" name="${escapeXml(entry.name)}">
      <components>
        <component objectid="${nestedObjectId}" p:path="/3D/Objects/${escapeXml(fileName)}"/>
      </components>
    </object>`;
  });
  const buildItems = entries
    .map((_, entryIndex) => `<item objectid="${objectIdForIndex(entryIndex)}"/>`)
    .join("\n    ");
  const rootModelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
  ${metadata.map(([name, value]) => `<metadata name="${escapeXml(name)}">${escapeXml(value)}</metadata>`).join("\n  ")}
  <resources>
    ${rootObjects.join("\n    ")}
  </resources>
  <build>
    ${buildItems}
  </build>
</model>`;

  return {
    rootModelXml,
    objectModelFiles: entries.map((entry, entryIndex) => ({
      fileName: objectModelFileName(entry, entryIndex),
      xml: buildNestedPaintObjectModelXml(entry, entryIndex, options),
    })),
  };
}

function buildNestedPaintObjectModelXml(entry: ThreeMfEntry, entryIndex: number, options: ThreeMfOptions): string {
  const colorGroupId = 1;
  const palette = buildExportPalette(options, false);
  const colorLines = palette.map((rgb) => `<m:color color="${rgbToHex(rgb)}FF"/>`);
  const pedestalColorIndex =
    options.pedestalFilamentIndex !== undefined
      ? clampColorIndex(options.pedestalFilamentIndex, palette.length)
      : options.pedestalColorRgb
        ? nearestPatternPaletteIndex(options.pedestalColorRgb, palette)
        : 0;
  const colorIndices = assignTriangleColorIndices(
    entry.mesh,
    options.textureCanvas,
    palette,
    pedestalColorIndex,
    options.textureRotationDeg ?? 0,
  );
  const vertexLines = entry.mesh.vertices.map(
    (vertex) => `<vertex x="${round(vertex.x)}" y="${round(vertex.y)}" z="${round(vertex.z)}"/>`,
  );
  const triangleLines = entry.mesh.triangles.map((triangle, index) => {
    const shouldPaint =
      entry.colorMode === "singleColor" ||
      entry.mesh.part === "pedestal" ||
      triangle.surface === "outer" ||
      shouldPaintInteriorShell(entry, options);
    if (!shouldPaint) {
      return `<triangle v1="${triangle.a}" v2="${triangle.b}" v3="${triangle.c}"/>`;
    }

    const colorIndex = clampColorIndex(
      entry.colorMode === "singleColor"
        ? (entry.singleColorIndex ?? 0)
        : triangle.surface === "outer"
          ? (colorIndices[index] ?? 0)
          : interiorShellColorIndex(options),
      palette.length,
    );
    const paintCode = paintColorCode(colorIndex);
    return `<triangle v1="${triangle.a}" v2="${triangle.b}" v3="${triangle.c}" pid="${colorGroupId}" p1="${colorIndex}" p2="${colorIndex}" p3="${colorIndex}" paint_color="${paintCode}"/>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
  <resources>
    <m:colorgroup id="${colorGroupId}">
      ${colorLines.join("\n      ")}
    </m:colorgroup>
    <object id="${nestedObjectIdForIndex(entryIndex)}" type="model" name="${escapeXml(entry.name)}">
      <mesh>
        <vertices>
          ${vertexLines.join("\n          ")}
        </vertices>
        <triangles>
          ${triangleLines.join("\n          ")}
        </triangles>
      </mesh>
    </object>
  </resources>
</model>`;
}

function shouldPaintInteriorShell(entry: ThreeMfEntry, options: ThreeMfOptions): boolean {
  return entry.colorMode === "paintedSurface" && options.settings.hollow;
}

function interiorShellColorIndex(options: ThreeMfOptions): number {
  return neutralFilamentIndex(options.filaments);
}

function neutralFilamentIndex(filaments: FilamentChannel[]): number {
  const blackIndex = filaments.findIndex((filament) => filament.role === "black");
  if (blackIndex >= 0) {
    return blackIndex;
  }

  const whiteIndex = filaments.findIndex((filament) => filament.role === "white");
  return whiteIndex >= 0 ? whiteIndex : Math.min(3, Math.max(0, filaments.length - 1));
}

function assignTriangleColorIndices(
  mesh: SphereMesh,
  textureCanvas: HTMLCanvasElement,
  palette: Rgb[],
  pedestalColorIndex: number,
  textureRotationDeg: number,
): number[] {
  const context = get2dContext(textureCanvas);
  const image = context.getImageData(0, 0, textureCanvas.width, textureCanvas.height);
  const data = image.data;

  return mesh.triangles.map((triangle) => {
    if (mesh.part === "pedestal") {
      return pedestalColorIndex;
    }
    if (triangle.surface !== "outer") {
      return 0;
    }

    const uv = triangleSampleUv(mesh, triangle);
    const textureUv = transformTextureUv({ u: uv.u, v: 1 - uv.v }, textureRotationDeg);
    const sampleUv = {
      u: textureUv.u,
      v: 1 - textureUv.v,
    };
    const x = Math.min(textureCanvas.width - 1, Math.max(0, Math.floor(sampleUv.u * textureCanvas.width)));
    const y = Math.min(textureCanvas.height - 1, Math.max(0, Math.floor(sampleUv.v * textureCanvas.height)));
    const offset = (y * textureCanvas.width + x) * 4;
    return nearestPatternPaletteIndex(
      {
        r: data[offset],
        g: data[offset + 1],
        b: data[offset + 2],
      },
      palette,
    );
  });
}

function buildTriangleTextureMapping(mesh: SphereMesh, textureRotationDeg: number): TriangleTextureMapping {
  const coordinates = mesh.vertices.map((vertex) =>
    transformTextureUv(
      {
        u: vertex.u,
        v: 1 - vertex.v,
      },
      textureRotationDeg,
    ),
  );
  const duplicateIndices = new Map<string, number>();
  const triangleCoordinateIndices = mesh.triangles.map((triangle) => {
    const vertexIndices: [number, number, number] = [triangle.a, triangle.b, triangle.c];
    const unwrapped = unwrapTextureTriangle(vertexIndices.map((index) => coordinates[index]));
    return vertexIndices.map((vertexIndex, cornerIndex) => {
      const coordinate = unwrapped[cornerIndex];
      const original = coordinates[vertexIndex];
      if (coordinate.u === original.u && coordinate.v === original.v) {
        return vertexIndex;
      }

      const key = `${vertexIndex}:${coordinate.u}:${coordinate.v}`;
      const existing = duplicateIndices.get(key);
      if (existing !== undefined) {
        return existing;
      }

      const index = coordinates.push(coordinate) - 1;
      duplicateIndices.set(key, index);
      return index;
    }) as [number, number, number];
  });

  return { coordinates, triangleCoordinateIndices };
}

function unwrapTextureTriangle(coordinates: TextureUv[]): TextureUv[] {
  let unwrapped = coordinates.map((coordinate) => ({ ...coordinate }));
  (["u", "v"] as const).forEach((axis) => {
    const values = unwrapped.map((coordinate) => coordinate[axis]);
    if (Math.max(...values) - Math.min(...values) <= 0.5) {
      return;
    }

    unwrapped = unwrapped.map((coordinate) =>
      coordinate[axis] < 0.5 ? { ...coordinate, [axis]: coordinate[axis] + 1 } : coordinate,
    );
  });
  return unwrapped;
}

function buildProjectSettingsConfig(options: ThreeMfOptions): string {
  const colors = options.filaments.map((filament) => rgbToHex(filament.rgb));
  const filamentNames = options.filaments.map((filament) => filament.name || filament.id);
  const repeated = (value: string) => options.filaments.map(() => value);
  const snapmakerSafe = options.exportProfile === "snapmakerOrca";
  const fullSpectrumPatterns = options.fullSpectrumPatterns ?? [];
  const mixedDefinitions = fullSpectrumPatternDefinitions(fullSpectrumPatterns);
  const layerHeight = Math.max(0.04, options.settings.layerHeightMm);
  const initialLayerHeight = Math.max(0.12, layerHeight);
  const nozzleDiameter = 0.4;
  const extrusionWidth = 0.42;
  const settings: Record<string, unknown> = {
    version: "2.3.0",
    generator: "360 panoramic image to 3D-Printable Sphere",
    filament_colour: colors,
    filament_color: colors,
    filament_colors: colors,
    filament_colour_type: repeated("custom"),
    filament_type: repeated("PLA"),
    filament_is_support: repeated("0"),
    filament_printable: repeated("1"),
    filament_diameter: repeated("1.75"),
    filament_density: repeated("1.24"),
    filament_cost: repeated("0"),
    filament_ids: filamentNames,
    filament_settings_id: filamentNames,
    filament_vendor: repeated("Generic"),
    nozzle_diameter: [round(nozzleDiameter)],
    layer_height: round(layerHeight),
    initial_layer_print_height: round(initialLayerHeight),
    line_width: round(extrusionWidth),
    outer_wall_line_width: round(extrusionWidth),
    inner_wall_line_width: round(extrusionWidth),
    sparse_infill_line_width: round(extrusionWidth),
    internal_solid_infill_line_width: round(extrusionWidth),
    top_surface_line_width: round(extrusionWidth),
    support_line_width: round(extrusionWidth),
    enable_support: "0",
    support_filament: "0",
    support_interface_filament: "0",
    layer_gcode: "G92 E0",
    before_layer_change_gcode: "G92 E0",
    machine_layer_gcode: "G92 E0",
    curr_bed_type: snapmakerSafe ? "" : "Textured PEI Plate",
    printer_model: snapmakerSafe ? "" : "Generic",
    printer_variant: snapmakerSafe ? "" : "0.4",
    flush_multiplier: "1",
    flush_into_infill: "0",
    flush_into_objects: "0",
    flush_into_support: "0",
    from: "User",
    inherits: snapmakerSafe ? "" : "fdm_default",
    export_profile: options.exportProfile,
  };

  if (fullSpectrumPatterns.length > 0) {
    Object.assign(settings, {
      mixed_filament_definitions: mixedDefinitions,
      mixed_filament_gradient_mode: "0",
      mixed_filament_height_lower_bound: "0.04",
      mixed_filament_height_upper_bound: round(Math.max(0.16, layerHeight)),
      mixed_filament_advanced_dithering: "0",
      mixed_filament_component_bias_enabled: "0",
      mixed_filament_surface_indentation: "0",
      mixed_filament_region_collapse: "1",
      mixed_color_layer_height_a: round(layerHeight),
      mixed_color_layer_height_b: round(layerHeight),
      dithering_z_step_size: round(layerHeight),
      dithering_local_z_mode: "0",
      dithering_local_z_whole_objects: "0",
      dithering_local_z_direct_multicolor: "0",
      dithering_step_painted_zones_only: "1",
      fullspectrum_pattern_count: fullSpectrumPatterns.length.toString(),
    });
  }

  return JSON.stringify(settings, null, 2);
}

function buildModelSettingsConfig(entries: ThreeMfEntry[], profile: ExportProfile): string {
  const objectBlocks = entries
    .map(
      (entry, entryIndex) => `<object id="${objectIdForIndex(entryIndex)}">
    <metadata key="name" value="${escapeXml(entry.name)}"/>
    <metadata key="extruder" value="1"/>
    <metadata key="export_profile" value="${escapeXml(profile)}"/>
    <metadata key="source_file" value="3D/3dmodel.model"/>
  </object>`,
    )
    .join("\n  ");
  const instanceBlocks = entries
    .map(
      (_, entryIndex) => `<model_instance>
      <metadata key="object_id" value="${objectIdForIndex(entryIndex)}"/>
      <metadata key="instance_id" value="${entryIndex}"/>
      <metadata key="identify_id" value="${1000 + entryIndex}"/>
    </model_instance>`,
    )
    .join("\n    ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value="Plate 1"/>
    <metadata key="locked" value="false"/>
    ${instanceBlocks}
  </plate>
  ${objectBlocks}
</config>`;
}

function applicationName(profile: ExportProfile): string {
  if (profile === "bambuOrca") {
    return "OrcaSlicer-2.3.0";
  }
  if (profile === "snapmakerOrca") {
    return "Snapmaker Orca";
  }
  if (profile === "texture3mf") {
    return "3MF Texture Extension";
  }
  return "360 panoramic image to 3D-Printable Sphere";
}

function objectIdForIndex(index: number): number {
  return index + 2;
}

function nestedObjectIdForIndex(index: number): number {
  return index + 1002;
}

function objectModelFileName(entry: ThreeMfEntry, index: number): string {
  const safeName = entry.name.replace(/[^a-zA-Z0-9_-]/g, "_") || "object";
  return `object_${index + 1}_${safeName}.model`;
}

function clampColorIndex(index: number, paletteSize: number): number {
  return Math.min(Math.max(0, index), Math.max(0, paletteSize - 1));
}

function paintColorCode(index: number): string {
  const state = Math.max(1, Math.min(255, index + 1));
  if (state === 1) {
    return "4";
  }
  if (state === 2) {
    return "8";
  }

  const nibbles = ["C"];
  let value = state - 3;
  while (value >= 15) {
    nibbles.push("F");
    value -= 15;
  }
  nibbles.push(value.toString(16).toUpperCase());
  return nibbles.reverse().join("");
}

function contentTypesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Default Extension="config" ContentType="application/octet-stream"/>
  <Default Extension="json" ContentType="application/json"/>
  <Default Extension="png" ContentType="image/png"/>
</Types>`;
}

function relationshipsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
}

export function validate3mfXml(xml: string): string[] {
  if (typeof DOMParser === "undefined") {
    return [];
  }

  const parsed = new DOMParser().parseFromString(xml, "application/xml");
  const parserError = parsed.querySelector("parsererror");
  if (parserError) {
    return [parserError.textContent?.trim() || "XML parser error."];
  }
  if (parsed.getElementsByTagNameNS("*", "vertex").length === 0) {
    return ["3MF model XML does not contain vertices."];
  }
  if (parsed.getElementsByTagNameNS("*", "triangle").length === 0) {
    return ["3MF model XML does not contain triangles."];
  }
  return [];
}

function validate3mfPackage(modelPackage: ThreeMfModelPackage): string[] {
  const rootErrors = validateXmlSyntax(modelPackage.rootModelXml);
  if (rootErrors.length > 0) {
    return rootErrors.map((error) => `Root model: ${error}`);
  }

  if (modelPackage.objectModelFiles.length === 0) {
    return validate3mfXml(modelPackage.rootModelXml);
  }

  const errors: string[] = [];
  modelPackage.objectModelFiles.forEach((file) => {
    validate3mfXml(file.xml).forEach((error) => {
      errors.push(`${file.fileName}: ${error}`);
    });
  });
  return errors;
}

function validateXmlSyntax(xml: string): string[] {
  if (typeof DOMParser === "undefined") {
    return [];
  }

  const parsed = new DOMParser().parseFromString(xml, "application/xml");
  const parserError = parsed.querySelector("parsererror");
  if (parserError) {
    return [parserError.textContent?.trim() || "XML parser error."];
  }
  return [];
}

function round(value: number): string {
  return Number(value.toFixed(5)).toString();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
