// Pull a line material slightly toward the camera in clip space, so highlight strokes and
// markup never z-fight with the feature edges they sit on. Works with reversed-Z (bias +z)
// and a standard depth buffer (bias −z).
import type { Material } from "three";

export function withDepthBias(m: Material, amount = 0.0006): Material {
  m.onBeforeCompile = (shader, renderer) => {
    const reversed = !!(renderer as any).capabilities?.reversedDepthBuffer && !!(renderer as any).__psReversed;
    const sign = reversed ? "+" : "-";
    shader.vertexShader = shader.vertexShader.replace("#include <logdepthbuf_vertex>", `gl_Position.z ${sign}= ${amount.toFixed(6)} * gl_Position.w;\n#include <logdepthbuf_vertex>`);
  };
  m.customProgramCacheKey = () => `depthbias:${amount}`;
  return m;
}
