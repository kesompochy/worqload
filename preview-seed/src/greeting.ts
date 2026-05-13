import { capitalize } from "./formatting";

export function greet(name: string): string {
  return `Hello, ${capitalize(name)}!`;
}
