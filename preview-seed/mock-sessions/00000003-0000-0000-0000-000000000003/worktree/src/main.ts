import { greet } from "./greeting";
import { summarize } from "./summary";
import { log } from "./logger";

const now = new Date().toISOString();
log(`[${now}] ${greet("worqload")}`);
log(`[${now}] ${summarize("hello worqload, hello world from the preview repo")}`);
