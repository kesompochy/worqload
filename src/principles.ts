const PRINCIPLES_PATH = ".worqload/principles.md";

export async function loadPrinciples(): Promise<string> {
  const file = Bun.file(PRINCIPLES_PATH);
  if (!(await file.exists())) return "";
  return await file.text();
}

export async function savePrinciples(content: string): Promise<void> {
  await Bun.write(PRINCIPLES_PATH, content);
}
