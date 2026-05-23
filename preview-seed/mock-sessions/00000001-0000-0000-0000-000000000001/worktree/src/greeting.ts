import { capitalize } from "./formatting";

export function greet(name: string, tone: "plain" | "polite" = "plain"): string {
  const cleaned = capitalize(name);
  if (tone === "polite") return `Hello, ${cleaned} さん!`;
  return `Hello, ${cleaned}!`;
}
