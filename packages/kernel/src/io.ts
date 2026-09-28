// Export: STEP (B-rep) and STL (mesh), through the Emscripten virtual filesystem.
import { oc } from "./oc";
import { scoped, tmp } from "./memory";
import { KernelError } from "./ops";
import { downcast, type Shape } from "./topo";

function readAndRemove(path: string): Uint8Array {
  const O = oc() as any;
  const bytes: Uint8Array = O.FS.readFile(path);
  O.FS.unlink(path);
  return bytes;
}

export function exportSTEP(shape: Shape): Uint8Array {
  const O = oc() as any;
  return scoped(() => {
    const w = tmp(new O.STEPControl_Writer());
    const status = w.Transfer(shape, O.STEPControl_StepModelType.STEPControl_AsIs, true, tmp(new O.Message_ProgressRange()));
    if (status !== O.IFSelect_ReturnStatus.IFSelect_RetDone) throw new KernelError("STEP export failed (transfer)");
    const path = `/export-${Date.now()}.step`;
    if (w.Write(path) !== O.IFSelect_ReturnStatus.IFSelect_RetDone) throw new KernelError("STEP export failed (write)");
    return readAndRemove(path);
  });
}

export function exportSTL(shape: Shape, tolerance = 0.01, angular = 0.2): Uint8Array {
  const O = oc() as any;
  return scoped(() => {
    O.ReplicadMeshExtractor.mesh(shape, tolerance, angular);
    const w = tmp(new O.StlAPI_Writer());
    const path = `/export-${Date.now()}.stl`;
    if (!w.Write(shape, path, tmp(new O.Message_ProgressRange()))) throw new KernelError("STL export failed");
    return readAndRemove(path);
  });
}

/** OCCT's native B-rep text: a lossless copy of a shape (sub-shape order included) for another kernel instance. */
export function writeBrep(shape: Shape): string {
  return (oc() as any).BRepToolsWrapper.Write(shape);
}

export function readBrep(brep: string): Shape {
  const s = (oc() as any).BRepToolsWrapper.Read(brep);
  if (!s || s.IsNull()) throw new KernelError("B-rep read failed");
  const d = downcast(s);
  if (d !== s) s.delete();
  return d;
}
