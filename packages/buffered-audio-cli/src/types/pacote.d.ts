declare module "pacote" {
	interface ManifestResult {
		readonly name?: string;
		readonly version?: string;
	}

	interface ExtractResult {
		readonly from?: string;
		readonly integrity?: string;
		readonly resolved?: string;
	}

	interface PacoteModule {
		manifest: (spec: string, options?: Record<string, unknown>) => Promise<ManifestResult>;
		extract: (spec: string, dest: string, options?: Record<string, unknown>) => Promise<ExtractResult>;
	}

	const pacote: PacoteModule;

	export = pacote;
}
