import { join } from "node:path";
import { ANONYMOUS_ROLE } from "./auth/session.ts";
import type { AuthRole, LoadedConfig } from "./config/config.ts";

/** One run of an invocation: a role (undefined: anonymous) with a seed. */
export interface PlannedRun {
  role: AuthRole | undefined;
  seed: number;
  /** `role`, or `role/seed` with `seeds`; prefixes log lines and keys LLM usage. */
  label: string;
  /** `<report.dir>/<role>`, or `<report.dir>/<role>/<seed>` with `seeds`. */
  outputDir: string;
}

/** Every run of the config, roles first, then seeds: the order of the report, whatever order they finish in. */
export function planRuns(config: LoadedConfig["config"]): PlannedRun[] {
  const roles = config.auth.length > 0 ? config.auth : [undefined];
  return roles.flatMap((role) => {
    const name = role?.name ?? ANONYMOUS_ROLE;
    const roleDir = join(config.report.dir, roleDirectory(name));
    if (config.seeds === undefined) return [{ role, seed: config.seed, label: name, outputDir: roleDir }];
    return config.seeds.map((seed) => ({
      role,
      seed,
      label: `${name}/${seed}`,
      outputDir: join(roleDir, String(seed)),
    }));
  });
}

/** A directory name for a role: safe characters only. */
export function roleDirectory(role: string): string {
  return role.replace(/[^A-Za-z0-9._-]/g, "_") || "_";
}
