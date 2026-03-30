export function parseFlags(
  args: string[],
  flagNames: string[],
): { flags: Record<string, string>; rest: string[] } {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (flagNames.includes(args[i]) && i + 1 < args.length) {
      flags[args[i]] = args[i + 1];
      i++;
    } else {
      rest.push(args[i]);
    }
  }
  return { flags, rest };
}
