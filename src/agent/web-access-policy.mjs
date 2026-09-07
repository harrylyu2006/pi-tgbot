/** Scope status suppression to the web extension, not other extension messages. */
export function withoutBackgroundPrompts(pi) {
	return new Proxy(pi, {
		get(target, key, receiver) {
			if (key !== "sendMessage") return Reflect.get(target, key, receiver);
			return (message, options) => {
				if (message.customType === "web-search-content-ready" || message.customType === "web-search-error") {
					if (message.customType === "web-search-error") target.appendEntry("web-search-background-error", { failed: true });
					return;
				}
				return target.sendMessage(message, options);
			};
		},
	});
}
