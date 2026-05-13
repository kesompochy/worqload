import { greet } from "./greeting";

const now = new Date().toISOString();
console.log(`[${now}] ${greet("worqload")}`);
