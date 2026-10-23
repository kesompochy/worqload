// Runs each test file in its own `bun test` process, several at a time, with a
// hard per-file time limit.
//
// Why not `bun test --parallel`: on Bun 1.3.14 its workers, which are reused
// across files (--parallel implies --isolate), sometimes spin at 100% CPU
// forever without leaving Bun's native code, or segfault and abort the whole
// run (see oven-sh/bun#44898, #46488, #39987). A hung worker is never stopped
// by --timeout, so it keeps a core busy until someone kills it. One process per
// file avoids worker reuse, and the hard limit bounds any hang that remains.
import { availableParallelism } from "os";

const FILE_TIME_LIMIT_MS = 60_000;
const KILL_GRACE_MS = 5_000;

type FileResult = { file: string; exitCode: number | null; timedOut: boolean; output: string };

async function runFile(file: string): Promise<FileResult> {
  const child = Bun.spawn([process.execPath, "test", file], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const terminateTimer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, FILE_TIME_LIMIT_MS);
  const killTimer = setTimeout(() => child.kill("SIGKILL"), FILE_TIME_LIMIT_MS + KILL_GRACE_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(terminateTimer);
  clearTimeout(killTimer);
  return { file, exitCode, timedOut, output: stdout + stderr };
}

const files = process.argv.slice(2);
const concurrency = Math.max(1, Math.floor(availableParallelism() / 2));
const failures: FileResult[] = [];
let nextIndex = 0;

async function drainQueue(): Promise<void> {
  while (nextIndex < files.length) {
    const file = files[nextIndex++] as string;
    const result = await runFile(file);
    process.stdout.write(result.output);
    if (result.timedOut) {
      process.stdout.write(`\n✗ ${file}: killed after exceeding ${FILE_TIME_LIMIT_MS / 1000}s\n`);
    }
    if (result.exitCode !== 0) failures.push(result);
  }
}

await Promise.all(Array.from({ length: concurrency }, drainQueue));

if (failures.length > 0) {
  console.log(`\n${failures.length} of ${files.length} test files failed:`);
  for (const { file, timedOut } of failures) console.log(`  ${file}${timedOut ? " (timed out)" : ""}`);
  process.exit(1);
}
console.log(`\nAll ${files.length} test files passed.`);
