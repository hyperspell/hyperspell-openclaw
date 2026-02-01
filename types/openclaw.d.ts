declare module "openclaw/plugin-sdk" {
  export interface OpenClawPluginApi {
    pluginConfig: unknown
    logger: {
      info: (message: string, ...args: unknown[]) => void
      warn: (message: string, ...args: unknown[]) => void
      error: (message: string, ...args: unknown[]) => void
      debug: (message: string, ...args: unknown[]) => void
    }
    registerCommand(options: {
      name: string
      description: string
      acceptsArgs: boolean
      requireAuth: boolean
      handler: (ctx: { args?: string; senderId?: string; channel?: string }) => Promise<{ text: string }>
    }): void
    registerTool<T = unknown>(
      options: {
        name: string
        label: string
        description: string
        parameters: unknown
        execute: (
          toolCallId: string,
          params: T,
        ) => Promise<{
          content: Array<{ type: "text"; text: string }>
          details?: Record<string, unknown>
        }>
      },
      meta: { name: string },
    ): void
    on(event: string, handler: (event: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<{ prependContext?: string } | void> | void): void
    registerService(options: {
      id: string
      start: () => void
      stop: () => void
    }): void
  }

  export function stringEnum<T extends string>(values: readonly T[]): unknown
}
