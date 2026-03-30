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

const DEFAULT_SOURCES_PATH = ".worqload/sources.json";

export async function loadSources(path: string = DEFAULT_SOURCES_PATH): Promise<Source[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  return await file.json();
}

export async function saveSources(sources: Source[], path: string = DEFAULT_SOURCES_PATH): Promise<void> {
  await Bun.write(path, JSON.stringify(sources, null, 2));
}

export async function addSource(source: Source, path: string = DEFAULT_SOURCES_PATH): Promise<void> {
  const sources = await loadSources(path);
  if (sources.some(s => s.name === source.name)) {
    throw new Error(`Source already exists: ${source.name}`);
  }
  sources.push(source);
  await saveSources(sources, path);
}

export async function removeSource(name: string, path: string = DEFAULT_SOURCES_PATH): Promise<void> {
  const sources = await loadSources(path);
  const filtered = sources.filter(s => s.name !== name);
  if (filtered.length === sources.length) {
    throw new Error(`Source not found: ${name}`);
  }
  await saveSources(filtered, path);
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

export async function runAllSources(path: string = DEFAULT_SOURCES_PATH): Promise<SourceResult[]> {
  const sources = await loadSources(path);
  const results: SourceResult[] = [];
  for (const source of sources) {
    results.push(await runSource(source));
  }
  return results;
}
