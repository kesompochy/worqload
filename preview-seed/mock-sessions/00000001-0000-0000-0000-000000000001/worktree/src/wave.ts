import { greet } from "./greeting";

export function wave(name: string): string {
  return `👋 ${greet(name, "polite")}`;
}
