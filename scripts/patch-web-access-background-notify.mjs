#!/usr/bin/env node
// Compatibility entrypoint for old deployment scripts. Runtime adaptation now
// lives in src/agent/web-access.mjs and works with read-only node_modules.
console.log("No on-disk patch required: pi-tgbot loads the scoped web-access adapter.");
