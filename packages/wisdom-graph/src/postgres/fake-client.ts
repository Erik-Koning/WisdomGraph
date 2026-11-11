/**
 * fake-client.ts — a recording stand-in for a `pg` pool, for this package's
 * own tests. Not exported: a consumer tests against the memory store.
 *
 * The Postgres store is specified by what it sends — statement text,
 * parameters, which connection they travel on, and that every checked-out
 * client is released — so the fake records exactly those and nothing else.
 * Responses are scripted by regex on the statement text, most recent rule
 * first, so a test can start from "everything returns no rows" and override
 * one statement; the version bump answers with a row by default because
 * without it no batch can commit.
 */

import type { PgClientLike, PgPoolClientLike, PgPoolLike, PgQueryResult } from "./client";

export type Route = "pool" | `client:${number}`;

export interface RecordedQuery {
  route: Route;
  text: string;
  params: unknown[] | undefined;
}

export interface RecordedRelease {
  client: number;
  /** The `err` argument as passed; `undefined` for a clean release. */
  err: unknown;
  /** How many arguments `release` received, so a test can tell `release()` from `release(undefined)`. */
  argCount: number;
}

export type FakeResponse =
  | PgQueryResult
  | Error
  | ((params: unknown[] | undefined, text: string) => PgQueryResult | Error | Promise<PgQueryResult | Error>);

interface Rule {
  match: RegExp;
  response: FakeResponse;
}

export class FakeSqlClient implements PgPoolLike {
  readonly queries: RecordedQuery[] = [];
  readonly releases: RecordedRelease[] = [];
  /** When set, `connect()` rejects with it. */
  connectError: unknown;
  private readonly rules: Rule[] = [];
  private clients = 0;

  constructor() {
    this.when(/RETURNING version/, { rows: [{ version: 1 }] });
  }

  /** Script a response; the most recently added matching rule wins. */
  when(match: RegExp, response: FakeResponse): this {
    this.rules.unshift({ match, response });
    return this;
  }

  query(text: string, params?: unknown[]): Promise<PgQueryResult> {
    return this.answer("pool", text, params);
  }

  async connect(): Promise<PgPoolClientLike> {
    if (this.connectError !== undefined) throw this.connectError;
    const id = ++this.clients;
    return {
      query: (text, params) => this.answer(`client:${id}`, text, params),
      release: (...args: unknown[]) => {
        this.releases.push({ client: id, err: args[0], argCount: args.length });
      },
    };
  }

  /** The same fake without `connect`, for the query-only paths. */
  queryOnly(): PgClientLike {
    return { query: (text, params) => this.query(text, params) };
  }

  /** How many clients `connect()` handed out. */
  get connections(): number {
    return this.clients;
  }

  /** Statement texts in order, optionally only those sent on one route. */
  texts(route?: Route): string[] {
    return this.queries.filter((q) => route === undefined || q.route === route).map((q) => q.text);
  }

  private async answer(route: Route, text: string, params: unknown[] | undefined): Promise<PgQueryResult> {
    this.queries.push({ route, text, params });
    const rule = this.rules.find((r) => r.match.test(text));
    if (!rule) return { rows: [] };
    const response = typeof rule.response === "function" ? await rule.response(params, text) : rule.response;
    if (response instanceof Error) throw response;
    return response;
  }
}
