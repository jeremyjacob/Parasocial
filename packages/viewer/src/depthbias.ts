// Pull a line material slightly toward the camera, so highlight strokes and markup
// never z-fight with the faces and edges they sit on.
//
// Reversed-Z: NDC depth is ~near/distance, so a fixed offset is enormous for far geometry (0.0004
// is most of the range at 200 units, and lines then win over everything). Scale depth instead:
// z·(1+k) moves the line k·distance toward the camera, a constant relative nudge at any range.
// Standard depth keeps the classic small constant offset (−z).
//
// Orthographic: depth is linear over the camera's whole near..far span (±1e5), so either of those
// is hundreds of units and buried geometry pokes through. Move k·(view height) toward the camera
// in view space instead — the same relative nudge perspective gets at its viewing distance.
import type { Material } from "three";

export function withDepthBias(m: Material, amount = 0.0006): Material {
  m.onBeforeCompile = (shader, renderer) => {
    const reversed = !!(renderer as any).capabilities?.reversedDepthBuffer && !!(renderer as any).__psReversed;
    const k = (amount * 4).toFixed(6);
    const persp = reversed ? `gl_Position.z *= ${(1 + amount * 4).toFixed(6)};` : `gl_Position.z -= ${amount.toFixed(6)} * gl_Position.w;`;
    // view z +s (toward the camera) is clip z + P[2][2]·s, whichever way depth runs; view height is 2/P[1][1]
    const bias = `if (isPerspectiveMatrix(projectionMatrix)) { ${persp} } else { gl_Position.z += projectionMatrix[2][2] * ${k} * 2.0 / projectionMatrix[1][1]; }`;
    shader.vertexShader = shader.vertexShader.replace("#include <logdepthbuf_vertex>", `${bias}\n#include <logdepthbuf_vertex>`);
  };
  m.customProgramCacheKey = () => `depthbias:${amount}`;
  return m;
}
