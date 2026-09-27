// Viewer colors. The app passes values from the design tokens (packages/app tokens.ts).
export type ViewerTheme = {
  background: string;
  /** subtle vertical gradient toward this color at the top (optional) */
  backgroundTop?: string;
  grid: string;
  gridMajor: string;
  edge: string;
  edgeHidden: string;
  silhouette: string;
  preselect: string;
  selectedFill: string;
  selectedStroke: string;
  error: string;
  ghost: string;
  /** compare ghost edges, other non-selection emphasis (the one accent blue) */
  accent: string;
  axisX: string;
  axisY: string;
  axisZ: string;
  /** hidden-line mode face fill */
  hiddenLineFill: string;
  dark: boolean;
};

export const LIGHT: ViewerTheme = {
  background: "#f4f4f5",
  backgroundTop: "#fbfbfb",
  grid: "#e4e4e7",
  gridMajor: "#d4d4d8",
  edge: "#1f2023",
  edgeHidden: "#a1a1aa",
  silhouette: "#1f2023",
  preselect: "#f97316",
  selectedFill: "#fb923c",
  selectedStroke: "#ea580c",
  error: "#e5484d",
  ghost: "#71717a",
  accent: "#1273eb",
  axisX: "#e5484d",
  axisY: "#30a46c",
  axisZ: "#3e63dd",
  hiddenLineFill: "#ffffff",
  dark: false,
};

export const DARK: ViewerTheme = {
  background: "#18181b",
  backgroundTop: "#202024",
  grid: "#27272a",
  gridMajor: "#323236",
  edge: "#0b0b0c",
  edgeHidden: "#52525b",
  silhouette: "#0b0b0c",
  preselect: "#fb923c",
  selectedFill: "#f97316",
  selectedStroke: "#fdba74",
  error: "#ff6369",
  ghost: "#a1a1aa",
  accent: "#5a9dff",
  axisX: "#ff6369",
  axisY: "#3dd68c",
  axisZ: "#6e8cff",
  hiddenLineFill: "#1c1c1f",
  dark: true,
};
