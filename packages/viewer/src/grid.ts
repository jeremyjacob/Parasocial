// Infinite ground grid: one camera-following quad whose fragment shader draws anti-aliased
// lines at three decades of spacing (step, 10·step, 100·step). Each decade fades out as its
// cells shrink toward a few pixels, so the grid never turns to moiré, and the whole thing
// fades with distance so it melts into the horizon instead of ending at an edge.
import * as THREE from "three";

const vertexShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform vec2 uCenter;
varying vec2 vLocal;
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  // relative to a center snapped to the coarsest decade, so fract() keeps its precision far out
  vLocal = w.xy - uCenter;
  gl_Position = projectionMatrix * viewMatrix * w;
  // push the grid a fixed fraction of its distance away from the camera, so faces lying in the
  // ground plane always win the depth test instead of z-fighting with it (a world-space offset
  // is lost to depth precision once the camera backs off)
  #if defined( USE_REVERSED_DEPTH_BUFFER )
  gl_Position.z *= 1.0 - GRID_DEPTH_PUSH;
  #elif !defined( USE_LOGARITHMIC_DEPTH_BUFFER )
  gl_Position.z += GRID_DEPTH_PUSH * 0.25 * gl_Position.w;
  #endif
  #include <logdepthbuf_vertex>
  #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  vFragDepth *= 1.0 + GRID_DEPTH_PUSH;
  #endif
}`;

const fragmentShader = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uStep;
uniform vec3 uMinor;
uniform vec3 uMajor;
uniform float uFade;
varying vec2 vLocal;
varying vec3 vWorld;

// coverage of 1px lines every s world units, plus how visible that decade should be
float lines(vec2 p, vec2 fw, float s) {
  vec2 d = abs(fract(p / s - 0.5) - 0.5) * s / fw; // px to the nearest line, per axis
  float cov = clamp(1.0 - min(d.x, d.y), 0.0, 1.0);
  float px = s / max(fw.x, fw.y); // cell size on screen
  return cov * smoothstep(5.0, 14.0, px);
}

void main() {
  #include <logdepthbuf_fragment>
  vec2 fw = max(fwidth(vLocal), vec2(1e-6));
  float a1 = lines(vLocal, fw, uStep) * 0.9;
  float a2 = max(lines(vLocal, fw, uStep * 10.0), lines(vLocal, fw, uStep * 100.0));
  float a = max(a1, a2);
  float fade = 1.0 - smoothstep(uFade * 0.25, uFade, distance(cameraPosition, vWorld));
  a *= fade;
  if (a < 0.003) discard;
  gl_FragColor = vec4(a2 >= a1 ? uMajor : uMinor, a);
  #include <colorspace_fragment>
}`;

export class InfiniteGrid {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private step = 1;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      defines: { GRID_DEPTH_PUSH: "0.002" },
      uniforms: {
        uCenter: { value: new THREE.Vector2() },
        uStep: { value: 1 },
        uMinor: { value: new THREE.Color() },
        uMajor: { value: new THREE.Color() },
        uFade: { value: 1000 },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
  }

  configure(step: number, z: number, minor: string, major: string) {
    this.step = step;
    this.mat.uniforms.uStep.value = step;
    (this.mat.uniforms.uMinor.value as THREE.Color).set(minor);
    (this.mat.uniforms.uMajor.value as THREE.Color).set(major);
    this.mesh.position.z = z;
  }

  /** Follow the camera: cover everything out to the far plane, fading out just before it. */
  update(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera, target: THREE.Vector3) {
    const ortho = (camera as THREE.OrthographicCamera).isOrthographicCamera;
    const dist = camera.position.distanceTo(target);
    let reach: number;
    if (ortho) {
      const c = camera as THREE.OrthographicCamera;
      const extent = Math.max(c.right - c.left, c.top - c.bottom) / c.zoom;
      reach = dist + extent * 8;
    } else reach = (camera as THREE.PerspectiveCamera).far * 0.95;
    const snap = this.step * 100;
    const cx = Math.round(camera.position.x / snap) * snap,
      cy = Math.round(camera.position.y / snap) * snap;
    this.mesh.position.x = cx;
    this.mesh.position.y = cy;
    this.mesh.scale.set(reach * 2 + snap, reach * 2 + snap, 1);
    this.mesh.updateMatrixWorld();
    this.mat.uniforms.uCenter.value.set(cx, cy);
    this.mat.uniforms.uFade.value = reach;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
