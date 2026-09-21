const KEY = Symbol.for("@agegr/pi-web/session-liveness/v1");

export function sessionLivenessRegistry() {
	const current = globalThis[KEY];
	if (current?.version === 1 && typeof current.register === "function" && typeof current.hasActiveProvider === "function") {
		return current;
	}
	const providers = new Map();
	const registry = {
		version: 1,
		register(provider) {
			if (!provider || typeof provider.name !== "string" || !provider.name.trim() ||
				typeof provider.sessionId !== "string" || !provider.sessionId.trim() ||
				(provider.sessionFile !== undefined && (typeof provider.sessionFile !== "string" || !provider.sessionFile.trim())) ||
				typeof provider.isActive !== "function") throw new Error("Invalid session liveness provider");
			const key = Symbol(provider.name);
			providers.set(key, provider);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				providers.delete(key);
			};
		},
		hasActiveProvider({ sessionId, sessionFile }) {
			const identities = new Set([sessionId, sessionFile].filter(Boolean));
			for (const provider of providers.values()) {
				if (!identities.has(provider.sessionId) && (!provider.sessionFile || !identities.has(provider.sessionFile))) continue;
				try {
					const active = provider.isActive();
					if (typeof active !== "boolean") throw new Error("isActive() must return a boolean");
					if (active) return true;
				} catch (error) {
					console.error(`Session liveness provider '${provider.name}' failed; preserving the session:`, error);
					return true;
				}
			}
			return false;
		},
	};
	globalThis[KEY] = registry;
	return registry;
}
