import { capitalize } from "./formatting";

export function log(line: string): void {
  console.log(`[log] ${capitalize(line)}`);
}

export function warn(line: string): void {
  console.warn(`[warn] ${capitalize(line)}`);
}
