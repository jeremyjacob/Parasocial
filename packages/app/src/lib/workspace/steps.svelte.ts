// The Build view (A): plays an assembly's build script (builds/*.ts) in the viewport, one step at a
// time, with a film strip of the steps beside it. `pos` is where the playback is (0..steps, see
// steps-motion.ts); it eases toward `at`, the step asked for, so stepping, scrubbing and jumping all
// move the parts smoothly (far jumps run faster). Copies not brought in yet hide; the rest sit where
// the assembly puts them.
import * as THREE from 'three';
import { sourcePart, type AssemblyInfo, type BuildInfo } from '@parasocial/runtime/protocol';
import { Viewer } from '@parasocial/viewer';
import { mutators } from '@parasocial/sync';
import { planSteps, poseAt, type PlannedStep, type StepScene } from './steps-motion';
import { starterPath, starterScript } from './steps-starter';
import { viewerTheme } from './viewer-theme';
import { prefersReducedMotion } from '$lib/styles/tokens';
import type { WorkspaceState } from './state.svelte';

const SPEED_KEY = 'parasocial:stepsSpeed';
/** Seconds a finished step holds before the next plays. */
const DWELL = 0.7;
/** Seconds a jump of several steps takes at most. */
const JUMP = 0.6;
/** Film strip thumbnails (2× for sharp cards). */
const THUMB = { w: 400, h: 248 };
/** CSS px the film strip covers on the viewport's left (its width and inset). */
const STRIP = 244;

export class StepsController {
	/** Every build script in the document (from the engine). */
	builds = $state.raw<BuildInfo[]>([]);
	/** The Build view is open. */
	active = $state(false);
	/** The build script picked when an assembly has several. */
	chosen = $state<string | null>(null);
	/** The step asked for: this many steps done. */
	at = $state(0);
	/** Where the playback is (eases toward `at`). */
	pos = $state(0);
	playing = $state(false);
	/** Playback speed, ¼× to 4× (remembered per browser). */
	speed = $state(pref(SPEED_KEY, 1));
	/** The steps as laid out for the shown assembly. */
	steps = $state.raw<PlannedStep[]>([]);
	/** Film strip images, one per step (the assembly once that step is done, earlier parts faded back). */
	thumbs = $state.raw<(string | undefined)[]>([]);
	creating = $state(false);

	private raf = 0;
	private last = 0;
	private dwell = 0;
	private thumbKey = '';
	private thumbRun = 0;
	private thumbTimer: ReturnType<typeof setTimeout> | undefined;
	/** Object URLs of the images shown, revoked once replaced. */
	private prevThumbs: string[] = [];

	constructor(private ws: WorkspaceState) {}

	/** Re-read the build scripts after scripts change. */
	async refresh() {
		const engine = this.ws.engine;
		if (!engine) return;
		try {
			this.builds = await engine.builds();
		} catch {
			return;
		}
		if (this.active) this.replan();
	}

	/** The assemblies the shown studio exports. */
	get assemblies(): AssemblyInfo[] {
		return this.ws.studio?.assemblies ?? [];
	}

	/** The Build view needs an assembly on screen. */
	get available() {
		return this.assemblies.length > 0;
	}

	/** Build scripts for the shown assemblies (one that failed to load can't say which: listed after). */
	get options(): BuildInfo[] {
		const ids = new Set(this.assemblies.map((a) => a.id));
		return [...this.builds.filter((b) => ids.has(b.assembly)), ...this.builds.filter((b) => !b.assembly)];
	}

	get build(): BuildInfo | null {
		const o = this.options;
		return o.find((b) => b.id === this.chosen) ?? o[0] ?? null;
	}

	get assembly(): AssemblyInfo | null {
		return this.assemblies.find((a) => a.id === this.build?.assembly) ?? this.assemblies[0] ?? null;
	}

	/** The step whose card is current: the one playing, else the last one done. */
	get current() {
		const n = this.steps.length;
		if (!n) return -1;
		return Math.min(n - 1, Math.max(0, Math.ceil(this.pos - 1e-6) - 1));
	}

	toggle() {
		if (this.active) this.close();
		else this.open();
	}

	/** Open the Build view and play from the start. Takes the section's place. */
	open() {
		const v = this.ws.viewer;
		if (!this.available || !v) return;
		this.ws.section = null;
		// Space plays and pauses from here on: not a focused build button closing the view again
		(document.activeElement as HTMLElement | null)?.closest?.('button')?.blur();
		// framed on the finished assembly, before anything hides
		this.frame(v);
		this.active = true;
		v.setStepping(true);
		this.pos = this.at = 0;
		this.dwell = DWELL * 0.6;
		this.replan();
		this.playing = this.steps.length > 0;
		this.run();
	}

	/** Fit the camera to the assembly, centred in the part of the viewport the film strip leaves free. */
	private frame(v: Viewer) {
		const before = v.cameraState();
		v.fit(v.bounds(), false);
		const fit = v.cameraState();
		v.setCameraState(before, false);
		const w = v.container.clientWidth,
			h = Math.max(1, v.container.clientHeight);
		if (w < STRIP * 3) return v.setCameraState(fit);
		const pos = new THREE.Vector3().fromArray(fit.position),
			target = new THREE.Vector3().fromArray(fit.target);
		// world units per CSS px at the target
		const span = fit.ortho ? (fit.orthoHeight ?? 1) : 2 * pos.distanceTo(target) * Math.tan(THREE.MathUtils.degToRad(fit.fov / 2));
		const fwd = target.clone().sub(pos).normalize();
		const right = fwd.cross(new THREE.Vector3().fromArray(fit.up)).normalize();
		// moving the camera left slides the model right, by half the strip
		const shift = right.multiplyScalar(-(STRIP / 2) * (span / h));
		v.setCameraState({ ...fit, position: pos.add(shift).toArray(), target: target.add(shift).toArray() });
	}

	close() {
		if (!this.active) return;
		this.active = false;
		this.playing = false;
		cancelAnimationFrame(this.raf);
		this.raf = 0;
		clearTimeout(this.thumbTimer);
		this.ws.viewer?.setStepping(false);
	}

	/** Go to the state after `k` steps (0: nothing yet). */
	go(k: number) {
		this.at = Math.max(0, Math.min(this.steps.length, Math.round(k)));
		this.playing = false;
		this.run();
	}

	next() {
		this.go(this.at + 1);
	}

	prev() {
		this.go(this.at - 1);
	}

	/** Scrub: put the playback right at `pos` (no easing). */
	scrub(pos: number) {
		this.playing = false;
		this.pos = this.at = Math.max(0, Math.min(this.steps.length, pos));
		this.apply();
	}

	togglePlay() {
		if (!this.steps.length) return;
		if (!this.playing && this.at >= this.steps.length && this.pos >= this.steps.length) {
			// from the top
			this.pos = this.at = 0;
			this.dwell = DWELL * 0.6;
		}
		this.playing = !this.playing;
		this.run();
	}

	setSpeed(s: number) {
		this.speed = s;
		try {
			localStorage.setItem(SPEED_KEY, String(s));
		} catch {}
	}

	/** Lay the steps out again: the build, the copies' poses or their geometry changed. */
	replan() {
		const b = this.build,
			v = this.ws.viewer;
		if (!this.active || !v) return;
		const had = this.steps.length;
		this.steps = b ? planSteps(b, this.scene(v), sourcePart) : [];
		const n = this.steps.length;
		// steps just appeared (a new build script, or one fixed): play them from the top
		if (!had && n) (this.pos = this.at = 0), (this.dwell = DWELL * 0.6), (this.playing = true), this.run();
		if (this.at > n) this.at = n;
		if (this.pos > n) this.pos = n;
		this.apply();
		clearTimeout(this.thumbTimer);
		this.thumbTimer = setTimeout(() => void this.renderThumbs(), 250);
	}

	/** Pick another build script of the shown assembly. */
	choose(id: string) {
		this.chosen = id;
		this.pos = this.at = 0;
		this.replan();
		this.playing = this.steps.length > 0;
		this.run();
	}

	/** Write a first build script for the shown assembly and open it in the Build view. */
	async create() {
		const a = this.assembly,
			v = this.ws.viewer;
		if (!a || !v || this.ws.readOnly) return;
		this.creating = true;
		try {
			const path = starterPath(a, new Set(this.ws.scripts.map((s) => s.path)));
			const content = starterScript(a, {
				parts: this.ws.partInfos,
				assemblies: this.ws.asm.assemblies,
				partName: (id) => this.ws.results[id]?.name ?? this.ws.partInfos.find((p) => p.id === id)?.name ?? id,
				scene: {
					bounds: (id) => {
						const r = this.ws.results[id] ?? this.ws.results[sourcePart(id)];
						if (!r?.bbox) return null;
						const box = new THREE.Box3(new THREE.Vector3(...r.bbox.min), new THREE.Vector3(...r.bbox.max)).applyMatrix4(v.partTransform(id));
						const s = box.getSize(new THREE.Vector3());
						return { box, vol: r.mass?.volume ?? s.x * s.y * s.z };
					}
				}
			});
			await this.ws.zero.mutate(mutators.script.write({ documentID: this.ws.documentID, path, content, baseVersion: null, message: `Add build steps for ${a.name}` })).client;
			return path;
		} finally {
			this.creating = false;
		}
	}

	private scene(v: Viewer): StepScene {
		const results = this.ws.results;
		return {
			pose: (id) => v.partTransform(id),
			bbox: (id) => {
				const b = (results[id] ?? results[sourcePart(id)])?.bbox;
				return b ? new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max)) : null;
			},
			connector: (part, name, index) => {
				const f = results[part]?.connectors?.[name]?.[index ?? 0];
				return f ? { origin: new THREE.Vector3(...f.origin), z: new THREE.Vector3(...f.z).normalize() } : null;
			}
		};
	}

	/** Push where every copy is at `pos` to the viewer. */
	apply() {
		const v = this.ws.viewer;
		if (!v || !this.active) return;
		poseAt(this.steps, this.pos, (id, m) => v.setStepPose(id, m && !isIdentity(m) ? m : null, m === null));
	}

	private run() {
		if (this.raf || !this.active) return;
		this.last = performance.now();
		this.raf = requestAnimationFrame(this.tick);
	}

	private tick = (now: number) => {
		this.raf = 0;
		if (!this.active) return;
		const dt = Math.min(0.1, (now - this.last) / 1000);
		this.last = now;
		const n = this.steps.length;
		let { pos, at } = this;
		if (this.playing && pos === at) {
			this.dwell += dt * this.speed;
			if (at >= n) this.playing = false;
			else if (this.dwell >= DWELL) (at = this.at = at + 1), (this.dwell = 0);
		}
		if (pos !== at && n && prefersReducedMotion()) (this.pos = at), (this.dwell = 0), this.apply();
		else if (pos !== at && n) {
			const dir = Math.sign(at - pos);
			const k = Math.max(0, Math.min(n - 1, Math.floor(dir > 0 ? pos : pos - 1e-9)));
			// a step plays at its own length; far jumps catch up
			const gap = Math.abs(at - pos);
			const rate = Math.max(this.speed / this.steps[k].length, gap > 1.001 ? gap / JUMP : 0);
			pos += dir * rate * dt;
			if ((dir > 0 && pos >= at) || (dir < 0 && pos <= at)) (pos = at), (this.dwell = 0);
			this.pos = pos;
			this.apply();
		}
		if (this.pos !== this.at || this.playing) this.raf = requestAnimationFrame(this.tick);
	};

	/**
	 * One image per step from a small offscreen viewer: the copies brought in so far, where the
	 * assembly puts them, the earlier ones faded back so the step's own stand out; framed on the whole
	 * assembly from the current view direction.
	 */
	private async renderThumbs() {
		const v = this.ws.viewer,
			steps = this.steps;
		if (!v || !this.active || !steps.length) return void (this.thumbs = []);
		const dark = document.documentElement.dataset.theme === 'dark';
		const ids = steps.flatMap((s) => s.parts);
		const key = JSON.stringify([steps.map((s) => s.parts), dark, ids.map((id) => [this.ws.results[sourcePart(id)]?.key, v.partTransform(id).elements.map((x) => +x.toFixed(4))])]);
		if (key === this.thumbKey) return;
		this.thumbKey = key;
		const run = ++this.thumbRun;
		const host = document.createElement('div');
		host.style.cssText = `position:fixed;left:-10000px;top:0;width:${THUMB.w}px;height:${THUMB.h}px;pointer-events:none;contain:strict`;
		host.setAttribute('aria-hidden', 'true');
		document.body.appendChild(host);
		const t = new Viewer(host, { theme: viewerTheme(dark), viewCube: false, maxDpr: 1, reducedMotion: true });
		const urls: (string | undefined)[] = [];
		try {
			t.setHelpers({ grid: false, origin: false });
			t.ao = false;
			for (const id of ids) {
				const r = this.ws.results[id] ?? this.ws.results[sourcePart(id)];
				const mesh = this.ws.meshOf(id);
				if (!r || !mesh) continue;
				t.setPart({ id, mesh, faceEdges: r.faceEdges, vertices: r.vertices, hiddenEdges: new Set(r.edges.flatMap((e, i) => (e.seam || e.smooth ? [i] : []))), color: this.ws.partColor(id, dark), appearance: r.appearance });
				t.setPartTransform(id, v.partTransform(id).elements);
			}
			// the fit's bounding sphere is loose: frame a smaller box so the assembly fills the card
			const box = t.bounds();
			const c = box.getCenter(new THREE.Vector3());
			box.min.sub(c).multiplyScalar(0.72).add(c);
			box.max.sub(c).multiplyScalar(0.72).add(c);
			const cam = v.cameraState();
			const dir = new THREE.Vector3().fromArray(cam.position).sub(new THREE.Vector3().fromArray(cam.target));
			t.setProjection(cam.ortho);
			t.fit(box, false, dir);
			for (let k = 0; k < steps.length; k++) {
				const done = new Set(steps.slice(0, k + 1).flatMap((s) => s.parts));
				const fresh = new Set(steps[k].parts);
				for (const id of ids) t.setVisible(id, done.has(id)), t.setDimmed(id, !fresh.has(id));
				const blob = await t.snapshot('image/webp', 0.85);
				if (run !== this.thumbRun) return;
				urls.push(URL.createObjectURL(blob));
				// show them as they come (the previous images stand in until replaced)
				this.thumbs = [...urls, ...this.thumbs.slice(urls.length, steps.length)];
			}
			for (const u of this.prevThumbs) URL.revokeObjectURL(u);
			this.prevThumbs = urls.filter((u): u is string => !!u);
			this.thumbs = urls;
		} catch (e) {
			console.warn('build step thumbnails', e);
		} finally {
			t.dispose();
			host.remove();
		}
	}
}

const ID = new THREE.Matrix4();
const isIdentity = (m: THREE.Matrix4) => m.equals(ID);

function pref(key: string, fallback: number): number {
	try {
		const v = Number(localStorage.getItem(key));
		return Number.isFinite(v) && v > 0 ? v : fallback;
	} catch {
		return fallback;
	}
}
