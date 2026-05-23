import { capitalize } from "./formatting";
import { countWords } from "./stats";

export function summarize(text: string): string {
  const wordCount = countWords(text);
  const head = text.slice(0, 24).trimEnd();
  return `${capitalize(head)}… (${wordCount} words)`;
}
