// Ambient occlusion: three's GTAOPass (G-buffer, horizon-based AO, Poisson denoise) with our own
// AO shader. Three's stock shader has three problems for CAD shading:
// - an occluder more than `thickness` away in depth is dropped outright, so AO switches off with
//   a hard line where a surface falls away, and never reaches the overlaps the halo darkens;
// - its noise texture has a constant alpha, so every pixel samples at the same four distances and
//   the falloff shows as rings;
// - the radius is in world units only, so a small part in a big assembly gets AO blobs its own
//   size once zoomed in.
// Here occluders fade out smoothly between `radius` and `radius·falloff`, the slice rotation and
// step positions are jittered per pixel (interleaved gradient noise, which the denoiser averages
// out), and the radius is clamped to a band of screen pixels.
import * as THREE from "three";
import type { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";

const GTAO_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform highp sampler2D tNormal;
  uniform highp sampler2D tDepth;
  uniform vec2 resolution;
  uniform mat4 cameraProjectionMatrix;
  uniform mat4 cameraProjectionMatrixInverse;
  uniform float radius;          // world units,
  uniform vec2 radiusPx;         // clamped to this band of buffer texels
  uniform float falloff;         // occluders fade out from radius to radius·falloff
  uniform float distanceExponent;
  uniform float distanceFallOff;
  uniform float scale;

  #include <common>
  #include <packing>

  vec3 getViewPosition(const in vec2 uv, const in float depth) {
    #ifdef USE_REVERSED_DEPTH_BUFFER
      vec4 c = vec4(uv * 2.0 - 1.0, depth, 1.0);
    #else
      vec4 c = vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);
    #endif
    vec4 v = cameraProjectionMatrixInverse * c;
    return v.xyz / v.w;
  }

  vec3 sceneAt(vec3 viewPos) {
    vec4 c = cameraProjectionMatrix * vec4(viewPos, 1.0);
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    return getViewPosition(uv, textureLod(tDepth, uv, 0.0).x);
  }

  float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

  void main() {
    float depth = textureLod(tDepth, vUv, 0.0).x;
    #ifdef USE_REVERSED_DEPTH_BUFFER
      if (depth <= 0.0) discard;
    #else
      if (depth >= 1.0) discard;
    #endif
    vec3 viewPos = getViewPosition(vUv, depth);
    vec3 viewNormal = unpackRGBToNormal(textureLod(tNormal, vUv, 0.0).rgb);

    // buffer texels per world unit at this depth ([3][3] is 1 for an orthographic projection)
    float pxPerUnit = 0.5 * resolution.y * cameraProjectionMatrix[1][1];
    if (cameraProjectionMatrix[3][3] < 0.5) pxPerUnit /= -viewPos.z;
    float r = clamp(radius, radiusPx.x / pxPerUnit, radiusPx.y / pxPerUnit);
    float fadeFrom = r, fadeTo = r * falloff;

    float rot = ign(gl_FragCoord.xy);
    float jitter = ign(gl_FragCoord.xy + vec2(47.0, 17.0));

    const int DIRECTIONS = SAMPLES < 30 ? 3 : 5;
    const int STEPS = (SAMPLES + DIRECTIONS - 1) / DIRECTIONS;
    vec3 viewDir = normalize(-viewPos);
    float ao = 0.0;
    for (int i = 0; i < DIRECTIONS; ++i) {
      // the directions split a half turn evenly; the per-pixel offset covers the gap between them
      float angle = (float(i) + rot) / float(DIRECTIONS) * PI;
      vec3 sampleDir = vec3(cos(angle), sin(angle), 0.0);
      vec3 sliceBitangent = normalize(cross(sampleDir, viewDir));
      vec3 sliceTangent = cross(sliceBitangent, viewDir);
      vec3 normalInSlice = normalize(viewNormal - sliceBitangent * dot(viewNormal, sliceBitangent));
      vec3 tangentToNormalInSlice = cross(normalInSlice, sliceBitangent);
      // horizons start at the tangent plane; a faded-out occluder falls back to it
      vec2 lowCos = vec2(dot(viewDir, tangentToNormalInSlice), dot(viewDir, -tangentToNormalInSlice));
      vec2 cosHorizons = lowCos;

      for (int j = 0; j < STEPS; ++j) {
        float t = (float(j) + 0.25 + 0.75 * jitter) / float(STEPS);
        float len = max(r * pow(t, distanceExponent), 1.0 / pxPerUnit);
        vec3 offset = sampleDir * len;
        float k = mix(1.0, 2.0 / float(j + 2), distanceFallOff);

        vec3 d = sceneAt(viewPos + offset) - viewPos;
        float dl = max(length(d), 1e-6);
        float shc = mix(lowCos.x, dot(viewDir, d / dl), clamp((fadeTo - dl) / (fadeTo - fadeFrom), 0.0, 1.0));
        cosHorizons.x += max(0.0, (shc - cosHorizons.x) * k);

        d = sceneAt(viewPos - offset) - viewPos;
        dl = max(length(d), 1e-6);
        shc = mix(lowCos.y, dot(viewDir, d / dl), clamp((fadeTo - dl) / (fadeTo - fadeFrom), 0.0, 1.0));
        cosHorizons.y += max(0.0, (shc - cosHorizons.y) * k);
      }

      vec2 sinHorizons = sqrt(1.0 - cosHorizons * cosHorizons);
      float nx = dot(normalInSlice, sliceTangent);
      float ny = dot(normalInSlice, viewDir);
      float nxb = 0.5 * (acos(cosHorizons.y) - acos(cosHorizons.x) + sinHorizons.x * cosHorizons.x - sinHorizons.y * cosHorizons.y);
      float nyb = 0.5 * (2.0 - cosHorizons.x * cosHorizons.x - cosHorizons.y * cosHorizons.y);
      ao += nx * nxb + ny * nyb;
    }
    ao = pow(clamp(ao / float(DIRECTIONS), 0.0, 1.0), scale);
    gl_FragColor = vec4(vec3(ao), 1.0);
  }`;

/** Denoise reach in CSS pixels: wider than the noise pattern, so it reads as a smooth gradient. */
const DENOISE_PX = 8;
/** AO radius band in CSS pixels, whatever the world radius works out to at that depth. */
const RADIUS_PX: [number, number] = [6, 40];

/** Switch a fresh GTAOPass to our AO shader; `samples` is fixed for the pass's lifetime. */
export function setupAO(pass: GTAOPass, samples: number) {
  const p = pass as any;
  const m: THREE.ShaderMaterial = p.gtaoMaterial;
  m.fragmentShader = GTAO_FRAG;
  m.defines.SAMPLES = samples;
  Object.assign(m.uniforms, { radiusPx: { value: new THREE.Vector2() }, falloff: { value: 2.5 } });
  m.uniforms.distanceExponent.value = 1;
  // far steps count nearly as much as near ones: a broad, soft falloff instead of a dark core
  m.uniforms.distanceFallOff.value = 0.2;
  m.uniforms.scale.value = 1;
  m.needsUpdate = true;
  // the faces are double-sided: back faces must reach the G-buffer too, or AO and the halo are
  // computed from whatever lies behind them
  p.normalMaterial.side = THREE.DoubleSide;
  pass.updatePdMaterial({ samples: 16, rings: 3, radiusExponent: 1.5 });
}

/** Size-dependent settings: `scale` buffer texels per CSS pixel. */
export function sizeAO(pass: GTAOPass, scale: number) {
  const m: THREE.ShaderMaterial = (pass as any).gtaoMaterial;
  m.uniforms.radiusPx.value.set(RADIUS_PX[0] * scale, RADIUS_PX[1] * scale);
  pass.updatePdMaterial({ radius: DENOISE_PX * scale });
}

/** World-size settings, from the model's bounding radius. */
export function scaleAO(pass: GTAOPass, modelRadius: number) {
  (pass as any).gtaoMaterial.uniforms.radius.value = modelRadius * 0.1;
  // the denoiser's plane-distance tolerance is in world units too
  pass.updatePdMaterial({ depthPhi: modelRadius * 0.01 });
}
