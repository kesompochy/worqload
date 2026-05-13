export function greet(name: string, tone: "plain" | "polite" = "plain"): string {
  if (tone === "polite") return `Hello, ${name} さん!`;
  return `Hello, ${name}!`;
}
