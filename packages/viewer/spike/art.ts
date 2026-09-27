// Clay renders of the example parts for empty states (§8): made with our engine, one studio
// lighting setup, grayscale, transparent background. Driven by scripts/render-art.ts.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EngineClient } from "@parasocial/runtime/browser/client";

const engine = new EngineClient({ engineUrl: "http://localhost:5181/" });
const SCRIPTS = (window as any).SCRIPTS as Record<string, Record<string, string>>;

type Item = { doc: string; part: string; at?: [number, number, number]; rotZ?: number; rotX?: number; overrides?: Record<string, number> };

async function meshFor(it: Item) {
  await engine.setDocument({ scripts: SCRIPTS[it.doc], overrides: { [it.part]: it.overrides ?? {} } });
  const r = (await engine.regenerate(it.part, "fine"))!;
  const m = r.mesh!;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  return g;
}

(window as any).renderArt = async (items: Item[], o: { width: number; height: number; dark: boolean; view?: [number, number, number]; zoom?: number }) => {
  await engine.ready;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(o.width, o.height);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = o.dark ? 0.45 : 0.6;
  const clay = new THREE.MeshStandardMaterial({ color: o.dark ? 0x75757b : 0xd2d2cf, roughness: 0.7, metalness: 0 });
  const group = new THREE.Group();
  for (const it of items) {
    const mesh = new THREE.Mesh(await meshFor(it), clay);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.rotation.set(it.rotX ?? 0, 0, it.rotZ ?? 0);
    if (it.at) mesh.position.set(...it.at);
    group.add(mesh);
  }
  scene.add(group);
  const box = new THREE.Box3().setFromObject(group);
  group.position.z -= box.min.z; // sit on the floor
  box.setFromObject(group);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const key = new THREE.DirectionalLight(0xffffff, o.dark ? 1.6 : 2.2);
  key.position.set(sphere.center.x - sphere.radius * 1.2, sphere.center.y - sphere.radius * 0.8, sphere.radius * 3);
  key.target.position.copy(sphere.center);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.radius = 18;
  key.shadow.blurSamples = 24;
  const s = sphere.radius * 5;
  Object.assign(key.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 0.1, far: sphere.radius * 8 });
  scene.add(key, key.target, new THREE.HemisphereLight(0xffffff, 0x9a9aa0, o.dark ? 0.35 : 0.5));
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(sphere.radius * 12, sphere.radius * 12), new THREE.ShadowMaterial({ opacity: o.dark ? 0.35 : 0.16 }));
  floor.position.set(sphere.center.x, sphere.center.y, 0);
  floor.receiveShadow = true;
  scene.add(floor);
  const cam = new THREE.PerspectiveCamera(24, o.width / o.height, 1, sphere.radius * 50);
  cam.up.set(0, 0, 1);
  const dir = new THREE.Vector3(...(o.view ?? [1, -1.25, 0.9])).normalize();
  const dist = (sphere.radius / Math.sin(THREE.MathUtils.degToRad(12))) * (o.zoom ?? 1);
  cam.position.copy(sphere.center).add(dir.multiplyScalar(dist));
  cam.lookAt(sphere.center);
  renderer.render(scene, cam);
  const url = renderer.domElement.toDataURL("image/png");
  renderer.dispose();
  return url;
};
(window as any).artReady = true;
