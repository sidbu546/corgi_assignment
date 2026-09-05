/**
 * pg-types.ts — how Postgres values become JavaScript values.
 *
 * This is its own module for a reason. Registering type parsers is a global
 * side effect on the `pg` package, and it was previously buried inside db.ts —
 * which meant any script that imported `Pool` from 'pg' directly silently got
 * the DEFAULT parsers instead. That is exactly what happened: a reporting
 * script read a cent amount as a string and blew up on `Cannot mix BigInt and
 * other types`. It would have been far worse if it had quietly concatenated.
 *
 * Now every entry point imports this module explicitly, so the mapping is a
 * stated dependency rather than a lucky import order.
 *
 * The two mappings that matter:
 *
 *   int8 / bigint (OID 20)   -> native BigInt, NOT Number.
 *       A Postgres bigint does not fit in a JS number. Cents are bigint
 *       everywhere in this system precisely so money can never transit a float.
 *
 *   numeric (OID 1700)       -> left as a STRING, deliberately.
 *       It goes straight into Decimal. parseFloat on a numeric is the
 *       units-versus-money bug wearing a hat.
 *
 * A NOTE ON sum(): in Postgres, sum() over a bigint column returns NUMERIC, not
 * bigint. So an aggregate arrives here as a string even though the column is
 * bigint. Every aggregate over money in this codebase therefore casts back
 * explicitly — `sum(amount_cents)::bigint` — so it lands as a BigInt. Casting
 * at the query rather than coercing in JS keeps the exactness guarantee in one
 * place.
 */

import { types } from 'pg';

let registered = false;

export function registerPgTypes(): void {
  if (registered) return;
  types.setTypeParser(20, (value: string) => BigInt(value)); // int8
  types.setTypeParser(1700, (value: string) => value); // numeric -> string
  registered = true;
}

registerPgTypes();
