import type { ISdk } from 'iii-sdk'
import { getKvTimeoutMs } from '../config.js'
import { withTimeout } from '../utils/deadline.js'
import { recordKvList } from './kv-metrics.js'

// Reads carry a wall-clock ceiling. Without it a state RPC inherits the 180s
// iii invocation timeout (src/index.ts), so one pathological list can hold an
// HTTP request open for three minutes while the caller is long gone.
// Upstream #1128.
//
// Writes deliberately do NOT get one. A timeout is not a cancellation: nothing
// in the iii protocol tells the engine to abandon an in-flight invocation, so a
// write that times out client-side can still commit server-side. Callers treat
// the rejection as failure and compensate — mem::observe rolls back the raw row
// when the derived write fails — and that compensating delete would race the
// late commit, leaving exactly the orphaned row the rollback exists to prevent.
// Abandoning a read is free; abandoning a write is a lie about durable state.
export class StateKV {
  constructor(private sdk: ISdk) {}

  private guard<T>(promise: Promise<T>, label: string): Promise<T> {
    return withTimeout(promise, getKvTimeoutMs(), label)
  }

  async get<T = unknown>(scope: string, key: string): Promise<T | null> {
    return this.guard(
      this.sdk.trigger<{ scope: string; key: string }, T | null>({
        function_id: 'state::get',
        payload: { scope, key },
      }),
      `kv.get(${scope})`,
    )
  }

  async set<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    return this.sdk.trigger<{ scope: string; key: string; value: T }, T>({
      function_id: 'state::set',
      payload: { scope, key, value },
    })
  }

  async update<T = unknown>(
    scope: string,
    key: string,
    ops: Array<{ type: string; path: string; value?: unknown }>,
  ): Promise<T> {
    return this.sdk.trigger<
      { scope: string; key: string; ops: Array<{ type: string; path: string; value?: unknown }> },
      T
    >({
      function_id: 'state::update',
      payload: { scope, key, ops },
    })
  }

  async delete(scope: string, key: string): Promise<void> {
    return this.sdk.trigger<{ scope: string; key: string }, void>({
      function_id: 'state::delete',
      payload: { scope, key },
    })
  }

  // state::list materialises the entire scope as one JSON array in the engine
  // and ships it over the WebSocket. There is no pagination in the protocol, so
  // the only defences are not calling it on unbounded scopes and knowing when
  // you did: recordKvList surfaces the offenders in /health.
  async list<T = unknown>(scope: string): Promise<T[]> {
    const started = Date.now()
    const rows = await this.guard(
      this.sdk.trigger<{ scope: string }, T[]>({
        function_id: 'state::list',
        payload: { scope },
      }),
      `kv.list(${scope})`,
    )
    recordKvList(scope, Array.isArray(rows) ? rows.length : 0, Date.now() - started)
    return rows
  }
}
