export function startPluginModelFixture(): Promise<{ url: string; requests: any[]; holdNext(): Promise<() => void>; close(): Promise<void> }>
