// Depth darkening (Onshape-like; Luft et al., "Image Enhancement by Unsharp Masking the Depth
// Buffer", 2006): where a nearer surface overlaps a farther one, the farther one darkens softly
// along the nearer one's outline, in proportion to how far behind it sits, so overlapping shapes
// separate at a glance. Each pixel samples a disc and sums how far its neighbors stand in front of
// its own surface (the local depth plane, so a surface sloping away never shadows itself). Small
// steps (chamfers, rims) fall in a dead zone; the gap is measured against the model's size.
//
// Only overlaps count, not creases: a wall rising from a floor also stands in front of the floor
// near their seam, but that contact shading is AO's job, and a halo there lays a broad screen-space
// band over AO's tighter gradient and washes it out. So each neighbor's gap is also measured to
// its own plane (from GTAO's normal buffer) extended back to this pixel: a wall that meets the
// floor crosses it at the seam, so its plane lies at or behind the floor here; a lid over the floor
// is still in front of it.
//
// Near a curved silhouette (a boss, a shaft, a fillet) the neighbor's normal is nearly
// perpendicular to the view, so its plane runs almost parallel to this pixel's ray and the
// intersection lands anywhere, often far behind: the test would randomly erase the halo right at
// the outline. It is trusted only as far as the plane faces the ray.
//
// The pass writes the halo factor (linear light) into a target the size of the G-buffer: device
// pixels at rest, CSS pixels while the camera moves. The per-pixel disc rotation leaves a fine
// grain (streaky once CSS pixels are scaled up), so a separable depth-aware blur follows: it
// averages only texels on the same surface, which keeps the halo's edge at an outline crisp. The face material multiplies it in (see
// shading.ts), so edges and helpers drawn afterwards are never darkened.
import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

/** Disc samples at rest; `fast` frames (camera moving) take FAST_SAMPLES. */
const SAMPLES = 48;
const FAST_SAMPLES = 32;
/** Blur taps each side of a texel. */
const BLUR_TAPS = 4;

export class HaloPass {
  /** Reach in CSS pixels. */
  radius = 24;
  /** Darkening at the outline of a full-depth overlap, 0–1. */
  strength = 0.4;
  /** Depth gaps (world units) below this are ignored, */
  threshold = 0.1;
  /** and this much past it darkens fully. */
  range = 5;
  camera: THREE.Camera;
  private mat: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  private blurMat: THREE.ShaderMaterial;
  private blurQuad: FullScreenQuad;

  constructor(camera: THREE.Camera) {
    this.camera = camera;
    this.mat = new THREE.ShaderMaterial({
      defines: { SAMPLES },
      uniforms: {
        tDepth: { value: null },
        tNormal: { value: null },
        projInv: { value: new THREE.Matrix4() },
        persp: { value: true },
        texel: { value: new THREE.Vector2() },
        samples: { value: SAMPLES },
        radius: { value: 1 },
        threshold: { value: 1 },
        range: { value: 1 },
        strength: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDepth, tNormal;
        uniform mat4 projInv;
        uniform bool persp;
        uniform vec2 texel;
        uniform int samples;
        uniform float radius, threshold, range, strength;
        varying vec2 vUv;

        // view-space position; background reads as infinitely far (z = -1e20)
        vec3 viewPos(vec2 uv) {
          float d = textureLod(tDepth, uv, 0.0).x;
          #ifdef USE_REVERSED_DEPTH_BUFFER
            if (d <= 0.0) return vec3(0.0, 0.0, -1e20);
            vec4 c = vec4(uv * 2.0 - 1.0, d, 1.0);
          #else
            if (d >= 1.0) return vec3(0.0, 0.0, -1e20);
            vec4 c = vec4(vec3(uv, d) * 2.0 - 1.0, 1.0);
          #endif
          vec4 v = projInv * c;
          return v.xyz / v.w;
        }
        // distance along the view axis
        float dist(vec2 uv) { return -viewPos(uv).z; }

        // strength is tuned as a multiply on the sRGB-encoded color; the face shader applies the
        // factor in linear light, so it's decoded here to keep the same look
        void shade(float factor) { gl_FragColor = vec4(vec3(pow(clamp(factor, 0.0, 1.0), 2.2)), 1.0); }

        void main() {
          vec3 P = viewPos(vUv);
          float z = -P.z;
          if (z >= 1e19) { shade(1.0); return; }
          vec3 D = normalize(persp ? P : vec3(0.0, 0.0, -1.0)); // this pixel's view ray
          // local depth slope per texel, from the smoother side (so an edge next door doesn't skew it)
          float xp = dist(vUv + vec2(texel.x, 0.0)) - z, xm = z - dist(vUv - vec2(texel.x, 0.0));
          float yp = dist(vUv + vec2(0.0, texel.y)) - z, ym = z - dist(vUv - vec2(0.0, texel.y));
          vec2 slope = vec2(abs(xp) < abs(xm) ? xp : xm, abs(yp) < abs(ym) ? yp : ym);
          if (abs(slope.x) > 1e18) slope.x = 0.0;
          if (abs(slope.y) > 1e18) slope.y = 0.0;
          // Vogel disc, rotated and its radii shifted per pixel (interleaved gradient noise, two
          // decorrelated offsets): fine grain instead of rings. Rotation alone leaves every pixel
          // on the same radii, which streaks where the buffer is coarse (CSS pixels, orbiting).
          float rot = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy + vec2(47.0, 17.0), vec2(0.06711056, 0.00583715))));
          float n = float(samples), occ = 0.0, wsum = 0.0;
          for (int i = 0; i < SAMPLES; i++) {
            if (i >= samples) break;
            float f = (float(i) + jit) / n;
            float a = float(i) * 2.399963 + rot;
            vec2 o = sqrt(f) * radius * vec2(cos(a), sin(a));
            float w = exp(-3.0 * f); // gaussian in r: dark at the outline, a long soft tail
            vec2 uv = vUv + o * texel;
            vec3 Q = viewPos(uv);
            float gap = z + dot(slope, o) + Q.z;
            if (gap > threshold && Q.z > -1e19) {
              // the neighbor's plane, extended back along this pixel's ray: at or behind this
              // surface when the two meet in a crease (AO's job), still in front of it for an overlap
              vec3 N = normalize(textureLod(tNormal, uv, 0.0).xyz * 2.0 - 1.0);
              float nd = dot(N, D);
              // how far to trust the plane: not at all when it runs along the ray (a silhouette)
              float trust = smoothstep(0.15, 0.35, abs(nd));
              if (trust > 0.0) {
                float s = dot(N, Q - P) / nd; // P + s·D is on the plane
                // its depth gap to P: ≤ 0 when the plane lies behind P
                gap = mix(gap, min(gap, s * D.z), trust);
              }
            }
            occ += w * clamp((gap - threshold) / range, 0.0, 1.0);
            wsum += w;
          }
          // a straight outline covers ~half the disc: that reads as full strength
          float k = min(1.0, 2.0 * occ / wsum);
          shade(1.0 - strength * k);
        }`,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.quad = new FullScreenQuad(this.mat);
    this.blurMat = new THREE.ShaderMaterial({
      defines: { TAPS: BLUR_TAPS },
      uniforms: { tHalo: { value: null }, tDepth: { value: null }, projInv: { value: new THREE.Matrix4() }, dir: { value: new THREE.Vector2() } },
      vertexShader: /* glsl */ `
        void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tHalo, tDepth;
        uniform mat4 projInv;
        uniform vec2 dir;

        // distance along the view axis; -1 for the background
        float dist(ivec2 p) {
          float d = texelFetch(tDepth, p, 0).x;
          #ifdef USE_REVERSED_DEPTH_BUFFER
            if (d <= 0.0) return -1.0;
            vec4 v = projInv * vec4(0.0, 0.0, d, 1.0);
          #else
            if (d >= 1.0) return -1.0;
            vec4 v = projInv * vec4(0.0, 0.0, d * 2.0 - 1.0, 1.0);
          #endif
          return -v.z / v.w;
        }

        void main() {
          ivec2 p = ivec2(gl_FragCoord.xy), size = textureSize(tHalo, 0);
          float c = texelFetch(tHalo, p, 0).r, z = dist(p);
          if (z < 0.0) { gl_FragColor = vec4(vec3(c), 1.0); return; }
          // same surface: within 3% of the distance (a silhouette's depth jump is far more)
          float tol = 0.03 * z, sum = c, wsum = 1.0;
          for (int i = -TAPS; i <= TAPS; i++) {
            if (i == 0) continue;
            ivec2 q = clamp(p + ivec2(dir) * i, ivec2(0), size - 1);
            float zq = dist(q);
            if (zq < 0.0) continue;
            float w = exp(-float(i * i) / float(TAPS * TAPS)) * max(0.0, 1.0 - abs(zq - z) / tol);
            sum += w * texelFetch(tHalo, q, 0).r;
            wsum += w;
          }
          gl_FragColor = vec4(vec3(sum / wsum), 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.blurQuad = new FullScreenQuad(this.blurMat);
  }

  /**
   * Write the halo factor into `target`, the size of the `width`×`height` G-buffer (`scale` texels
   * per CSS pixel), using `scratch` (same size) for the blur; `fast` trades grain for speed
   * (camera moving).
   */
  render(renderer: THREE.WebGLRenderer, src: { depth: THREE.Texture; normal: THREE.Texture; width: number; height: number; scale: number }, target: THREE.WebGLRenderTarget, scratch: THREE.WebGLRenderTarget, fast = false) {
    const u = this.mat.uniforms;
    u.tDepth.value = src.depth;
    u.tNormal.value = src.normal;
    u.texel.value.set(1 / src.width, 1 / src.height);
    u.projInv.value.copy(this.camera.projectionMatrixInverse);
    u.persp.value = (this.camera as THREE.PerspectiveCamera).isPerspectiveCamera === true;
    u.samples.value = fast ? FAST_SAMPLES : SAMPLES;
    u.radius.value = this.radius * src.scale;
    u.threshold.value = this.threshold;
    u.range.value = this.range;
    u.strength.value = this.strength;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
    const b = this.blurMat.uniforms;
    b.tDepth.value = src.depth;
    b.projInv.value.copy(this.camera.projectionMatrixInverse);
    for (const [from, to, x, y] of [[target, scratch, 1, 0], [scratch, target, 0, 1]] as const) {
      b.tHalo.value = from.texture;
      b.dir.value.set(x, y);
      renderer.setRenderTarget(to);
      this.blurQuad.render(renderer);
    }
    renderer.setRenderTarget(null);
  }

  dispose() {
    this.mat.dispose();
    this.quad.dispose();
    this.blurMat.dispose();
    this.blurQuad.dispose();
  }
}
