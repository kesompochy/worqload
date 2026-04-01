const DEFAULT_PRINCIPLES_PATH = ".worqload/principles.md";

export async function loadPrinciples(path: string = DEFAULT_PRINCIPLES_PATH): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) return "";
  return await file.text();
}

export async function savePrinciples(content: string, path: string = DEFAULT_PRINCIPLES_PATH): Promise<void> {
  await Bun.write(path, content);
}

export function parsePrincipleLines(content: string): string[] {
  return content.split("\n").filter(l => l.startsWith("- "));
}

export async function addPrinciple(text: string, path: string = DEFAULT_PRINCIPLES_PATH): Promise<string[]> {
  const content = await loadPrinciples(path);
  const lines = parsePrincipleLines(content);
  lines.push(`- ${text}`);
  const header = "# Principles\n\n";
  await savePrinciples(header + lines.join("\n") + "\n", path);
  return lines.map(l => l.slice(2));
}

export async function editPrinciple(index: number, text: string, path: string = DEFAULT_PRINCIPLES_PATH): Promise<string[]> {
  const content = await loadPrinciples(path);
  const lines = parsePrincipleLines(content);
  if (index < 0 || index >= lines.length) throw new Error(`Principle index ${index} out of range`);
  lines[index] = `- ${text}`;
  const header = "# Principles\n\n";
  await savePrinciples(header + lines.join("\n") + "\n", path);
  return lines.map(l => l.slice(2));
}

export async function removePrinciple(index: number, path: string = DEFAULT_PRINCIPLES_PATH): Promise<string[]> {
  const content = await loadPrinciples(path);
  const lines = parsePrincipleLines(content);
  if (index < 0 || index >= lines.length) throw new Error(`Principle index ${index} out of range`);
  lines.splice(index, 1);
  const header = "# Principles\n\n";
  await savePrinciples(header + lines.join("\n") + "\n", path);
  return lines.map(l => l.slice(2));
}
