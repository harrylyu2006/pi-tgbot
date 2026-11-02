// Test helper: `node --import ./trace-resolve.mjs …` records which plugin modules get resolved and can make `kdbxweb`
// unresolvable, to prove the optional plugin and its optional dependency are only loaded when used.
import { register } from "node:module";
register("./trace-resolve-hooks.mjs", import.meta.url);
