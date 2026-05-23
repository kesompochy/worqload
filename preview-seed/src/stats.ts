import { tally } from "./counter";

export function countWords(text: string): number {
  return tally(text.split(/\s+/).filter(Boolean));
}
