/**
 * Versions of the files the service keeps between releases, so upgrades
 * can migrate them and an older build never runs on data a newer one wrote.
 *
 * - config.json carries `schemaVersion`. A file without one is version 0.
 * - state.db carries SQLite's `PRAGMA user_version`. Databases from before
 *   versioning are 0 and are brought up to date by the migrations in
 *   bot/state.ts.
 *
 * Rollback: reinstalling an older Waterboy after a newer one has migrated
 * these files makes the service stop at startup with SchemaTooNewError
 * (which names the file and both versions) instead of misreading them.
 * To roll back, restore the files from before the upgrade, or reinstall
 * the newer build.
 */

/** Bump when config.json needs a migration; add the step to CONFIG_MIGRATIONS */
export const CONFIG_SCHEMA_VERSION = 1;
/** Bump with each migration appended to STATE_MIGRATIONS in bot/state.ts */
export const STATE_SCHEMA_VERSION = 3;

export class SchemaTooNewError extends Error {
  constructor(
    readonly file: string,
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `${file} is at schema version ${found}, but this Waterboy build only understands up to ${supported}. ` +
        `It was written by a newer Waterboy. Install that version again, or restore ${file} from before the upgrade.`,
    );
    this.name = "SchemaTooNewError";
  }
}

type RawConfig = Record<string, unknown>;

/**
 * config.json migrations: index i takes version i to i + 1. Each gets the
 * parsed file and returns the new one; keys it doesn't know stay as they are.
 */
export const CONFIG_MIGRATIONS: ((raw: RawConfig) => RawConfig)[] = [
  // 0 -> 1: versioning starts; nothing else changes
  (raw) => raw,
];

/**
 * Brings a parsed config.json up to CONFIG_SCHEMA_VERSION. Returns the
 * migrated object and whether anything changed; throws SchemaTooNewError
 * for files from a newer build.
 */
export function migrateConfig(raw: RawConfig, file = "config.json"): { config: RawConfig; changed: boolean } {
  const found = Number.isInteger(raw.schemaVersion) ? (raw.schemaVersion as number) : 0;
  if (found > CONFIG_SCHEMA_VERSION) throw new SchemaTooNewError(file, found, CONFIG_SCHEMA_VERSION);
  let config = raw;
  for (let v = found; v < CONFIG_SCHEMA_VERSION; v++) config = CONFIG_MIGRATIONS[v]({ ...config });
  if (found === CONFIG_SCHEMA_VERSION) return { config, changed: false };
  // Keep the version first so it's the first thing a person sees
  const { schemaVersion: _old, ...rest } = config;
  return { config: { schemaVersion: CONFIG_SCHEMA_VERSION, ...rest }, changed: true };
}
