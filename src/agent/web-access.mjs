/** Loaded with Pi's compatibility aliases; no writes to node_modules required. */
import upstream from "../../node_modules/pi-web-access/index.ts";
import { withoutBackgroundPrompts } from "./web-access-policy.mjs";

export default function webAccess(pi) {
	return upstream(withoutBackgroundPrompts(pi));
}
