# inject

A minimal dependency injection library. Functions declare what they need where they need it; you supply it once, at the top.

## Services and injectables

A **service** is a typed key for a resource: a database, config, a logger.

```ts
type Database = { find(id: string): User };
const Database = createTag<Database, "Database">({ key: "Database" });
```

An **injectable** is a generator that requests services with `yield*`. `yield* Database` pauses the generator until the Database is supplied, then resumes with it.

```ts
function* getUser(id: string) {
  const db = yield* Database;
  return db.find(id);
}
```

Injectables compose. `yield*` one inside another and their requests merge, so `getFullName` inherits `getUser`'s `Database` without naming it.

```ts
function* getFullName(id: string) {
  const user = yield* getUser(id); // inherits Database
  return `${user.firstName} ${user.lastName}`;
}
```

## Running

`inject(injectable, bindings)` runs an injectable, supplies every service it requests, and returns a `Promise` of the result. Each service needs exactly one binding; a missing one is a compile error.

```ts
const user = await inject(getFullName("u1"), [provideValue(Database, db)]);
```

## Bindings

A binding supplies one service.

**`provideValue(S, value)`** supplies a plain value.

```ts
provideValue(Database, db);
```

**`provide(S, builder)`** builds the value from other services. The builder is itself an injectable, so it requests with `yield*`. The value is built lazily and only once per run, like a singleton.

```ts
provide(Database, function* () {
  const config = yield* Config;
  return new Database(config.url);
});
```

**`contribute(S, builder)`** and **`contributeValue(S, value)`** supply a fragment of a collection. A service bound this way resolves to all fragments concatenated, in binding order.

```ts
const Routes = createTag<readonly Route[], "Routes">({ key: "Routes" });

await inject(app(), [
  contributeValue(Routes, [{ path: "/api" }]),
  contributeValue(Routes, [{ path: "/admin" }]),
]); // Routes → [{ path: "/api" }, { path: "/admin" }]
```

## Defaults

A service can carry its own value, used when no binding covers it; the service then stops being required. Pass a fixed `defaultValue`, or a `default` injectable that requests its own services.

```ts
const Logger = createTag({ key: "Logger", defaultValue: console });

const Database = createTag({
  key: "Database",
  default: function* () {
    const config = yield* Config;
    return new Database(config.url);
  },
});
```

## `ifExists(S, bindings)`

Apply `bindings` only when something else provides `S`; otherwise drop them. Conditions resolve to a fixpoint, so one `ifExists` can enable another.

```ts
await inject(app(), [
  provideValue(Database, db),
  ifExists(Database, [provideValue(Cache, cache)]), // applied; dropped without Database
]);
```

## Contexts

A **context** is a stack of binding layers. Resolving a service searches the stack innermost-first: inner layers shadow outer ones, and a service a layer doesn't bind falls through to the layers above. `inject` is the common case: one layer, run to completion. These tools build and reuse the stack.

**`injectLayer(injectable, bindings)`** applies some bindings now and returns an injectable for the rest. When a runner finally drives it, it stacks its bindings as a layer on top of that runner's context. Still-missing services stay in the type.

```ts
const partial = injectLayer(getFullName("u1"), [provideValue(Database, db)]);
const user = await inject(partial, [provideValue(Logger, logger)]);
```

Because it is a layer, its bindings shadow those below and its contributions are local to it. Singletons are shared across the whole stack.

**`runPromise(injectable, context?)`** runs against a context, defaulting to empty. `inject(source, bindings)` is `runPromise(injectLayer(source, bindings))` plus a compile-time check that nothing is missing.

Grab the current context with `yield* Context` and run another injectable against it, reusing its bindings and the singletons already built in them, with nothing threaded through.

```ts
provide(Handler, function* () {
  const ctx = yield* Context; // the current stack
  return { run: (input) => runPromise(handle(input), ctx) };
});
```

**`runSync(injectable, context?)`** is like `runPromise` but returns the value directly. Throws if it reaches any async work (an `async function*` source, an async builder, an awaited value).
