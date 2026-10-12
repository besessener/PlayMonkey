/** Process exit codes shared by every subcommand. */
export const ExitCode = {
  /** The run finished and found nothing. */
  NoFindings: 0,
  /** The run finished and found at least one problem. */
  Findings: 1,
  /** The tool itself failed: bad usage, invalid config, crash. */
  Error: 2,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
