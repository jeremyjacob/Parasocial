import init from "replicad-opencascadejs";
import { fileURLToPath } from "node:url";
const wasm = fileURLToPath(import.meta.resolve("replicad-opencascadejs/wasm"));
let t = performance.now();
const oc: any = await init({ locateFile: () => wasm });
console.log("init ms", (performance.now() - t).toFixed(0));

function listToArray(l: any) { const c = new oc.NCollection_List_TopoDS_Shape(l); const out = []; while (c.Size() > 0) { out.push(c.First()); c.RemoveFirst(); } c.delete(); return out; }
const H = (s:any) => oc.ReplicadShapeHasher.HashCode(s, 2147483647);
function sub(shape: any, kind: any) { const out:any[] = []; const seen = new Map<number, any[]>(); const e = new oc.TopExp_Explorer(shape, kind, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); for (; e.More(); e.Next()) { const c = e.Current(); const h = H(c); const b = seen.get(h) ?? []; if (b.some((x:any)=>x.IsSame(c))) continue; b.push(c); seen.set(h,b); out.push(c);} e.delete(); return out; }
const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE, EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE;

// sketch face -> prism
const pts = [[0,0],[40,0],[40,25],[0,25]].map(([x,y]) => new oc.gp_Pnt(x,y,0));
const wmk = new oc.BRepBuilderAPI_MakeWire();
for (let i=0;i<4;i++) wmk.Add(new oc.BRepBuilderAPI_MakeEdge(pts[i], pts[(i+1)%4]).Edge());
const wire = wmk.Wire();
const faceMk = new oc.BRepBuilderAPI_MakeFace(wire, true);
const face = faceMk.Face();
const prism = new oc.BRepPrimAPI_MakePrism(face, new oc.gp_Vec(0,0,3), false, true);
const solid = prism.Shape();
console.log("faces", sub(solid, FACE).length, "edges", sub(solid, EDGE).length);
const sketchEdges = sub(wire, EDGE);
sketchEdges.forEach((e, i) => console.log("sketch edge", i, "generated", listToArray(prism.Generated(e)).map((s:any)=>s.ShapeType())));
console.log("first", prism.FirstShape().ShapeType(), "last", prism.LastShape().ShapeType());
// fillet vertical edges
const mk = new oc.BRepFilletAPI_MakeFillet(solid, oc.ChFi3d_FilletShape.ChFi3d_Rational);
const edges = sub(solid, EDGE);
let added = 0;
for (const e of edges) { const c = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e)); const d = c.Value(c.LastParameter()).Z() - c.Value(c.FirstParameter()).Z(); if (Math.abs(d) > 1) { mk.Add(2, oc.TopoDS.Edge(e)); added++; } }
mk.Build(new oc.Message_ProgressRange());
const f = mk.Shape();
console.log("fillet added", added, "faces", sub(f, FACE).length);
for (const fc of sub(solid, FACE)) console.log(" face modified->", listToArray(mk.Modified(fc)).length, "deleted", mk.IsDeleted(fc));
for (const e of edges.slice(0,4)) console.log(" edge generated->", listToArray(mk.Generated(e)).length);
// boolean cut w/ history
const cyl = new oc.BRepPrimAPI_MakeCylinder(new oc.gp_Ax2(new oc.gp_Pnt(20,12.5,-1), new oc.gp_Dir(0,0,1)), 4, 5).Shape();
const cut = new oc.BRepAlgoAPI_Cut(f, cyl, new oc.Message_ProgressRange());
const r = cut.Shape();
console.log("cut faces", sub(r, FACE).length);
for (const fc of sub(cyl, FACE)) console.log(" tool face modified->", listToArray(cut.Modified(fc)).length, "deleted", cut.IsDeleted(fc));
const hasher = oc.ReplicadShapeHasher ? Object.getOwnPropertyNames(oc.ReplicadShapeHasher) : null; console.log("hasher", hasher);
t = performance.now();
const m = oc.ReplicadMeshExtractor.extract(r, 0.1, 0.5, false);
console.log("mesh ms", (performance.now()-t).toFixed(1), "verts", m.getVerticesSize()/3, "tris", m.getTrianglesSize()/3, "groups", m.getFaceGroupsSize()/3);
const em = oc.ReplicadEdgeMeshExtractor.extract(r, 0.1, 0.5);
console.log("edge mesh methods", Object.getOwnPropertyNames(Object.getPrototypeOf(em)));
