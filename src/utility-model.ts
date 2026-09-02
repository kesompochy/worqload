// Resolves the model to use for short-lived one-shot `claude -p` calls
// (branch naming, link labelling, etc.) — distinct from the session model
// that drives the main agent conversation.

export function resolveUtilityModel(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const value = env.WORQLOAD_UTILITY_MODEL?.trim();
  return value && value !== "" ? value : undefined;
}
