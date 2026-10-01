// Standard part data (mm), as plain objects. Values are nominal/maximum dimensions from the
// standards named on each table; check a supplier's datasheet for anything critical.

/** Metric coarse thread sizes covered by the screw, nut, washer and hole tables. */
export type MetricSize = "M2" | "M2.5" | "M3" | "M4" | "M5" | "M6" | "M8" | "M10";

/**
 * ISO 261 coarse pitch, ISO 273 clearance holes (fine / medium / coarse series) and the usual
 * tap drill (≈ d − pitch) for each size.
 */
export const METRIC: Readonly<Record<MetricSize, { d: number; pitch: number; close: number; normal: number; loose: number; tap: number }>> = {
  M2: { d: 2, pitch: 0.4, close: 2.2, normal: 2.4, loose: 2.6, tap: 1.6 },
  "M2.5": { d: 2.5, pitch: 0.45, close: 2.7, normal: 2.9, loose: 3.1, tap: 2.05 },
  M3: { d: 3, pitch: 0.5, close: 3.2, normal: 3.4, loose: 3.6, tap: 2.5 },
  M4: { d: 4, pitch: 0.7, close: 4.3, normal: 4.5, loose: 4.8, tap: 3.3 },
  M5: { d: 5, pitch: 0.8, close: 5.3, normal: 5.5, loose: 5.8, tap: 4.2 },
  M6: { d: 6, pitch: 1, close: 6.4, normal: 6.6, loose: 7, tap: 5 },
  M8: { d: 8, pitch: 1.25, close: 8.4, normal: 9, loose: 10, tap: 6.8 },
  M10: { d: 10, pitch: 1.5, close: 10.5, normal: 11, loose: 12, tap: 8.5 },
};

/** Screw head standards: socket head cap, button head, countersunk socket head. */
export type HeadStandard = "ISO4762" | "ISO7380" | "ISO10642";

/**
 * Head dimensions: `dk` head diameter (max; theoretical for ISO 10642), `k` head height, `s` hex key
 * size, `t` socket depth (min), `cbore` counterbore diameter (DIN 974-1 for ISO 4762; head + ~0.8
 * for ISO 7380), or `csink` countersink diameter (ISO 10642: the theoretical head diameter, so the
 * head sits flush or slightly below). ISO 7380-1 starts at M3 and ISO 10642 at M3.
 */
export const HEADS: Readonly<Record<HeadStandard, Partial<Record<MetricSize, { dk: number; k: number; s: number; t: number; cbore?: number; csink?: number }>>>> = {
  ISO4762: {
    M2: { dk: 3.8, k: 2, s: 1.5, t: 1, cbore: 4.3 },
    "M2.5": { dk: 4.5, k: 2.5, s: 2, t: 1.1, cbore: 5 },
    M3: { dk: 5.5, k: 3, s: 2.5, t: 1.3, cbore: 6.5 },
    M4: { dk: 7, k: 4, s: 3, t: 2, cbore: 8 },
    M5: { dk: 8.5, k: 5, s: 4, t: 2.5, cbore: 10 },
    M6: { dk: 10, k: 6, s: 5, t: 3, cbore: 11 },
    M8: { dk: 13, k: 8, s: 6, t: 4, cbore: 15 },
    M10: { dk: 16, k: 10, s: 8, t: 5, cbore: 18 },
  },
  ISO7380: {
    M3: { dk: 5.7, k: 1.65, s: 2, t: 1.04, cbore: 6.5 },
    M4: { dk: 7.6, k: 2.2, s: 2.5, t: 1.3, cbore: 8.5 },
    M5: { dk: 9.5, k: 2.75, s: 3, t: 1.56, cbore: 10.5 },
    M6: { dk: 10.5, k: 3.3, s: 4, t: 2.08, cbore: 11.5 },
    M8: { dk: 14, k: 4.4, s: 5, t: 2.6, cbore: 15 },
    M10: { dk: 17.5, k: 5.5, s: 6, t: 3.12, cbore: 18.5 },
  },
  ISO10642: {
    M3: { dk: 6.72, k: 1.86, s: 2, t: 1.1, csink: 6.72 },
    M4: { dk: 8.96, k: 2.48, s: 2.5, t: 1.5, csink: 8.96 },
    M5: { dk: 11.2, k: 3.1, s: 3, t: 1.9, csink: 11.2 },
    M6: { dk: 13.44, k: 3.72, s: 4, t: 2.2, csink: 13.44 },
    M8: { dk: 17.92, k: 4.96, s: 5, t: 3, csink: 17.92 },
    M10: { dk: 22.4, k: 6.2, s: 6, t: 3.6, csink: 22.4 },
  },
};

/** ISO 4032 hex nuts: `s` width across flats, `m` height. */
export const NUTS: Readonly<Record<MetricSize, { s: number; m: number }>> = {
  M2: { s: 4, m: 1.6 },
  "M2.5": { s: 5, m: 2 },
  M3: { s: 5.5, m: 2.4 },
  M4: { s: 7, m: 3.2 },
  M5: { s: 8, m: 4.7 },
  M6: { s: 10, m: 5.2 },
  M8: { s: 13, m: 6.8 },
  M10: { s: 16, m: 8.4 },
};

/** ISO 7089 plain washers: `d1` inner, `d2` outer diameter, `h` thickness. */
export const WASHERS: Readonly<Record<MetricSize, { d1: number; d2: number; h: number }>> = {
  M2: { d1: 2.2, d2: 5, h: 0.3 },
  "M2.5": { d1: 2.7, d2: 6, h: 0.5 },
  M3: { d1: 3.2, d2: 7, h: 0.5 },
  M4: { d1: 4.3, d2: 9, h: 0.8 },
  M5: { d1: 5.3, d2: 10, h: 1 },
  M6: { d1: 6.4, d2: 12, h: 1.6 },
  M8: { d1: 8.4, d2: 16, h: 1.6 },
  M10: { d1: 10.5, d2: 20, h: 2 },
};

/**
 * Threaded heat-set inserts for plastics (Ruthex / CNC Kitchen style, "size x length"): `d` thread,
 * `od` outer (knurl) diameter, `l` length, `hole` recommended hole diameter in the print.
 */
export const INSERTS = {
  "M2x3": { d: 2, od: 3.6, l: 3, hole: 3.2 },
  "M2.5x4": { d: 2.5, od: 4.6, l: 4, hole: 4 },
  "M3x3": { d: 3, od: 4.6, l: 3, hole: 4 },
  "M3x4": { d: 3, od: 4.6, l: 4, hole: 4 },
  "M3x5.7": { d: 3, od: 4.6, l: 5.7, hole: 4 },
  "M4x8.1": { d: 4, od: 6.3, l: 8.1, hole: 5.6 },
  "M5x9.5": { d: 5, od: 7.1, l: 9.5, hole: 6.4 },
  "M6x12.7": { d: 6, od: 8.7, l: 12.7, hole: 8 },
} as const satisfies Record<string, { d: number; od: number; l: number; hole: number }>;
export type InsertSize = keyof typeof INSERTS;

/** Deep-groove ball bearings (ISO 15): `d` bore, `D` outside diameter, `B` width. */
export const BEARINGS = {
  // MR miniature series
  MR63: { d: 3, D: 6, B: 2.5 },
  MR74: { d: 4, D: 7, B: 2.5 },
  MR85: { d: 5, D: 8, B: 2.5 },
  MR105: { d: 5, D: 10, B: 4 },
  MR115: { d: 5, D: 11, B: 4 },
  MR128: { d: 8, D: 12, B: 3.5 },
  MR148: { d: 8, D: 14, B: 4 },
  // 6xx
  "623": { d: 3, D: 10, B: 4 },
  "624": { d: 4, D: 13, B: 5 },
  "625": { d: 5, D: 16, B: 5 },
  "626": { d: 6, D: 19, B: 6 },
  "627": { d: 7, D: 22, B: 7 },
  "608": { d: 8, D: 22, B: 7 },
  "609": { d: 9, D: 24, B: 7 },
  // 68x / 680x (thin section)
  "683": { d: 3, D: 7, B: 2 },
  "684": { d: 4, D: 9, B: 2.5 },
  "685": { d: 5, D: 11, B: 3 },
  "686": { d: 6, D: 13, B: 3.5 },
  "687": { d: 7, D: 14, B: 3.5 },
  "688": { d: 8, D: 16, B: 4 },
  "689": { d: 9, D: 17, B: 4 },
  "6800": { d: 10, D: 19, B: 5 },
  "6801": { d: 12, D: 21, B: 5 },
  "6802": { d: 15, D: 24, B: 5 },
  "6803": { d: 17, D: 26, B: 5 },
  "6804": { d: 20, D: 32, B: 7 },
  "6805": { d: 25, D: 37, B: 7 },
  // 69x / 690x
  "693": { d: 3, D: 8, B: 3 },
  "694": { d: 4, D: 11, B: 4 },
  "695": { d: 5, D: 13, B: 4 },
  "696": { d: 6, D: 15, B: 5 },
  "697": { d: 7, D: 17, B: 5 },
  "698": { d: 8, D: 19, B: 6 },
  "699": { d: 9, D: 20, B: 6 },
  "6900": { d: 10, D: 22, B: 6 },
  "6901": { d: 12, D: 24, B: 6 },
  "6902": { d: 15, D: 28, B: 7 },
  "6903": { d: 17, D: 30, B: 7 },
  "6904": { d: 20, D: 37, B: 9 },
  "6905": { d: 25, D: 42, B: 9 },
  // 60xx
  "6000": { d: 10, D: 26, B: 8 },
  "6001": { d: 12, D: 28, B: 8 },
  "6002": { d: 15, D: 32, B: 9 },
  "6003": { d: 17, D: 35, B: 10 },
  "6004": { d: 20, D: 42, B: 12 },
  "6005": { d: 25, D: 47, B: 12 },
  // 62xx
  "6200": { d: 10, D: 30, B: 9 },
  "6201": { d: 12, D: 32, B: 10 },
  "6202": { d: 15, D: 35, B: 11 },
  "6203": { d: 17, D: 40, B: 12 },
  "6204": { d: 20, D: 47, B: 14 },
  "6205": { d: 25, D: 52, B: 15 },
} as const satisfies Record<string, { d: number; D: number; B: number }>;
export type BearingSize = keyof typeof BEARINGS;

/**
 * DIN 471 retaining rings for shafts: `s` ring thickness, `d2` groove diameter, `m` groove width
 * (min), `b` radial ring width (approx.), keyed by shaft diameter d1.
 */
export const DIN471: Readonly<Record<number, { s: number; d2: number; m: number; b: number }>> = {
  3: { s: 0.4, d2: 2.8, m: 0.5, b: 0.8 },
  4: { s: 0.4, d2: 3.8, m: 0.5, b: 0.9 },
  5: { s: 0.6, d2: 4.8, m: 0.7, b: 1.1 },
  6: { s: 0.7, d2: 5.7, m: 0.8, b: 1.3 },
  7: { s: 0.8, d2: 6.7, m: 0.9, b: 1.4 },
  8: { s: 0.8, d2: 7.6, m: 0.9, b: 1.5 },
  9: { s: 1, d2: 8.6, m: 1.1, b: 1.7 },
  10: { s: 1, d2: 9.6, m: 1.1, b: 1.8 },
  12: { s: 1, d2: 11.5, m: 1.1, b: 1.8 },
  14: { s: 1, d2: 13.4, m: 1.1, b: 2.1 },
  15: { s: 1, d2: 14.3, m: 1.1, b: 2.2 },
  16: { s: 1, d2: 15.2, m: 1.1, b: 2.2 },
  17: { s: 1, d2: 16.2, m: 1.1, b: 2.3 },
  18: { s: 1.2, d2: 17, m: 1.3, b: 2.4 },
  20: { s: 1.2, d2: 19, m: 1.3, b: 2.6 },
  22: { s: 1.2, d2: 21, m: 1.3, b: 2.8 },
  25: { s: 1.2, d2: 23.9, m: 1.3, b: 3 },
};

/**
 * DIN 472 retaining rings for bores: `s` ring thickness, `d2` groove diameter, `m` groove width
 * (min), `b` radial ring width (approx.), keyed by bore diameter d1.
 */
export const DIN472: Readonly<Record<number, { s: number; d2: number; m: number; b: number }>> = {
  8: { s: 0.8, d2: 8.4, m: 0.9, b: 1.1 },
  9: { s: 0.8, d2: 9.4, m: 0.9, b: 1.3 },
  10: { s: 1, d2: 10.4, m: 1.1, b: 1.4 },
  12: { s: 1, d2: 12.5, m: 1.1, b: 1.7 },
  13: { s: 1, d2: 13.6, m: 1.1, b: 1.8 },
  14: { s: 1, d2: 14.6, m: 1.1, b: 1.9 },
  15: { s: 1, d2: 15.7, m: 1.1, b: 2 },
  16: { s: 1, d2: 16.8, m: 1.1, b: 2 },
  17: { s: 1, d2: 17.8, m: 1.1, b: 2.1 },
  19: { s: 1, d2: 20, m: 1.1, b: 2.2 },
  20: { s: 1, d2: 21, m: 1.1, b: 2.3 },
  22: { s: 1, d2: 23, m: 1.1, b: 2.5 },
  24: { s: 1.2, d2: 25.2, m: 1.3, b: 2.6 },
  26: { s: 1.2, d2: 27.2, m: 1.3, b: 2.8 },
  28: { s: 1.2, d2: 29.4, m: 1.3, b: 2.9 },
  32: { s: 1.2, d2: 33.7, m: 1.3, b: 3.2 },
  35: { s: 1.5, d2: 37, m: 1.6, b: 3.4 },
  37: { s: 1.5, d2: 39, m: 1.6, b: 3.6 },
  42: { s: 1.75, d2: 44.5, m: 1.85, b: 3.9 },
  47: { s: 1.75, d2: 49.5, m: 1.85, b: 4.1 },
};

export type CirclipStandard = "DIN471" | "DIN472";

/**
 * MGN miniature linear guide rails (HIWIN): `wr` width, `hr` height, `pitch` hole pitch, bolt hole
 * `d`, counterbore `D` × `h`, mounting `screw`.
 */
export const MGN_RAILS = {
  MGN7: { wr: 7, hr: 4.8, pitch: 15, d: 2.4, D: 4.2, h: 2.3, screw: "M2" },
  MGN9: { wr: 9, hr: 6.5, pitch: 20, d: 3.5, D: 6, h: 3.5, screw: "M3" },
  MGN12: { wr: 12, hr: 8, pitch: 25, d: 3.5, D: 6, h: 4.5, screw: "M3" },
  MGN15: { wr: 15, hr: 10, pitch: 40, d: 3.5, D: 6, h: 4.5, screw: "M3" },
} as const satisfies Record<string, { wr: number; hr: number; pitch: number; d: number; D: number; h: number; screw: MetricSize }>;
export type MgnRailSize = keyof typeof MGN_RAILS;

/**
 * MGN carriages (HIWIN), C = standard, H = long: `H` rail bottom to block top, `H1` rail bottom to
 * block bottom, `W` block width, `B` × `C` mounting hole spacing (across × along), `L1` steel body
 * length, `L` overall length with end seals, `screw` tapped mounting holes `depth` deep.
 */
export const MGN_CARRIAGES = {
  MGN7C: { rail: "MGN7", H: 8, H1: 1.5, W: 17, B: 12, C: 8, L1: 13.5, L: 22.5, screw: "M2", depth: 2.5 },
  MGN7H: { rail: "MGN7", H: 8, H1: 1.5, W: 17, B: 12, C: 13, L1: 21.8, L: 30.8, screw: "M2", depth: 2.5 },
  MGN9C: { rail: "MGN9", H: 10, H1: 2, W: 20, B: 15, C: 10, L1: 18.9, L: 28.9, screw: "M3", depth: 3 },
  MGN9H: { rail: "MGN9", H: 10, H1: 2, W: 20, B: 15, C: 16, L1: 29.9, L: 39.9, screw: "M3", depth: 3 },
  MGN12C: { rail: "MGN12", H: 13, H1: 3, W: 27, B: 20, C: 15, L1: 21.7, L: 34.7, screw: "M3", depth: 3.5 },
  MGN12H: { rail: "MGN12", H: 13, H1: 3, W: 27, B: 20, C: 20, L1: 32.4, L: 45.4, screw: "M3", depth: 3.5 },
  MGN15C: { rail: "MGN15", H: 16, H1: 4, W: 32, B: 25, C: 20, L1: 26.7, L: 42.1, screw: "M3", depth: 4 },
  MGN15H: { rail: "MGN15", H: 16, H1: 4, W: 32, B: 25, C: 25, L1: 43.4, L: 58.8, screw: "M3", depth: 4 },
} as const satisfies Record<string, { rail: MgnRailSize; H: number; H1: number; W: number; B: number; C: number; L1: number; L: number; screw: MetricSize; depth: number }>;
export type MgnCarriageSize = keyof typeof MGN_CARRIAGES;
