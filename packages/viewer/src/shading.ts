// Screen-space shading inside the face material. The AO and halo buffers are computed from a
// G-buffer before the faces draw; each face fragment then reads them at its own pixel:
// - AO scales the indirect light (sky, environment) fully and the direct lights only by
//   `directAO`: occlusion is about ambient light, and multiplying the whole color dirties the key
//   light's highlights and makes the crease core read near-black;
// - the halo multiplies the final color, in linear light before output encoding.
// The buffers can be coarser than the canvas (CSS resolution while the camera moves), so they're
// upsampled per fragment with depth-aware bilinear weights: a texel from the surface across a
// silhouette never bleeds onto this one, so outlines get no dark fringe.
//
// The uniforms are shared by every face material (and every viewer): `on` is set only for the
// faces draw in Viewer.renderShaded and cleared right after, so any other render of the faces
// (pick passes, section views, no-AO fallback) is untouched.
import * as THREE from "three";

export const screenShading = {
  psOn: { value: false },
  psAO: { value: null as THREE.Texture | null },
  psHalo: { value: null as THREE.Texture | null },
  psDepth: { value: null as THREE.Texture | null },
  psProjInv: { value: new THREE.Matrix4() },
  /** Canvas drawing-buffer size, in device pixels. */
  psViewport: { value: new THREE.Vector2(1, 1) },
  /** AO darkening, 0–1 (1 = the AO buffer as computed). */
  psAOIntensity: { value: 1 },
  /** Share of the AO applied to direct light, 0–1. */
  psDirectAO: { value: 0.85 },
};

const PARS = /* glsl */ `
uniform bool psOn;
uniform highp sampler2D psAO, psHalo, psDepth;
uniform mat4 psProjInv;
uniform vec2 psViewport;
uniform float psAOIntensity, psDirectAO;

float psViewZ(float d) {
  #ifdef USE_REVERSED_DEPTH_BUFFER
    vec4 v = psProjInv * vec4(0.0, 0.0, d, 1.0);
  #else
    vec4 v = psProjInv * vec4(0.0, 0.0, d * 2.0 - 1.0, 1.0);
  #endif
  return -v.z / v.w;
}

// (AO, halo) at this fragment
vec2 psSample() {
  vec2 size = vec2(textureSize(psDepth, 0));
  vec2 p = gl_FragCoord.xy / psViewport * size - 0.5;
  ivec2 b = ivec2(floor(p));
  vec2 f = p - floor(p);
  float z = vViewPosition.z;
  // same surface: within 1% of the distance, or a couple of texels of this surface's own slope
  float tol = max(0.01 * z, 2.0 * fwidth(z) * psViewport.x / size.x);
  vec2 sum = vec2(0.0), best = vec2(1.0);
  float wsum = 0.0, bestDz = 1e30;
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    ivec2 q = clamp(b + o, ivec2(0), ivec2(size) - 1);
    float d = texelFetch(psDepth, q, 0).x;
    #ifdef USE_REVERSED_DEPTH_BUFFER
      if (d <= 0.0) continue;
    #else
      if (d >= 1.0) continue;
    #endif
    float dz = abs(psViewZ(d) - z);
    vec2 v = vec2(texelFetch(psAO, q, 0).r, texelFetch(psHalo, q, 0).r);
    if (dz < bestDz) { bestDz = dz; best = v; }
    vec2 bw = mix(1.0 - f, f, vec2(o));
    float w = bw.x * bw.y * max(0.0, 1.0 - dz / tol);
    sum += w * v;
    wsum += w;
  }
  // no texel on this surface (a sliver thinner than a texel): the nearest in depth
  return wsum > 1e-4 ? sum / wsum : best;
}
`;

const APPLY_AO = /* glsl */ `
#include <aomap_fragment>
vec2 psShade = vec2(1.0);
if (psOn) {
  psShade = psSample();
  float psAo = mix(1.0, psShade.x, psAOIntensity);
  reflectedLight.indirectDiffuse *= psAo;
  float psNV = saturate(dot(geometryNormal, geometryViewDir));
  reflectedLight.indirectSpecular *= computeSpecularOcclusion(psNV, psAo, material.roughness);
  float psAoDirect = mix(1.0, psAo, psDirectAO);
  reflectedLight.directDiffuse *= psAoDirect;
  reflectedLight.directSpecular *= psAoDirect;
}
`;

/** Patch a face material to read the AO and halo buffers (MeshStandardMaterial). */
export function withScreenShading<T extends THREE.MeshStandardMaterial>(m: T): T {
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, screenShading);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${PARS}`)
      .replace("#include <aomap_fragment>", APPLY_AO)
      .replace("#include <opaque_fragment>", "outgoingLight *= psShade.y;\n#include <opaque_fragment>");
  };
  m.customProgramCacheKey = () => "ps-screen-shading";
  return m;
}
