#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// pi-web-access finishes includeContent extraction asynchronously. Upstream
// injects a custom status message with triggerTurn:true; in a headless bot that
// starts a brand-new agent turn after the real answer has already been sent,
// causing the model to answer the status notification as if it were a user.
// Keep the content-ready message in session context, but never trigger a turn.
const target = fileURLToPath(new URL("../node_modules/pi-web-access/index.ts", import.meta.url));
const source = readFileSync(target, "utf8");
const readyMessage = /(?<prefix>customType:\s*"web-search-content-ready"[\s\S]{0,300}?\},\s*\n\s*)\{ triggerTurn: true \}(?<suffix>,\s*\n\s*\);)/;

if (readyMessage.test(source)) {
	writeFileSync(target, source.replace(readyMessage, "$<prefix>{ triggerTurn: false }$<suffix>"));
	console.log("Patched pi-web-access background content notification (triggerTurn=false).");
} else if (/customType:\s*"web-search-content-ready"[\s\S]{0,300}?\{ triggerTurn: false \}/.test(source)) {
	console.log("pi-web-access background content notification is already patched.");
} else {
	throw new Error("pi-web-access background notification code changed; refusing to apply an unsafe patch");
}
