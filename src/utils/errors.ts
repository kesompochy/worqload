export function exitWithError(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * Thrown when a spawned agent attempts an action that only the main session
 * should perform (e.g. orient --human). The CLI top-level handler converts
 * this into a process exit with the escalation exit code so the mission
 * runner can detect it and escalate on behalf of the agent.
 */
export class EscalationError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "EscalationError";
    this.exitCode = exitCode;
  }
}
