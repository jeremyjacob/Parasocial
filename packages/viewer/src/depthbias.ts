// Pull a line material slightly toward the camera, so highlight strokes, markup and the origin
// axes never z-fight with the faces and edges they sit on.
//
// Reversed-Z: NDC depth is ~near/distance, so a fixed offset is enormous for far geometry (0.0004
// is most of the range at 200 units, and lines then win over everything). Scale depth instead:
// z·(1+k) moves the line k·distance toward the camera, a constant relative nudge at any range.
// Standard depth keeps the classic small constant offset (−z).
import type { Material } from "three";

export function withDepthBias(m: Material, amount = 0.0006): Material {
  m.onBeforeCompile = (shader, renderer) => {
    const reversed = !!(renderer as any).capabilities?.reversedDepthBuffer && !!(renderer as any).__psReversed;
    const bias = reversed ? `gl_Position.z *= ${(1 + amount * 4).toFixed(6)};` : `gl_Position.z -= ${amount.toFixed(6)} * gl_Position.w;`;
    shader.vertexShader = shader.vertexShader.replace("#include <logdepthbuf_vertex>", `${bias}\n#include <logdepthbuf_vertex>`);
  };
  m.customProgramCacheKey = () => `depthbias:${amount}`;
  return m;
}
