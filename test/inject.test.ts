import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type AnyInjectable,
  type Binding,
  Context,
  contribute,
  contributeValue,
  createTag,
  ifExists,
  inject,
  runPromise,
  runSync,
  injectLayer,
  provide,
  provideValue,
} from "../src/index.ts";

type Database = { find(id: string): string };
type Logger = { log(msg: string): void };

const Db = createTag<Database, "Db">({ key: "Db" });
const Log = createTag<Logger, "Log">({ key: "Log" });

function* findUser() {
  const db = yield* Db;
  return db.find("u1");
}

// A fresh sync inject is the composition the library leaves to callers, since
// synchronous injection is an edge case. Recreated here to exercise the runner.
const injectSync = <A>(
  source: AnyInjectable<A, any>,
  bindings: readonly Binding[],
): A => runSync(injectLayer(source, bindings));

test("inject resolves a single service", async () => {
  function* getUser(id: string) {
    const db = yield* Db;
    return db.find(id);
  }

  const db: Database = { find: (id) => `user:${id}` };
  assert.equal(await inject(getUser("u1"), [provideValue(Db, db)]), "user:u1");
});

test("inject resolves a sync source asynchronously", async () => {
  function* getUser(id: string) {
    const db = yield* Db;
    return db.find(id);
  }

  const db: Database = { find: (id) => `user:${id}` };
  const result = inject(getUser("u1"), [provideValue(Db, db)]);
  assert.ok(result instanceof Promise);
  assert.equal(await result, "user:u1");
});

test("yield* delegates across functions, threading dependencies up", async () => {
  function* loadName(id: string) {
    const db = yield* Db;
    return db.find(id);
  }

  function* greet(id: string) {
    const log = yield* Log; // this fn acquires Log
    const name = yield* loadName(id); // ...and inherits Db from the callee
    log.log(`hi ${name}`);
    return `hello ${name}`;
  }

  const lines: string[] = [];
  const result = await inject(greet("u1"), [
    provideValue(Db, { find: (id) => `user:${id}` }),
    provideValue(Log, { log: (m) => lines.push(m) }),
  ]);

  assert.equal(result, "hello user:u1");
  assert.deepEqual(lines, ["hi user:u1"]);
});

test("inject rejects when a service is missing", async () => {
  function* needsLog() {
    const log = yield* Log;
    log.log("x");
    return 1;
  }

  await assert.rejects(
    // @ts-expect-error - Log is not provided; missing provisions are a compile error too.
    () => inject(needsLog(), []),
    /missing provision for Log/,
  );
});

test("inject preserves re-runnability of a reusable source", async () => {
  // A bare `fn()` generator is one-shot. A *reusable* injectable is an iterable
  // whose [Symbol.iterator] returns a fresh generator each time.
  let calls = 0;
  const reusable = {
    *[Symbol.iterator]() {
      const db = yield* Db;
      calls++;
      return db.find("u1");
    },
  };

  assert.equal(
    await inject(reusable, [provideValue(Db, { find: () => "a" })]),
    "a",
  );
  assert.equal(
    await inject(reusable, [provideValue(Db, { find: () => "b" })]),
    "b",
  );
  assert.equal(calls, 2);
});

test("a bare fn() injectable is one-shot, like the generator it wraps", async () => {
  function* once() {
    const db = yield* Db;
    return db.find("u1");
  }
  const source = once();
  assert.equal(
    await inject(source, [provideValue(Db, { find: () => "a" })]),
    "a",
  );
  // second run hits the already-finished generator
  assert.equal(
    await inject(source, [provideValue(Db, { find: () => "b" })]),
    undefined,
  );
});

test("early termination finalizes the source generator", async () => {
  let cleaned = false;
  function* work() {
    try {
      const db = yield* Db;
      yield* Log; // unmet below
      return db.find("u1");
    } finally {
      cleaned = true;
    }
  }
  const db = { find: (id: string) => `user:${id}` };

  cleaned = false;
  await assert.rejects(
    // @ts-expect-error - Log is not provided
    () => inject(work(), [provideValue(Db, db)]),
    /missing provision/,
  );
  assert.equal(cleaned, true, "inject rejection should run source finally");
});

test("an injectable can be yield*'d by another injectable", async () => {
  function* loadUser(id: string) {
    const db = yield* Db;
    return db.find(id);
  }

  function* wrapper() {
    const result = yield* loadUser("u1");
    return result.toUpperCase();
  }

  assert.equal(
    await inject(wrapper(), [provideValue(Db, { find: (id) => `user:${id}` })]),
    "USER:U1",
  );
});

test("nested injectables thread all dependencies to inject", async () => {
  function* work() {
    const db = yield* Db;
    const log = yield* Log;
    log.log("hi");
    return db.find("u1");
  }

  function* wrapper() {
    const result = yield* work();
    return result.toUpperCase();
  }

  const lines: string[] = [];
  assert.equal(
    await inject(wrapper(), [
      provideValue(Db, { find: (id) => `user:${id}` }),
      provideValue(Log, { log: (m) => lines.push(m) }),
    ]),
    "USER:U1",
  );
  assert.deepEqual(lines, ["hi"]);
});

const AsyncDb = createTag<{ find(id: string): Promise<string> }, "AsyncDb">({
  key: "AsyncDb",
});

test("inject on an async source returns a Promise", async () => {
  const lines: string[] = [];
  async function* getUser(id: string) {
    const db = yield* AsyncDb;
    const log = yield* Log;
    const user = await db.find(id); // real await between yields
    log.log(`loaded ${user}`);
    return user.toUpperCase();
  }

  const result = inject(getUser("u1"), [
    provideValue(AsyncDb, { find: async (id) => `user:${id}` }),
    provideValue(Log, { log: (m) => lines.push(m) }),
  ]);
  assert.ok(result instanceof Promise);
  assert.equal(await result, "USER:U1");
  assert.deepEqual(lines, ["loaded user:u1"]);
});

test("async missing service rejects and finalizes the source", async () => {
  let cleaned = false;
  async function* work() {
    try {
      const db = yield* AsyncDb;
      yield* Log;
      return await db.find("u1");
    } finally {
      cleaned = true;
    }
  }
  const onlyDb = [provideValue(AsyncDb, { find: async (id) => id })];
  await assert.rejects(
    // @ts-expect-error - Log is not provided
    () => inject(work(), onlyDb),
    /missing provision for Log/,
  );
  assert.equal(cleaned, true, "async source finally should run");
});

test("same value type, different names are distinct services", async () => {
  const Step = createTag<number, "step">({ key: "step" });
  const Limit = createTag<number, "limit">({ key: "limit" });

  function* product() {
    const step = yield* Step;
    const limit = yield* Limit;
    return step * limit;
  }

  assert.equal(
    await inject(product(), [provideValue(Step, 2), provideValue(Limit, 5)]),
    10,
  );

  // Step and Limit are distinct types despite both being number services, so
  // omitting Limit is a compile error (and still rejects at runtime).
  await assert.rejects(
    // @ts-expect-error - Limit is not provided
    () => inject(product(), [provideValue(Step, 2)]),
    /missing provision for limit/,
  );
});

test("key type must match the provided key", async () => {
  // @ts-expect-error - the key value must match the key type
  createTag<number, "limit">({ key: "step" });
});

type Route = { path: string };
const Routes = createTag<readonly Route[], "Routes">({ key: "Routes" });

function* routePaths() {
  const routes = yield* Routes;
  return routes.map((route) => route.path);
}

test("contribute concatenates array fragments", async () => {
  function* app() {
    const routes = yield* Routes;
    return routes.map((route) => route.path).join(",");
  }

  assert.equal(
    await inject(app(), [
      contributeValue(Routes, [{ path: "/api" }]),
      contributeValue(Routes, [{ path: "/static" }]),
    ]),
    "/api,/static",
  );
});

test("contributions cannot be mixed with a provided array service", async () => {
  await assert.rejects(
    () =>
      inject(routePaths(), [
        provideValue(Routes, [{ path: "/" }]),
        contributeValue(Routes, [{ path: "/api" }]),
      ]),
    /duplicate provision for Routes/,
  );
});

test("a contribution must resolve to an array", async () => {
  await assert.rejects(
    () => inject(routePaths(), [contributeValue(Routes, "oops" as never)]),
    /contribution for Routes must be an array/,
  );
});

test("a service cannot be provided twice", async () => {
  await assert.rejects(
    () =>
      inject(findUser(), [
        provideValue(Db, { find: () => "first" }),
        provideValue(Db, { find: () => "second" }),
      ]),
    /duplicate provision for Db/,
  );
});

test("a defaultValue service resolves when no binding is bound", async () => {
  const DbDefault = createTag({
    key: "Db",
    defaultValue: { find: (id: string) => id },
  });

  function* app() {
    const db = yield* DbDefault;
    return db.find("u1");
  }

  assert.equal(await inject(app(), []), "u1");
});

test("explicit type arguments on a default service are a compile error", async () => {
  // Spelling out the type arguments would drop the default builder's deps, so
  // the inferring overloads reject them outright.
  createTag<Database, "Db">({
    key: "Db",
    // @ts-expect-error - do not pass explicit type arguments to createTag
    default: function* () {
      return { find: (id: string) => id };
    },
  });
});

test("a binding overrides a service's default", async () => {
  let defaultBuilt = false;

  const DbDefault = createTag({
    key: "Db",
    default: function* () {
      defaultBuilt = true;
      const config = yield* Config;
      return { find: (id: string) => `${config.url}/${id}` };
    },
  });

  function* app() {
    const db = yield* DbDefault;
    return db.find("u1");
  }

  const result = await inject(app(), [
    provideValue(DbDefault, { find: (id) => `primary:${id}` }),
  ]);

  assert.equal(result, "primary:u1");
  assert.equal(defaultBuilt, false);
});

test("a default builder's dependencies are required when the default is used", async () => {
  const DbDefault = createTag({
    key: "Db",
    default: function* () {
      const config = yield* Config;
      return { find: (id: string) => `${config.url}/${id}` };
    },
  });

  function* app() {
    const db = yield* DbDefault;
    return db.find("u1");
  }

  await assert.rejects(
    // @ts-expect-error - Config is required when the default builder is used
    () => inject(app(), []),
    /missing provision for Config/,
  );

  assert.equal(
    await inject(app(), [provideValue(Config, { url: "/db" })]),
    "/db/u1",
  );
});

test("a default service uses a provided binding for every acquisition", async () => {
  const DbDefault = createTag({
    key: "Db",
    defaultValue: { find: (id: string) => `default:${id}` },
  });

  function* app() {
    const first = yield* DbDefault;
    const second = yield* DbDefault;
    return `${first.find("a")}/${second.find("b")}`;
  }

  assert.equal(
    await inject(app(), [
      provideValue(DbDefault, { find: (id) => `bound:${id}` }),
    ]),
    "bound:a/bound:b",
  );
});

test("array services can be provided directly", async () => {
  assert.deepEqual(
    await inject(routePaths(), [provideValue(Routes, [{ path: "/" }])]),
    ["/"],
  );
});

test("contribute enforces the collection fragment type", async () => {
  // @ts-expect-error - a route contribution needs a path
  contributeValue(Routes, [{ name: "api" }]);
});

const Config = createTag<{ url: string }, "Config">({ key: "Config" });
const Pool = createTag<{ size: number }, "Pool">({ key: "Pool" });

test("a contribution can resolve its own dependencies", async () => {
  const result = await inject(routePaths(), [
    contribute(Routes, function* () {
      const config = yield* Config;
      return [{ path: config.url }];
    }),
    provideValue(Config, { url: "/api" }),
  ]);

  assert.deepEqual(result, ["/api"]);
});

test("a contribution's unmet dependency is a compile error and rejects", async () => {
  function* app() {
    const routes = yield* Routes;
    return routes;
  }

  const contributions = [
    contribute(Routes, function* () {
      const config = yield* Config;
      return [{ path: config.url }];
    }),
  ] as const;

  await assert.rejects(
    // @ts-expect-error - Config (the contribution's dependency) is missing
    () => inject(app(), contributions),
    /missing provision for Config/,
  );
});

test("inject resolves an async contribution from a sync app", async () => {
  const result = inject(routePaths(), [
    contribute(Routes, async function* () {
      const config = yield* Config;
      await Promise.resolve();
      return [{ path: config.url }];
    }),
    provideValue(Config, { url: "/async" }),
  ]);

  assert.ok(result instanceof Promise, "inject always returns a Promise");
  assert.deepEqual(await result, ["/async"]);
});

test("mixed contributions preserve order when one is async", async () => {
  const result = inject(routePaths(), [
    contributeValue(Routes, [{ path: "/first" }]),
    contribute(Routes, async function* () {
      const config = yield* Config;
      await Promise.resolve();
      return [{ path: config.url }];
    }),
    contributeValue(Routes, [{ path: "/last" }]),
    provideValue(Config, { url: "/async" }),
  ]);

  assert.ok(result instanceof Promise, "inject always returns a Promise");
  assert.deepEqual(await result, ["/first", "/async", "/last"]);
});

test("a provider resolves a service from its own dependencies", async () => {
  const result = await inject(findUser(), [
    provide(Db, function* () {
      const config = yield* Config; // the provider has its own dependency
      return { find: (id: string) => `${config.url}/${id}` };
    }),
    provideValue(Config, { url: "https://db" }),
  ]);

  assert.equal(result, "https://db/u1");
});

test("a provider's unmet dependency is a compile error and rejects", async () => {
  // The Db provider needs Config, which nobody supplies.
  const provisions = [
    provide(Db, function* () {
      const config = yield* Config;
      return { find: (id: string) => `${config.url}/${id}` };
    }),
  ] as const;

  await assert.rejects(
    // @ts-expect-error - Config (the provider's dependency) is missing
    () => inject(findUser(), provisions),
    /missing provision for Config/,
  );
});

test("providers are resolved once, as singletons", async () => {
  let built = 0;
  function* app() {
    const db = yield* Db;
    const pool = yield* Pool;
    return `${db.find("u1")}@${pool.size}`;
  }

  const result = await inject(app(), [
    provide(Pool, function* () {
      const config = yield* Config;
      built++;
      return { size: config.url.length };
    }),
    provide(Db, function* () {
      const pool = yield* Pool; // depends on another provider
      return { find: (id: string) => `${id}#${pool.size}` };
    }),
    provideValue(Config, { url: "0123456789" }),
  ]);

  assert.equal(result, "u1#10@10");
  assert.equal(built, 1, "Pool is built once and shared");
});

test("inject rejects dependency cycles", async () => {
  const A = createTag<{ value: string }, "A">({ key: "A" });
  const B = createTag<{ value: string }, "B">({ key: "B" });

  function* app() {
    const a = yield* A;
    return a.value;
  }

  await assert.rejects(
    () =>
      inject(app(), [
        provide(A, function* () {
          const b = yield* B;
          return { value: b.value };
        }),
        provide(B, function* () {
          const a = yield* A;
          return { value: a.value };
        }),
      ]),
    /dependency cycle at A/,
  );
});

test("provider builders are classified by the returned iterable", async () => {
  const result = await inject(findUser(), [
    provide(Db, () =>
      (function* () {
        const config = yield* Config;
        return { find: (id: string) => `${config.url}/${id}` };
      })(),
    ),
    provideValue(Config, { url: "https://db" }),
  ]);

  assert.equal(result, "https://db/u1");
});

test("inject resolves an async provider from a sync app", async () => {
  const result = inject(findUser(), [
    provide(Db, async function* () {
      const config = yield* Config;
      await Promise.resolve();
      return { find: (id: string) => `${config.url}/${id}` };
    }),
    provideValue(Config, { url: "https://db" }),
  ]);

  assert.ok(result instanceof Promise, "inject always returns a Promise");
  assert.equal(await result, "https://db/u1");
});

test("inject resolves a nested async provider dependency", async () => {
  const result = inject(findUser(), [
    provide(Pool, async function* () {
      const config = yield* Config;
      await Promise.resolve();
      return { size: config.url.length };
    }),
    provide(Db, function* () {
      const pool = yield* Pool;
      return { find: (id: string) => `${id}#${pool.size}` };
    }),
    provideValue(Config, { url: "0123456789" }),
  ]);

  assert.ok(result instanceof Promise, "inject always returns a Promise");
  assert.equal(await result, "u1#10");
});

test("injectLayer applies a subset and leaves an injectable for the rest", async () => {
  function* greet(id: string) {
    const db = yield* Db;
    const log = yield* Log;
    log.log("hi");
    return db.find(id);
  }

  const lines: string[] = [];
  const partial = injectLayer(greet("u1"), [
    provideValue(Db, { find: (id) => `user:${id}` }),
  ]);

  const result = await inject(partial, [
    provideValue(Log, { log: (m) => lines.push(m) }),
  ]);

  assert.equal(result, "user:u1");
  assert.deepEqual(lines, ["hi"]);
});

test("injectLayer with every binding leaves nothing remaining", async () => {
  function* greet(id: string) {
    const db = yield* Db;
    return db.find(id);
  }

  const partial = injectLayer(greet("u1"), [
    provideValue(Db, { find: (id) => `user:${id}` }),
  ]);

  assert.equal(await inject(partial, []), "user:u1");
});

test("injectLayer chains: each call peels off more bindings", async () => {
  const Step = createTag<number, "step">({ key: "step" });
  const Limit = createTag<number, "limit">({ key: "limit" });

  function* product() {
    const step = yield* Step;
    const limit = yield* Limit;
    return step * limit;
  }

  const withStep = injectLayer(product(), [provideValue(Step, 2)]);
  const withBoth = injectLayer(withStep, [provideValue(Limit, 5)]);

  assert.equal(await inject(withBoth, []), 10);
});

test("injectLayer forwards a provider's own unmet dependency as remaining", async () => {
  // The Db provider needs Config, which injectLayer doesn't cover yet.
  const partial = injectLayer(findUser(), [
    provide(Db, function* () {
      const config = yield* Config;
      return { find: (id: string) => `${config.url}/${id}` };
    }),
  ]);

  assert.equal(
    await inject(partial, [provideValue(Config, { url: "https://db" })]),
    "https://db/u1",
  );
});

test("injectLayer leaves a default to the terminal inject, which builds it", async () => {
  const DbDefault = createTag({
    key: "Db",
    defaultValue: { find: (id: string) => `default:${id}` },
  });

  function* app() {
    const db = yield* DbDefault;
    return db.find("u1");
  }

  // injectLayer doesn't bind Db; the default is resolved at inject.
  assert.equal(await inject(injectLayer(app(), []), []), "default:u1");
});

test("a default is not built at an injectLayer boundary, only at inject", async () => {
  let built = 0;
  const DbDefault = createTag({
    key: "Db",
    default: function* () {
      built++;
      return { find: (id: string) => `default:${id}` };
    },
  });

  function* app() {
    const db = yield* DbDefault;
    return db.find("u1");
  }

  // inject binds Db, so the forwarded default must never build.
  const result = await inject(injectLayer(app(), []), [
    provideValue(DbDefault, { find: (id) => `bound:${id}` }),
  ]);

  assert.equal(result, "bound:u1");
  assert.equal(built, 0);
});

test("a default forwarded through injectLayer can be overridden by inject", async () => {
  const DbDefault = createTag({
    key: "Db",
    defaultValue: { find: (id: string) => `default:${id}` },
  });

  function* app() {
    const db = yield* DbDefault;
    return db.find("u1");
  }

  assert.equal(
    await inject(injectLayer(app(), []), [
      provideValue(DbDefault, { find: (id) => `override:${id}` }),
    ]),
    "override:u1",
  );
});

test("a layer's contributions shadow contributions in an outer layer", async () => {
  const partial = injectLayer(routePaths(), [
    contributeValue(Routes, [{ path: "/inner" }]),
  ]);

  // The inner contribution wins; the outer one is shadowed, not stacked.
  assert.deepEqual(
    await inject(partial, [contributeValue(Routes, [{ path: "/outer" }])]),
    ["/inner"],
  );
});

test("an outer layer's contributions apply when the inner layer has none", async () => {
  const partial = injectLayer(routePaths(), []);

  assert.deepEqual(
    await inject(partial, [contributeValue(Routes, [{ path: "/outer" }])]),
    ["/outer"],
  );
});

test("a layer's contribution resolves its deps in that same layer", async () => {
  const partial = injectLayer(routePaths(), [
    contribute(Routes, function* () {
      const config = yield* Config;
      return [{ path: config.url }];
    }),
    provideValue(Config, { url: "/inner" }),
  ]);

  assert.deepEqual(await inject(partial, []), ["/inner"]);
});

test("injectLayer leaves remaining requests that inject still type-checks", async () => {
  function* needsLog() {
    const log = yield* Log;
    log.log("x");
    return 1;
  }

  const partial = injectLayer(needsLog(), []);

  await assert.rejects(
    // @ts-expect-error - Log is still required by the remaining injectable
    () => inject(partial, []),
    /missing provision for Log/,
  );
});

test("async provider builders are classified by the returned iterable", async () => {
  const result = inject(findUser(), [
    provide(Db, () =>
      (async function* () {
        const config = yield* Config;
        await Promise.resolve();
        return { find: (id: string) => `${config.url}/${id}` };
      })(),
    ),
    provideValue(Config, { url: "https://db" }),
  ]);

  assert.ok(result instanceof Promise, "inject always returns a Promise");
  assert.equal(await result, "https://db/u1");
});

const Mode = createTag({ key: "Mode", defaultValue: "off" });
const Tag = createTag({ key: "Tag", defaultValue: "none" });
const Flag = createTag<boolean, "Flag">({ key: "Flag" });

test("ifExists applies its binding when the condition is present", async () => {
  function* app() {
    return yield* Mode;
  }

  assert.equal(
    await inject(app(), [
      provideValue(Db, { find: (id) => id }),
      ifExists(Db, [provideValue(Mode, "on")]),
    ]),
    "on",
  );
});

test("ifExists drops its binding when the condition is absent", async () => {
  function* app() {
    return yield* Mode;
  }

  // Db is never provided, so the conditional is dropped and Mode falls back.
  assert.equal(
    await inject(app(), [ifExists(Db, [provideValue(Mode, "on")])]),
    "off",
  );
});

test("ifExists filters falsy holes left by pruning", () => {
  const Cond = createTag({ key: "Cond" });
  const A = createTag({ key: "A" });
  const conditional = ifExists(Cond, [void 0, provideValue(A, 1), null]);
  assert.equal(conditional.bindings.length, 1);
});

test("ifExists resolves transitively to a fixpoint", async () => {
  function* app() {
    return yield* Mode;
  }

  // Db enables Flag, and Flag in turn enables Mode.
  assert.equal(
    await inject(app(), [
      provideValue(Db, { find: (id) => id }),
      ifExists(Db, [provideValue(Flag, true)]),
      ifExists(Flag, [provideValue(Mode, "on")]),
    ]),
    "on",
  );
});

test("ifExists is order independent", async () => {
  function* app() {
    return yield* Mode;
  }

  // Same chain as above but listed before the binding that seeds it.
  assert.equal(
    await inject(app(), [
      ifExists(Flag, [provideValue(Mode, "on")]),
      ifExists(Db, [provideValue(Flag, true)]),
      provideValue(Db, { find: (id) => id }),
    ]),
    "on",
  );
});

test("a chain whose root is absent is dropped entirely", async () => {
  function* app() {
    return yield* Mode;
  }

  // Nothing seeds Db, so neither Flag nor Mode is applied.
  assert.equal(
    await inject(app(), [
      ifExists(Db, [provideValue(Flag, true)]),
      ifExists(Flag, [provideValue(Mode, "on")]),
    ]),
    "off",
  );
});

test("a conditionally provided service is not statically counted as covered", async () => {
  const result = await inject(
    findUser(),
    // @ts-expect-error - Db is provided only conditionally, so it is not counted
    // as covered, even though Config makes it apply (and resolve its deps) at runtime.
    [
      provideValue(Config, { url: "/api" }),
      ifExists(Config, [
        provide(Db, function* () {
          const config = yield* Config;
          return { find: (id: string) => `${config.url}/${id}` };
        }),
      ]),
    ],
  );

  assert.equal(result, "/api/u1");
});

test("ifExists can gate a contribution", async () => {
  assert.deepEqual(
    await inject(routePaths(), [
      provideValue(Db, { find: (id) => id }),
      contributeValue(Routes, [{ path: "/base" }]),
      ifExists(Db, [contributeValue(Routes, [{ path: "/extra" }])]),
    ]),
    ["/base", "/extra"],
  );
});

test("a gated contribution is dropped when its condition is absent", async () => {
  assert.deepEqual(
    await inject(routePaths(), [
      contributeValue(Routes, [{ path: "/base" }]),
      ifExists(Db, [contributeValue(Routes, [{ path: "/extra" }])]),
    ]),
    ["/base"],
  );
});

test("an applied conditional that collides rejects as a duplicate", async () => {
  await assert.rejects(
    () =>
      inject(findUser(), [
        provideValue(Db, { find: () => "first" }),
        ifExists(Db, [provideValue(Db, { find: () => "second" })]),
      ]),
    /duplicate provision for Db/,
  );
});

test("ifExists evaluates its condition only within its own layer", async () => {
  function* app() {
    return yield* Mode;
  }

  // Db is provided in the outer layer; the inner conditional cannot see it.
  const partial = injectLayer(app(), [
    ifExists(Db, [provideValue(Mode, "on")]),
  ]);

  assert.equal(
    await inject(partial, [provideValue(Db, { find: (id) => id })]),
    "off",
  );
});

test("ifExists applies a whole group of bindings together", async () => {
  function* app() {
    return `${yield* Mode}:${yield* Tag}`;
  }

  assert.equal(
    await inject(app(), [
      provideValue(Db, { find: (id) => id }),
      ifExists(Db, [provideValue(Mode, "on"), provideValue(Tag, "x")]),
    ]),
    "on:x",
  );
});

test("conditionals on the same key merge rather than apply early", async () => {
  function* app() {
    return `${yield* Mode}:${yield* Tag}`;
  }

  // Two conditionals share the Db condition. With Db absent, neither applies —
  // the second must not apply its group eagerly just because the first is queued.
  assert.equal(
    await inject(app(), [
      ifExists(Db, [provideValue(Mode, "on")]),
      ifExists(Db, [provideValue(Tag, "x")]),
    ]),
    "off:none",
  );

  // With Db present, both merged groups apply.
  assert.equal(
    await inject(app(), [
      provideValue(Db, { find: (id) => id }),
      ifExists(Db, [provideValue(Mode, "on")]),
      ifExists(Db, [provideValue(Tag, "x")]),
    ]),
    "on:x",
  );
});

test("ifExists nests: an inner conditional needs both conditions", async () => {
  function* app() {
    return yield* Mode;
  }

  const condition = ifExists(Db, [ifExists(Flag, [provideValue(Mode, "on")])]);

  // Db alone: the inner ifExists(Flag) is registered but Flag never appears.
  assert.equal(
    await inject(app(), [provideValue(Db, { find: (id) => id }), condition]),
    "off",
  );

  // Db enables Flag, and Flag in turn enables the nested Mode.
  assert.equal(
    await inject(app(), [
      provideValue(Db, { find: (id) => id }),
      ifExists(Db, [provideValue(Flag, true)]),
      condition,
    ]),
    "on",
  );
});

test("injectSync resolves a fully synchronous tree directly", () => {
  function* getUser(id: string) {
    const db = yield* Db;
    return db.find(id);
  }

  // injectSync returns the value directly — no await, typed as A not Promise<A>.
  const result: string = injectSync(getUser("u1"), [
    provideValue(Db, { find: (id) => `user:${id}` }),
  ]);

  assert.equal(result, "user:u1");
});

test("injectSync builds sync providers once, as singletons", () => {
  let built = 0;
  function* app() {
    const first = yield* Db;
    const second = yield* Db;
    return first === second;
  }

  const result = injectSync(app(), [
    provide(Db, function* () {
      built++;
      const config = yield* Config;
      return { find: (id: string) => `${config.url}/${id}` };
    }),
    provideValue(Config, { url: "/db" }),
  ]);

  assert.equal(result, true);
  assert.equal(built, 1);
});

test("injectSync throws synchronously on a missing provision", () => {
  function* app() {
    const log = yield* Log;
    log.log("x");
    return 1;
  }

  assert.throws(() => injectSync(app(), []), /missing provision for Log/);
});

test("injectSync throws when a builder is async", () => {
  assert.throws(
    () =>
      injectSync(findUser(), [
        provide(Db, async function* () {
          await Promise.resolve();
          return { find: (id: string) => id };
        }),
      ]),
    /async work encountered in a sync inject/,
  );
});

test("injectSync throws when the source itself is async", () => {
  async function* app() {
    const db = yield* Db;
    return db.find("u1");
  }

  assert.throws(
    () => injectSync(app(), [provideValue(Db, { find: (id) => id })]),
    /async work encountered in a sync inject/,
  );
});

test("a sync source's finally runs when runSync aborts on async", async () => {
  let cleaned = false;
  function* app() {
    try {
      const db = yield* Db; // resolved by an async provider in the context
      return db.find("u1");
    } finally {
      cleaned = true;
    }
  }

  // a context whose Db is an async provider
  const ctx = await inject(captureContext(), [
    provide(Db, async function* () {
      await Promise.resolve();
      return { find: (id: string) => id };
    }),
  ]);

  assert.throws(
    () => runSync(app(), ctx),
    /async work encountered in a sync inject/,
  );
  assert.equal(cleaned, true);
});

test("injectLayer peels a layer that injectSync then finishes synchronously", () => {
  function* greet(id: string) {
    const db = yield* Db;
    const log = yield* Log;
    log.log("hi");
    return db.find(id);
  }

  const lines: string[] = [];
  const partial = injectLayer(greet("u1"), [
    provideValue(Db, { find: (id) => `user:${id}` }),
  ]);

  assert.equal(
    injectSync(partial, [provideValue(Log, { log: (m) => lines.push(m) })]),
    "user:u1",
  );
  assert.deepEqual(lines, ["hi"]);
});

test("the same injectLayer partial works under either terminal", async () => {
  function* getUser(id: string) {
    const db = yield* Db;
    return db.find(id);
  }

  const make = () =>
    injectLayer(getUser("u1"), [
      provideValue(Db, { find: (id) => `user:${id}` }),
    ]);

  assert.equal(injectSync(make(), []), "user:u1");
  assert.equal(await inject(make(), []), "user:u1");
});

function* captureContext() {
  return yield* Context;
}

test("inject resolves remaining services from a supplied context", async () => {
  function* getUser(id: string) {
    const db = yield* Db;
    return db.find(id);
  }

  const ctx = await inject(captureContext(), [
    provideValue(Db, { find: (id) => `user:${id}` }),
  ]);

  assert.equal(await runPromise(getUser("u1"), ctx), "user:u1");
});

test("injectLayer's layer shadows the context it runs on", async () => {
  function* getUser(id: string) {
    const db = yield* Db;
    return db.find(id);
  }

  const ctx = await inject(captureContext(), [
    provideValue(Db, { find: (id) => `base:${id}` }),
  ]);

  assert.equal(
    await runPromise(
      injectLayer(getUser("u1"), [
        provideValue(Db, { find: (id) => `over:${id}` }),
      ]),
      ctx,
    ),
    "over:u1",
  );
});

test("inject reuses singletons already built in the context", async () => {
  let built = 0;
  function* warm() {
    yield* Db; // force Db to build in the base context
    return yield* Context;
  }
  const ctx = await inject(warm(), [
    provide(Db, function* () {
      built++;
      return { find: (id: string) => `user:${id}` };
    }),
  ]);

  assert.equal(built, 1);
  assert.equal(await runPromise(findUser(), ctx), "user:u1");
  assert.equal(built, 1, "the context's singleton is reused, not rebuilt");
});

test("a context binding sees its own layer and above, never an inner layer", async () => {
  // The Db provider lives in the base context and depends on Config.
  const ctx = await inject(captureContext(), [
    provide(Db, function* () {
      const config = yield* Config;
      return { find: (id: string) => `${config.url}/${id}` };
    }),
    provideValue(Config, { url: "/base" }),
  ]);

  // The inner layer overrides Config, but Db (resolved from the context layer)
  // still sees the base Config — it cannot reach the inner layer below it.
  assert.equal(
    await runPromise(
      injectLayer(findUser(), [provideValue(Config, { url: "/inner" })]),
      ctx,
    ),
    "/base/u1",
  );
});

test("inject rejects when neither the layer nor the context provides a service", async () => {
  function* app() {
    const log = yield* Log;
    log.log("x");
    return 1;
  }

  const ctx = await inject(captureContext(), [
    provideValue(Db, { find: (id) => id }),
  ]);

  await assert.rejects(
    () => runPromise(app(), ctx),
    /missing provision for Log/,
  );
});

test("runSync runs an injectable against a context synchronously", () => {
  function* getUser(id: string) {
    const db = yield* Db;
    return db.find(id);
  }

  const ctx = injectSync(captureContext(), [
    provideValue(Db, { find: (id) => `user:${id}` }),
  ]);

  assert.equal(runSync(getUser("u1"), ctx), "user:u1");
});

test("a service callback injects a second source on the ambient context", async () => {
  const Handler = createTag<{ run(id: string): Promise<string> }, "Handler">({
    key: "Handler",
  });
  const Request = createTag<string, "Request">({ key: "Request" });

  function* handle() {
    const config = yield* Config; // ambient
    const id = yield* Request; // request-scoped, added by the nested inject
    return `${config.url}/${id}`;
  }

  function* app() {
    const handler = yield* Handler;
    return handler.run("u1");
  }

  const result = await inject(app(), [
    provideValue(Config, { url: "/api" }),
    provide(Handler, function* () {
      const ctx = yield* Context;
      return {
        run: (id: string) =>
          runPromise(injectLayer(handle(), [provideValue(Request, id)]), ctx),
      };
    }),
  ]);

  assert.equal(result, "/api/u1");
});

test("a self-yield* is a cycle", async () => {
  function* app() {
    return yield* Db;
  }

  await assert.rejects(
    () =>
      inject(app(), [
        provide(Db, function* () {
          return yield* Db; // a real cycle
        }),
      ]),
    /dependency cycle at Db/,
  );
});
