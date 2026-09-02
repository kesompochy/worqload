import { resolveBranchNameClaudeBin } from "./branch-name";
import { resolveUtilityModel } from "./utility-model";
import LABEL_INSTRUCTION from "./prompts/link-label-instruction.txt" with { type: "text" };

export type LinkLabelGenerator = (url: string, promptContext: string) => Promise<string | null>;

const LABEL_RE = /^[a-z][a-z0-9 -]{0,29}$/;

export function sanitizeLinkLabel(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase().split(/\n/)[0] ?? "";
  if (trimmed === "" || !LABEL_RE.test(trimmed)) return null;
  return trimmed;
}

export function makeLinkLabelGenerator(opts: { model?: string } = {}): LinkLabelGenerator {
  const model = opts.model;
  return async (url, promptContext) => {
    const fullPrompt = `${LABEL_INSTRUCTION}\n\nURL: ${url}\nContext: ${promptContext}`;
    const cmd = [resolveBranchNameClaudeBin(), "-p", fullPrompt];
    if (model) cmd.push("--model", model);
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    } catch {
      return null;
    }
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return null;
    return sanitizeLinkLabel(out);
  };
}

export const defaultLinkLabelGenerator: LinkLabelGenerator = makeLinkLabelGenerator({
  model: resolveUtilityModel(),
});
