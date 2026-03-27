export interface Source {
  name: string;
  type: "shell";
  command: string;
}

export interface SourceResult {
  name: string;
  output: string;
  exitCode: number;
}

const SOURCES_PATH = ".worqload/sources.json";

export async function loadSources(): Promise<Source[]> {
  const file = Bun.file(SOURCES_PATH);
  if (!(await file.exists())) return [];
  return await file.json();
}

export async function saveSources(sources: Source[]): Promise<void> {
  await Bun.write(SOURCES_PATH, JSON.stringify(sources, null, 2));
}

export async function addSource(source: Source): Promise<void> {
  const sources = await loadSources();
  if (sources.some(s => s.name === source.name)) {
    throw new Error(`Source already exists: ${source.name}`);
  }
  sources.push(source);
  await saveSources(sources);
}

export async function removeSource(name: string): Promise<void> {
  const sources = await loadSources();
  const filtered = sources.filter(s => s.name !== name);
  if (filtered.length === sources.length) {
    throw new Error(`Source not found: ${name}`);
  }
  await saveSources(filtered);
}

export async function runSource(source: Source): Promise<SourceResult> {
  const proc = Bun.spawn(["sh", "-c", source.command], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return {
    name: source.name,
    output: (stdout + stderr).trim(),
    exitCode,
  };
}

export async function runAllSources(): Promise<SourceResult[]> {
  const sources = await loadSources();
  const results: SourceResult[] = [];
  for (const source of sources) {
    results.push(await runSource(source));
  }
  return results;
}
