import type { AssemblyInfo, AssemblyJoint } from '@parasocial/runtime/protocol';

const definition = (id: string, name: string): AssemblyInfo => ({ id, name, studio: name, file: `studios/${id}.ts`, export: 'default', instances: [], subs: [], fixed: [], joints: [], relations: [], problems: [] });
const joint = (scope: string, name: string, a: string, b: string): AssemblyJoint => ({ scope, name, a, b, type: 'revolute', named: true, at: { frame: { origin: [0, 0, 0], z: [0, 0, 1], x: [1, 0, 0] } }, limits: [null], value: [0], overlap: false });

export function nestedAssemblies(): AssemblyInfo[] {
	const rack = definition('rack', 'Rack');
	rack.subs = [
		{ id: 'rack/module@left', parent: 'rack', assembly: 'module', name: 'left' },
		{ id: 'rack/module@left/hinge@door', parent: 'rack/module@left', assembly: 'hinge', name: 'door' },
		{ id: 'rack/module@left2', parent: 'rack', assembly: 'module', name: 'left2' }
	];
	rack.instances = [
		{ id: 'rack/parts:base', part: 'parts:base', scope: 'rack' },
		{ id: 'rack/module@left/parts:base', part: 'parts:base', scope: 'rack/module@left' },
		{ id: 'rack/module@left/hinge@door/parts:base', part: 'parts:base', scope: 'rack/module@left/hinge@door' },
		{ id: 'rack/module@left/hinge@door/parts:lid', part: 'parts:lid', scope: 'rack/module@left/hinge@door' },
		{ id: 'rack/module@left2/parts:base', part: 'parts:base', scope: 'rack/module@left2' },
		{ id: 'rack/module@left2/parts:lid', part: 'parts:lid', scope: 'rack/module@left2', name: 'copy' }
	];
	rack.joints = [
		joint('rack/module@left/hinge@door', 'module@left/hinge@door/open', rack.instances[2].id, rack.instances[3].id),
		joint('rack/module@left2', 'module@left2/open', rack.instances[4].id, rack.instances[5].id)
	];
	return [rack, definition('module', 'Module'), definition('hinge', 'Hinge')];
}
