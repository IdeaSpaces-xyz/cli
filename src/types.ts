export interface GlobalFlags {
  json: boolean;
  quiet: boolean;
  yes: boolean;
  repo?: string;
  gitBin?: string;
  /** Raw `--token-fd <n>`: the inherited descriptor a host writes its token into (IDEASPACES_AUTH=host only). */
  tokenFd?: string;
  help: boolean;
}

export interface CommandDef {
  name: string;
  description: string;
  usage: string;
  examples?: string[];
  /** Longer reference shown by `--help` after the description (e.g. a query syntax). */
  help?: string;
  run(args: string[], flags: Record<string, string | boolean>, global: GlobalFlags): Promise<number>;
}
