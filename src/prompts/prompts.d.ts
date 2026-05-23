// Prompts are authored as plain .txt and loaded via Bun's `type: "text"`
// import attribute. This ambient declaration gives the import a string type
// for tsc/IDE; Bun embeds the file content at build time.
declare module "*.txt" {
  const content: string;
  export default content;
}
