export async function autoCommit(
  taskTitle: string,
  cwd?: string,
  testCommand: string[] = ["bun", "test"],
): Promise<boolean> {
  const spawnOpts = cwd ? { cwd } : {};

  const testProc = Bun.spawn(testCommand, {
    stdout: "pipe",
    stderr: "pipe",
    ...spawnOpts,
  });
  await new Response(testProc.stdout).text();
  await new Response(testProc.stderr).text();
  const testExit = await testProc.exited;

  if (testExit !== 0) {
    console.log("Auto-commit skipped: tests failed");
    return false;
  }

  const addProc = Bun.spawn(["git", "add", "-A"], {
    stdout: "pipe",
    stderr: "pipe",
    ...spawnOpts,
  });
  await addProc.exited;

  const commitMessage = `worqload: ${taskTitle}`;
  const commitProc = Bun.spawn(["git", "commit", "-m", commitMessage], {
    stdout: "pipe",
    stderr: "pipe",
    ...spawnOpts,
  });
  await new Response(commitProc.stdout).text();
  await new Response(commitProc.stderr).text();
  const commitExit = await commitProc.exited;

  if (commitExit !== 0) {
    console.log("Auto-commit skipped: nothing to commit");
    return false;
  }

  console.log(`Auto-committed: ${commitMessage}`);
  return true;
}
