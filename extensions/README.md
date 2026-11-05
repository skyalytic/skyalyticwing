# SkyalyticWing Extensions

This directory contains extension plugins for SkyalyticWing.

## Structure

```
extensions/
├── example/           # Example extension
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       └── index.ts
└── README.md
```

## Creating an Extension

1. Create a new directory under `extensions/`
2. Add `package.json` with `skyalyticwing.extension: true`
3. Implement the extension interface
4. Export tools, channels, and hooks

## Extension Interface

```typescript
interface Extension {
  id: string;
  name: string;
  version: string;
  tools?: Tool[];
  channels?: Channel[];
  onLoad?: (context: PluginContext) => Promise<void>;
  onMessage?: (message: Message, context: PluginContext) => Promise<void>;
  onToolCall?: (toolCall: ToolCall, context: PluginContext) => Promise<void>;
}
```
