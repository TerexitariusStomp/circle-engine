/** Vendored production bundle modules — runtime-loaded from /cic/, not bundled */
declare module '/cic/*' {
	const mod: Record<string, unknown>;
	export = mod;
}
