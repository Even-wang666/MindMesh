export function startPluginFixtureRegistry(root: string): Promise<{ url: string; setCatalogVersion(version: string): void; close(): Promise<void> }>
