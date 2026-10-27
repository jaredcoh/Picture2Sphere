export interface TextureUv {
  u: number;
  v: number;
}

export function transformTextureUv(uv: TextureUv, rotationDeg: number): TextureUv {
  switch (normalizeRightAngle(rotationDeg)) {
    case 90:
      return { u: uv.v, v: 1 - uv.u };
    case 180:
      return { u: 1 - uv.u, v: 1 - uv.v };
    case 270:
      return { u: 1 - uv.v, v: uv.u };
    default:
      return uv;
  }
}

export function normalizeRightAngle(value: number): number {
  return ((Math.round(value / 90) * 90) % 360 + 360) % 360;
}
