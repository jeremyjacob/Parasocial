// Depth darkening (Onshape-like; Luft et al., "Image Enhancement by Unsharp Masking the Depth
// Buffer", 2006): where a nearer surface overlaps a farther one, the farther one darkens softly
// along the nearer one's outline, in proportion to how far behind it sits, so overlapping shapes
// separate at a glance. Each pixel samples a disc and sums how far its neighbors stand in front of
// its own surface (the local depth plane, so a surface sloping away never shadows itself). Small
// steps (chamfers, rims) fall in a dead zone; the gap is measured against the model's size.
//
// It is also where ambient occlusion lands: the pass multiplies AO × halo straight onto the
// canvas (DstColor blending) right after the faces are drawn, before edges and helpers, so no
// full-resolution intermediate target is needed and lines stay crisp and un-darkened.
import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

const SAMPLES = 48;

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
  private dpr = 1;
  private mat: THREE.ShaderMaterial;
  private quad: FullScreenQuad;

  /** AO darkening, 0–1 (1 = the AO buffer as computed). */
  aoIntensity = 1;

  constructor(
    camera: THREE.Camera,
    private depth: () => THREE.Texture,
    private ao: () => THREE.Texture,
  ) {
    this.camera = camera;
    this.mat = new THREE.ShaderMaterial({
      defines: { SAMPLES },
      uniforms: {
        tAO: { value: null },
        tDepth: { value: null },
        aoIntensity: { value: 1 },
        projInv: { value: new THREE.Matrix4() },
        texel: { value: new THREE.Vector2() },
        radius: { value: 1 },
        threshold: { value: 1 },
        range: { value: 1 },
        strength: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tAO, tDepth;
        uniform float aoIntensity;
        uniform mat4 projInv;
        uniform vec2 texel;
        uniform float radius, threshold, range, strength;
        varying vec2 vUv;

        // distance along the view axis; background reads as infinitely far
        float dist(vec2 uv) {
          float d = textureLod(tDepth, uv, 0.0).x;
          #ifdef USE_REVERSED_DEPTH_BUFFER
            if (d <= 0.0) return 1e20;
            vec4 c = vec4(uv * 2.0 - 1.0, d, 1.0);
          #else
            if (d >= 1.0) return 1e20;
            vec4 c = vec4(vec3(uv, d) * 2.0 - 1.0, 1.0);
          #endif
          vec4 v = projInv * c;
          return -v.z / v.w;
        }

        // applied to the sRGB-encoded canvas as is: perceptually stronger than a linear-light
        // multiply, which is the look we want for contact shading
        void shade(float factor) { gl_FragColor = vec4(vec3(clamp(factor, 0.0, 1.0)), 1.0); }

        void main() {
          float z = dist(vUv);
          if (z >= 1e19) { shade(1.0); return; }
          float ao = mix(1.0, textureLod(tAO, vUv, 0.0).r, aoIntensity);
          // local depth slope per texel, from the smoother side (so an edge next door doesn't skew it)
          float xp = dist(vUv + vec2(texel.x, 0.0)) - z, xm = z - dist(vUv - vec2(texel.x, 0.0));
          float yp = dist(vUv + vec2(0.0, texel.y)) - z, ym = z - dist(vUv - vec2(0.0, texel.y));
          vec2 slope = vec2(abs(xp) < abs(xm) ? xp : xm, abs(yp) < abs(ym) ? yp : ym);
          if (abs(slope.x) > 1e18) slope.x = 0.0;
          if (abs(slope.y) > 1e18) slope.y = 0.0;
          // Vogel disc, rotated per pixel (interleaved gradient noise): fine grain instead of rings
          float rot = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          float occ = 0.0, wsum = 0.0;
          for (int i = 0; i < SAMPLES; i++) {
            float f = (float(i) + 0.5) / float(SAMPLES);
            float a = float(i) * 2.399963 + rot;
            vec2 o = sqrt(f) * radius * vec2(cos(a), sin(a));
            float w = exp(-3.0 * f); // gaussian in r: dark at the outline, a long soft tail
            float gap = z + dot(slope, o) - dist(vUv + o * texel);
            occ += w * clamp((gap - threshold) / range, 0.0, 1.0);
            wsum += w;
          }
          // a straight outline covers ~half the disc: that reads as full strength
          float k = min(1.0, 2.0 * occ / wsum);
          shade(ao * (1.0 - strength * k));
        }`,
      // multiply onto whatever is already on the canvas (the faces)
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.ZeroFactor,
      blendEquation: THREE.AddEquation,
    });
    this.quad = new FullScreenQuad(this.mat);
  }

  setPixelRatio(dpr: number) {
    this.dpr = dpr;
  }

  setSize(width: number, height: number) {
    this.mat.uniforms.texel.value.set(1 / width, 1 / height);
  }

  /** Multiply AO × halo onto the canvas. */
  render(renderer: THREE.WebGLRenderer) {
    const u = this.mat.uniforms;
    u.tAO.value = this.ao();
    u.tDepth.value = this.depth();
    u.aoIntensity.value = this.aoIntensity;
    u.projInv.value.copy(this.camera.projectionMatrixInverse);
    u.radius.value = this.radius * this.dpr;
    u.threshold.value = this.threshold;
    u.range.value = this.range;
    u.strength.value = this.strength;
    renderer.setRenderTarget(null);
    this.quad.render(renderer);
  }

  dispose() {
    this.mat.dispose();
    this.quad.dispose();
  }
}
