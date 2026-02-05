declare module "openclaw/plugin-sdk" {
  import type { Command } from "commander"

  export interface OpenClawPluginCliContext {
    program: Command
    config: unknown
    workspaceDir?: string
    logger: {
      info: (message: string, ...args: unknown[]) => void
      warn: (message: string, ...args: unknown[]) => void
      error: (message: string, ...args: unknown[]) => void
      debug: (message: string, ...args: unknown[]) => void
    }
  }

  export type OpenClawPluginCliRegistrar = (ctx: OpenClawPluginCliContext) => void | Promise<void>

  export interface OpenClawPluginApi {
    pluginConfig: unknown
    workspaceDir?: string
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
    registerCli(registrar: OpenClawPluginCliRegistrar, opts?: { commands?: string[] }): void
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
