// read_script's plain-text listing ("path · version 3 · 12 lines[ · …]" then "n\tline") as fields.
export function parseListing(text: string) {
  const [header = "", ...rest] = text.split("\n");
  const [path, version, ...more] = header.split(" · ");
  const others = more.find((m) => m.startsWith("otherSessions "));
  return {
    path,
    version: Number(version?.replace("version ", "")),
    content: rest.map((l) => l.slice(l.indexOf("\t") + 1)).join("\n"),
    ...(others ? { otherSessions: JSON.parse(others.slice("otherSessions ".length)) } : {}),
  };
}
