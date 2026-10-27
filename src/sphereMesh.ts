import type {
  FlatBaseMode,
  MeshPart,
  MeshStats,
  MeshTriangle,
  MeshVertex,
  ResolutionLevel,
  SphereMesh,
  SphereSettings,
} from "./types";

const TWO_PI = Math.PI * 2;
const EPSILON = 1e-6;

export const RESOLUTION_PRESETS: Record<
  ResolutionLevel,
  { label: string; longitudeSegments: number; latitudeSegments: number; note: string }
> = {
  draft: {
    label: "Draft",
    longitudeSegments: 48,
    latitudeSegments: 24,
    note: "Fast preview and test exports.",
  },
  standard: {
    label: "Standard",
    longitudeSegments: 96,
    latitudeSegments: 48,
    note: "Good default for 80 mm spheres.",
  },
  high: {
    label: "High",
    longitudeSegments: 256,
    latitudeSegments: 128,
    note: "Smoother geometry with larger files.",
  },
  ultra: {
    label: "Ultra",
    longitudeSegments: 512,
    latitudeSegments: 256,
    note: "Very large files; best for reducing visible triangular color facets.",
  },
};

export function generateSphereMesh(settings: SphereSettings, part: MeshPart = "full"): SphereMesh {
  const preset = RESOLUTION_PRESETS[settings.resolution];
  const phiRange = getPhiRange(settings, part);
  const span = phiRange.end - phiRange.start;
  const latitudeSegments = Math.max(4, Math.round(preset.latitudeSegments * (span / Math.PI)));
  const longitudeSegments = preset.longitudeSegments;
  const radius = settings.diameterMm / 2;
  const innerRadius = settings.hollow ? Math.max(0.5, radius - settings.wallThicknessMm) : 0;
  const vertices: MeshVertex[] = [];
  const triangles: MeshTriangle[] = [];

  const outerRings = addSurfaceRings(vertices, triangles, {
    radius,
    longitudeSegments,
    latitudeSegments,
    phiStart: phiRange.start,
    phiEnd: phiRange.end,
    surface: "outer",
  });

  if (settings.hollow && innerRadius > 0 && innerRadius < radius) {
    const innerRings = addSurfaceRings(vertices, triangles, {
      radius: innerRadius,
      longitudeSegments,
      latitudeSegments,
      phiStart: phiRange.start,
      phiEnd: phiRange.end,
      surface: "inner",
    });

    if (phiRange.start > EPSILON) {
      connectBoundaryRings(vertices, triangles, outerRings[0], innerRings[0], "start");
    }
    if (Math.PI - phiRange.end > EPSILON) {
      connectBoundaryRings(
        vertices,
        triangles,
        outerRings[outerRings.length - 1],
        innerRings[innerRings.length - 1],
        "end",
      );
    }
  } else {
    if (phiRange.start > EPSILON) {
      addSolidCap(vertices, triangles, outerRings[0], "start");
    }
    if (Math.PI - phiRange.end > EPSILON) {
      addSolidCap(vertices, triangles, outerRings[outerRings.length - 1], "end");
    }
  }

  return {
    vertices,
    triangles,
    part,
    settings,
    longitudeSegments,
    latitudeSegments,
  };
}

export function generatePedestalMesh(settings: SphereSettings): SphereMesh {
  const width = Math.max(5, settings.pedestalWidthMm);
  const length = Math.max(5, settings.pedestalLengthMm);
  const height = Math.max(1, settings.pedestalHeightMm);
  const sphereRadius = settings.diameterMm / 2;
  const topY = -sphereRadius + height;
  const bottomY = -sphereRadius;
  const x = width / 2;
  const z = length / 2;
  const vertices: MeshVertex[] = [
    { x: -x, y: bottomY, z: -z, u: 0, v: 1, surface: "cap" },
    { x, y: bottomY, z: -z, u: 1, v: 1, surface: "cap" },
    { x, y: bottomY, z, u: 1, v: 1, surface: "cap" },
    { x: -x, y: bottomY, z, u: 0, v: 1, surface: "cap" },
    { x: -x, y: topY, z: -z, u: 0, v: 0.92, surface: "cap" },
    { x, y: topY, z: -z, u: 1, v: 0.92, surface: "cap" },
    { x, y: topY, z, u: 1, v: 0.92, surface: "cap" },
    { x: -x, y: topY, z, u: 0, v: 0.92, surface: "cap" },
  ];
  const triangles: MeshTriangle[] = [
    { a: 0, b: 2, c: 1, surface: "cap" },
    { a: 0, b: 3, c: 2, surface: "cap" },
    { a: 4, b: 5, c: 6, surface: "cap" },
    { a: 4, b: 6, c: 7, surface: "cap" },
    { a: 0, b: 1, c: 5, surface: "cap" },
    { a: 0, b: 5, c: 4, surface: "cap" },
    { a: 1, b: 2, c: 6, surface: "cap" },
    { a: 1, b: 6, c: 5, surface: "cap" },
    { a: 2, b: 3, c: 7, surface: "cap" },
    { a: 2, b: 7, c: 6, surface: "cap" },
    { a: 3, b: 0, c: 4, surface: "cap" },
    { a: 3, b: 4, c: 7, surface: "cap" },
  ];

  return {
    vertices,
    triangles,
    part: "pedestal",
    settings,
    longitudeSegments: 4,
    latitudeSegments: 2,
  };
}

function getPhiRange(settings: SphereSettings, part: MeshPart): { start: number; end: number } {
  let start = 0;
  let end = Math.PI;

  if (part === "top") {
    end = Math.PI / 2;
  }
  if (part === "bottom") {
    start = Math.PI / 2;
  }

  if (settings.flatBase !== "none" && part !== "top") {
    end = Math.min(end, flatBasePhi(settings.flatBase === "pedestal" ? "large" : settings.flatBase));
  }

  return { start, end: Math.max(start + 0.05, end) };
}

function flatBasePhi(mode: FlatBaseMode): number {
  if (mode === "none") {
    return Math.PI;
  }

  const heightFraction = mode === "small" ? 0.08 : 0.18;
  const normalizedPlaneY = -1 + heightFraction;
  return Math.acos(normalizedPlaneY);
}

function addSurfaceRings(
  vertices: MeshVertex[],
  triangles: MeshTriangle[],
  options: {
    radius: number;
    longitudeSegments: number;
    latitudeSegments: number;
    phiStart: number;
    phiEnd: number;
    surface: "outer" | "inner";
  },
): number[][] {
  const rings: number[][] = [];

  for (let lat = 0; lat <= options.latitudeSegments; lat += 1) {
    const t = lat / options.latitudeSegments;
    const phi = options.phiStart + (options.phiEnd - options.phiStart) * t;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const ring: number[] = [];
    const isTopPole = lat === 0 && options.phiStart <= EPSILON;
    const isBottomPole = lat === options.latitudeSegments && Math.PI - options.phiEnd <= EPSILON;

    if (isTopPole || isBottomPole) {
      rings.push([
        vertices.push({
          x: 0,
          y: options.radius * cosPhi,
          z: 0,
          u: 0.5,
          v: phi / Math.PI,
          surface: options.surface,
        }) - 1,
      ]);
      continue;
    }

    for (let lon = 0; lon < options.longitudeSegments; lon += 1) {
      const u = lon / options.longitudeSegments;
      const theta = u * TWO_PI;
      ring.push(
        vertices.push({
          x: options.radius * sinPhi * Math.cos(theta),
          y: options.radius * cosPhi,
          z: options.radius * sinPhi * Math.sin(theta),
          u,
          v: phi / Math.PI,
          surface: options.surface,
        }) - 1,
      );
    }

    rings.push(ring);
  }

  for (let lat = 0; lat < options.latitudeSegments; lat += 1) {
    const currentRing = rings[lat];
    const nextRing = rings[lat + 1];
    const isTopPole = currentRing.length === 1;
    const isBottomPole = nextRing.length === 1;

    for (let lon = 0; lon < options.longitudeSegments; lon += 1) {
      const nextLon = (lon + 1) % options.longitudeSegments;

      if (isTopPole) {
        const pole = currentRing[0];
        const b = nextRing[lon];
        const d = nextRing[nextLon];
        if (options.surface === "outer") {
          pushTriangle(vertices, triangles, pole, d, b, "outer");
        } else {
          pushTriangle(vertices, triangles, pole, b, d, "inner");
        }
        continue;
      }

      if (isBottomPole) {
        const a = currentRing[lon];
        const c = currentRing[nextLon];
        const pole = nextRing[0];
        if (options.surface === "outer") {
          pushTriangle(vertices, triangles, a, c, pole, "outer");
        } else {
          pushTriangle(vertices, triangles, a, pole, c, "inner");
        }
        continue;
      }

      const a = currentRing[lon];
      const b = nextRing[lon];
      const c = currentRing[nextLon];
      const d = nextRing[nextLon];
      if (options.surface === "outer") {
        pushTriangle(vertices, triangles, a, c, b, "outer");
        pushTriangle(vertices, triangles, c, d, b, "outer");
      } else {
        pushTriangle(vertices, triangles, a, b, c, "inner");
        pushTriangle(vertices, triangles, c, b, d, "inner");
      }
    }
  }

  return rings;
}

function addSolidCap(
  vertices: MeshVertex[],
  triangles: MeshTriangle[],
  ring: number[],
  boundary: "start" | "end",
): void {
  const sample = averageRing(vertices, ring);
  const centerIndex =
    vertices.push({
      x: 0,
      y: sample.y,
      z: 0,
      u: 0.5,
      v: boundary === "start" ? sample.v : Math.min(1, sample.v),
      surface: "cap",
    }) - 1;

  for (let lon = 0; lon < ring.length; lon += 1) {
    const nextLon = (lon + 1) % ring.length;
    if (boundary === "start") {
      pushTriangle(vertices, triangles, ring[lon], centerIndex, ring[nextLon], "cap");
    } else {
      pushTriangle(vertices, triangles, ring[lon], ring[nextLon], centerIndex, "cap");
    }
  }
}

function connectBoundaryRings(
  vertices: MeshVertex[],
  triangles: MeshTriangle[],
  outerRing: number[],
  innerRing: number[],
  boundary: "start" | "end",
): void {
  for (let lon = 0; lon < outerRing.length; lon += 1) {
    const nextLon = (lon + 1) % outerRing.length;
    const o0 = outerRing[lon];
    const o1 = outerRing[nextLon];
    const i0 = innerRing[lon];
    const i1 = innerRing[nextLon];

    if (boundary === "start") {
      pushTriangle(vertices, triangles, o0, i0, o1, "cap");
      pushTriangle(vertices, triangles, o1, i0, i1, "cap");
    } else {
      pushTriangle(vertices, triangles, o0, o1, i0, "cap");
      pushTriangle(vertices, triangles, o1, i1, i0, "cap");
    }
  }
}

function pushTriangle(
  vertices: MeshVertex[],
  triangles: MeshTriangle[],
  a: number,
  b: number,
  c: number,
  surface: "outer" | "inner" | "cap",
): void {
  if (triangleArea(vertices[a], vertices[b], vertices[c]) <= EPSILON) {
    return;
  }
  triangles.push({ a, b, c, surface });
}

function triangleArea(a: MeshVertex, b: MeshVertex, c: MeshVertex): number {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const cross = {
    x: ab.y * ac.z - ab.z * ac.y,
    y: ab.z * ac.x - ab.x * ac.z,
    z: ab.x * ac.y - ab.y * ac.x,
  };
  return Math.sqrt(cross.x * cross.x + cross.y * cross.y + cross.z * cross.z) / 2;
}

function averageRing(vertices: MeshVertex[], ring: number[]): { y: number; v: number } {
  const total = ring.reduce(
    (acc, index) => ({
      y: acc.y + vertices[index].y,
      v: acc.v + vertices[index].v,
    }),
    { y: 0, v: 0 },
  );
  return {
    y: total.y / ring.length,
    v: total.v / ring.length,
  };
}

export function triangleSampleUv(mesh: SphereMesh, triangle: MeshTriangle): { u: number; v: number } {
  const a = mesh.vertices[triangle.a];
  const b = mesh.vertices[triangle.b];
  const c = mesh.vertices[triangle.c];
  const values = [a.u, b.u, c.u];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const unwrapped = max - min > 0.5 ? values.map((u) => (u < 0.5 ? u + 1 : u)) : values;

  return {
    u: ((unwrapped[0] + unwrapped[1] + unwrapped[2]) / 3) % 1,
    v: Math.min(1, Math.max(0, (a.v + b.v + c.v) / 3)),
  };
}

export function validateMesh(mesh: SphereMesh): string[] {
  const errors: string[] = [];
  const edgeCounts = new Map<string, number>();

  if (mesh.vertices.length === 0) {
    errors.push("Mesh has no vertices.");
  }
  if (mesh.triangles.length === 0) {
    errors.push("Mesh has no triangles.");
  }

  mesh.vertices.forEach((vertex, index) => {
    if (![vertex.x, vertex.y, vertex.z, vertex.u, vertex.v].every(Number.isFinite)) {
      errors.push(`Vertex ${index} contains a non-finite value.`);
    }
  });

  mesh.triangles.forEach((triangle, index) => {
    const indices = [triangle.a, triangle.b, triangle.c];
    if (new Set(indices).size !== 3) {
      errors.push(`Triangle ${index} has duplicate indices.`);
    }
    indices.forEach((vertexIndex) => {
      if (vertexIndex < 0 || vertexIndex >= mesh.vertices.length) {
        errors.push(`Triangle ${index} references invalid vertex ${vertexIndex}.`);
      }
    });
    if (indices.every((vertexIndex) => vertexIndex >= 0 && vertexIndex < mesh.vertices.length)) {
      countEdge(edgeCounts, triangle.a, triangle.b);
      countEdge(edgeCounts, triangle.b, triangle.c);
      countEdge(edgeCounts, triangle.c, triangle.a);
    }
  });
  const openEdgeCount = [...edgeCounts.values()].filter((count) => count === 1).length;
  const nonManifoldEdgeCount = [...edgeCounts.values()].filter((count) => count > 2).length;
  if (openEdgeCount > 0) {
    errors.push(`Mesh has ${openEdgeCount} open boundary edges.`);
  }
  if (nonManifoldEdgeCount > 0) {
    errors.push(`Mesh has ${nonManifoldEdgeCount} non-manifold edges.`);
  }

  return errors.slice(0, 20);
}

function countEdge(edgeCounts: Map<string, number>, a: number, b: number): void {
  const key = a < b ? `${a}:${b}` : `${b}:${a}`;
  edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
}

export function getMeshStats(meshes: SphereMesh[], textureWidth: number, textureHeight: number): MeshStats {
  const vertices = meshes.reduce((sum, mesh) => sum + mesh.vertices.length, 0);
  const triangles = meshes.reduce((sum, mesh) => sum + mesh.triangles.length, 0);
  const diameterMm = meshes[0]?.settings.diameterMm ?? 0;

  return {
    vertices,
    triangles,
    diameterMm,
    textureWidth,
    textureHeight,
    estimatedColorMeshBytes: triangles * 185 + vertices * 42 + textureWidth * textureHeight,
  };
}
