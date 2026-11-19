// Hand-built entities and snapshots for tests of the evaluator, the app files and flagd JSON (no database).
import { entitiesFrom } from '../server/snapshot.ts';
import type { EntityInfo, FlagDef, Snapshot } from '../server/evaluator.ts';

/** Entities from rows [key, name, dimension, parent?], with their paths worked out as the snapshot does. */
export const entities = (rows: [string, string, string, string?][]): Record<string, EntityInfo> =>
  entitiesFrom(rows.map(([key, name, dimension, parent]) => ({ key, name, dimension, parent: parent ?? null })));

/** The attributes every hand-built snapshot stores: the built-in ones tests use, `entity`, the old customer names
 *  (aliases), and one per dimension. */
export function fieldsFor(dimensions: readonly string[]): Snapshot['fields'] {
  return {
    project: { valueType: 'string', comesFrom: 'key' }, environment: { valueType: 'string', comesFrom: 'key' },
    entity: { valueType: 'string', comesFrom: 'token' },
    'customer.id': { valueType: 'string', comesFrom: 'token' }, 'customer.company': { valueType: 'string', comesFrom: 'token' },
    ...Object.fromEntries(dimensions.map((d) => [d, { valueType: 'string', comesFrom: 'token' }])),
    'device.id': { valueType: 'string', comesFrom: 'sdk' }, 'session.id': { valueType: 'string', comesFrom: 'sdk' },
    'device.platform': { valueType: 'string', comesFrom: 'sdk' }, 'app.version': { valueType: 'semver', comesFrom: 'sdk' },
    'app.build': { valueType: 'int', comesFrom: 'sdk' }, 'locale.language': { valueType: 'string', comesFrom: 'sdk' },
    'user.roles': { valueType: 'list', comesFrom: 'sdk' },
  };
}

export function snapshotOf(flags: FlagDef[], ents: Record<string, EntityInfo>, dimensions: string[], o: { environment?: string; revision?: number } = {}): Snapshot {
  return {
    environment: o.environment ?? 'dev', revision: o.revision ?? 1, builtAt: '',
    flags: Object.fromEntries(flags.map((f) => [f.key, f])), entities: ents, dimensions, fields: fieldsFor(dimensions),
  };
}
