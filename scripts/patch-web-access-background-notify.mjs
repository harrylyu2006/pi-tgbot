#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// pi-web-access finishes includeContent extraction asynchronously. Upstream
// injects a custom status message into the agent session. `triggerTurn:false`
// is insufficient while a turn is still streaming: the default `deliverAs:
// "steer"` queues it at the next model boundary, where it looks like a new user
// prompt. The fetched payload is already persisted by appendEntry() immediately
// above this block, so remove only the redundant custom status message.
const target = fileURLToPath(new URL("../node_modules/pi-web-access/index.ts", import.meta.url));
const source = readFileSync(target, "utf8");
const readyMessage = /\n\s*pi\.sendMessage\(\s*\n\s*\{\s*\n\s*customType:\s*"web-search-content-ready",[\s\S]{0,500}?\n\s*\);/;

if (readyMessage.test(source)) {
	writeFileSync(target, source.replace(readyMessage, "\n\t\t\t\t// Headless host: fetched data is already stored by appendEntry(); do not inject a status prompt."));
	console.log("Removed pi-web-access background content status prompt.");
} else if (!source.includes('customType: "web-search-content-ready"') && source.includes("Headless host: fetched data is already stored by appendEntry()")) {
	console.log("pi-web-access background content status prompt is already removed.");
} else {
	throw new Error("pi-web-access background notification code changed; refusing to apply an unsafe patch");
}
