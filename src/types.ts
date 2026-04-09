export interface GlobalFlags {
  json: boolean;
  quiet: boolean;
  yes: boolean;
  repo?: string;
  help: boolean;
}

export interface CommandDef {
  name: string;
  description: string;
  usage: string;
  examples?: string[];
  run(args: string[], flags: Record<string, string | boolean>, global: GlobalFlags): Promise<number>;
}
