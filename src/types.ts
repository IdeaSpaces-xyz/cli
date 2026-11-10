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
  /** Help-only usage per verb. Never execute a command to answer --help. */
  subcommands?: Record<string, string>;
  /** Mixed commands may also take a path, id or skill name in the verb slot. */
  helpArgument?: (word: string) => boolean;
  /** Longer reference shown by `--help` after the description (e.g. a query syntax). */
  help?: string;
  run(args: string[], flags: Record<string, string | boolean>, global: GlobalFlags): Promise<number>;
}
