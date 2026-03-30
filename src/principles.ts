const DEFAULT_PRINCIPLES_PATH = ".worqload/principles.md";

export async function loadPrinciples(path: string = DEFAULT_PRINCIPLES_PATH): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) return "";
  return await file.text();
}

export async function savePrinciples(content: string, path: string = DEFAULT_PRINCIPLES_PATH): Promise<void> {
  await Bun.write(path, content);
}
