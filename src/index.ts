export interface Service<
  A = any,
  K extends string = string,
  Req = ServiceRequest<K>,
> extends Iterable<Req, A, A> {
  readonly key: K;
}

export type Injectable<A, R = never> = Iterable<R, A, any>;
export type AsyncInjectable<A, R = never> = AsyncIterable<R, A, any>;

export type AnyInjectable<A = any, R = never> =
  | Injectable<A, R>
  | AsyncInjectable<A, R>;

type ServiceRequest<K extends string = string> = {
  readonly key: K;
};

type ValueBinding<A, K extends string> = {
  readonly key: K;
  readonly value: A;
  readonly contribute?: true;
};
type InjectableBinding<A, K extends string, R = any> = {
  readonly key: K;
  readonly build: () => AnyInjectable<A, R>;
  readonly contribute?: true;
};

type ProvisionBinding =
  | ValueBinding<any, string>
  | InjectableBinding<any, string>;

type ConditionalBinding<K extends string = string> = {
  readonly key: K;
  readonly bindings: readonly Binding[];
};

export type Binding = ProvisionBinding | ConditionalBinding;

type DepsOf<B extends Binding> =
  B extends InjectableBinding<any, any, infer R> ? R : never;
// A conditional's key is a condition, not a provision, so it's excluded from coverage.
type Provided<B extends Binding> = Exclude<B, ConditionalBinding>["key"];
type Uncovered<R, B extends Binding> =
  R extends InjectableBinding<any, infer K, infer Deps>
    ? Extract<Provided<B>, K> extends never
      ? Uncovered<Deps, B>
      : never
    : R extends ValueBinding<any, any>
      ? never
      : R extends ServiceRequest<infer K>
        ? Extract<Provided<B>, K> extends never
          ? K
          : never
        : never;

type Missing<R, B extends Binding> = Uncovered<R | DepsOf<B>, B>;

type Bindings<R, B extends Binding> = readonly B[] &
  ([Missing<R, B>] extends [never]
    ? unknown
    : { "inject: missing provision for": Missing<R, B> });

type Rest<R, B extends Binding> =
  Missing<R, B> extends infer K
    ? K extends string
      ? ServiceRequest<K>
      : never
    : never;

// Reject explicit type args (they'd drop a default builder's inferred deps).
type Inferred =
  "inject: createTag infers its types — do not pass explicit type arguments";

/** A service whose value is built lazily when no binding covers it. */
export function createTag<
  _ extends Inferred = Inferred,
  A = unknown,
  const K extends string = string,
  R = never,
>(options: {
  key: K;
  default: () => AnyInjectable<A, R>;
}): Service<A, K, InjectableBinding<A, K, R>>;
/** A service that falls back to a fixed value when no binding covers it. */
export function createTag<
  _ extends Inferred = Inferred,
  A = unknown,
  const K extends string = string,
>(options: { key: K; defaultValue: A }): Service<A, K, ValueBinding<A, K>>;
/** A service that must be provided: acquiring it registers a dependency. */
export function createTag<A, const K extends string = string>(options: {
  key: K;
}): Service<A, K>;
export function createTag(options: {
  key: string;
  default?: () => AnyInjectable<any, any>;
  defaultValue?: unknown;
}): Service<any, string, any> {
  const yieldValue = (() => {
    if (options.default) return { key: options.key, build: options.default };
    if ("defaultValue" in options) {
      return { key: options.key, value: options.defaultValue };
    }
    return { key: options.key };
  })();
  return {
    key: options.key,
    *[Symbol.iterator]() {
      return yield yieldValue;
    },
  };
}

export function provideValue<A, K extends string>(
  service: Service<A, K>,
  value: A,
): ValueBinding<A, K> {
  return { key: service.key, value };
}

export function provide<A, K extends string, R>(
  service: Service<A, K>,
  build: () => AnyInjectable<A, R>,
): InjectableBinding<A, K, R> {
  return { key: service.key, build };
}

export function contributeValue<A extends readonly unknown[], K extends string>(
  service: Service<A, K>,
  value: A,
): ValueBinding<A, K> {
  return { key: service.key, value, contribute: true };
}

export function contribute<A extends readonly unknown[], K extends string, R>(
  service: Service<A, K>,
  build: () => AnyInjectable<A, R>,
): InjectableBinding<A, K, R> {
  return { key: service.key, build, contribute: true };
}

/**
 * Apply `bindings` only when some other binding provides `service`. Resolved to a
 * fixpoint (a conditional can enable another); unmet conditions are dropped.
 */
export function ifExists<K extends string>(
  service: Service<any, K>,
  bindings: readonly (Binding | false | null | undefined)[],
): ConditionalBinding<K> {
  return {
    key: service.key,
    bindings: bindings.filter((binding): binding is Binding =>
      Boolean(binding),
    ),
  };
}

const duplicate = (key: string) =>
  new Error(`inject: duplicate provision for ${key}`);
const cycle = (key: string) => new Error(`inject: dependency cycle at ${key}`);
const contributionNotArray = (key: string) =>
  new Error(`inject: contribution for ${key} must be an array`);
const missing = (key: string) =>
  new Error(`inject: missing provision for ${key}`);
const asyncInSync = () =>
  new Error("inject: async work encountered in a sync inject");

const isPromise = (value: unknown): value is Promise<unknown> =>
  typeof (value as { then?: unknown } | null | undefined)?.then === "function";

// An entry is a single provision or a contribution collection.
type BindingIndex = Partial<
  Record<string, ProvisionBinding | ProvisionBinding[]>
>;

// A stack of binding layers; the top layer omits `above`. The empty context is
// a node with an empty layer.
export type Context = {
  readonly layer: BindingIndex;
  readonly above?: Context;
};

/** The current context stack; pass it to `runPromise` to layer more onto it. */
export const Context = createTag({
  key: "inject.context",
  defaultValue: { layer: {} } as Context, // type-only; resolve returns the live one
});

/**
 * Run an injectable with `bindings`; a missing one is a compile error. Strict,
 * typed sugar for `runPromise(injectLayer(source, bindings))`.
 */
export async function inject<A, R, B extends Binding>(
  source: AnyInjectable<A, R>,
  bindings: Bindings<R, B>,
): Promise<A> {
  return runPromise(source, { layer: index(bindings) });
}

export function injectLayer<A, R, B extends Binding>(
  source: AnyInjectable<A, R>,
  bindings: readonly B[],
): Injectable<A, Rest<R, B>> {
  return {
    *[Symbol.iterator]() {
      const above = yield* Context;
      return yield* drive(source, { layer: index(bindings), above }, new Set());
    },
  } as Injectable<A, Rest<R, B>>;
}

export async function runPromise<A, R>(
  source: AnyInjectable<A, R>,
  context: Context = { layer: {} },
): Promise<A> {
  const driver = drive(source, context, new Set());
  let step = driver.next();
  while (!step.done) step = driver.next(await step.value);
  return step.value as A;
}

export function runSync<A, R>(
  source: AnyInjectable<A, R>,
  context: Context = { layer: {} },
): A {
  const driver = drive(source, context, new Set());
  let step = driver.next();
  if (step.done) return step.value as A;
  while (!step.done) step = driver.return(undefined); // unwind, drop async cleanup
  throw asyncInSync();
}

function index(bindings: readonly Binding[]): BindingIndex {
  const byKey: BindingIndex = {};
  const pending = new Map<string, Binding[]>();

  const add = (bindings: readonly Binding[]) => {
    for (const binding of bindings) {
      if ("bindings" in binding) {
        const list = pending.get(binding.key);
        if (list) list.push(...binding.bindings);
        else pending.set(binding.key, [...binding.bindings]);
        continue;
      }

      const previous = byKey[binding.key];
      if (binding.contribute) {
        if (previous === undefined) byKey[binding.key] = [binding];
        else if (Array.isArray(previous)) previous.push(binding);
        else throw duplicate(binding.key);
      } else {
        if (previous !== undefined) throw duplicate(binding.key);
        byKey[binding.key] = binding;
      }
    }
  };

  add(bindings);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [conditionKey, conditionalBindings] of [...pending]) {
      if (byKey[conditionKey] === undefined) continue;
      progressed = true;
      pending.delete(conditionKey);
      add(conditionalBindings);
    }
  }

  return byKey;
}

type Driver = Generator<Promise<unknown>, unknown, unknown>;

// Yield only promises (returning the awaited result); pass plain values through.
function* suspend<T>(value: T | Promise<T>): Generator<Promise<T>, T, unknown> {
  return isPromise(value) ? ((yield value) as T) : value;
}

function* resolve(
  request: ServiceRequest | ProvisionBinding,
  context: Context,
  path: Set<string>,
): Driver {
  const key = request.key;

  if (key === Context.key) return context; // the built-in: own layer + above
  if (path.has(key)) throw cycle(key);

  // innermost binding layer shadows those above
  let scope: Context | undefined = context;
  while (scope && scope.layer[key] === undefined) scope = scope.above;

  const found = scope?.layer[key];

  // unbound: build the service's own default, else it's missing
  if (found === undefined && !("value" in request || "build" in request)) {
    throw missing(key);
  }

  // resolve deps in the binding's own layer and above; a default uses the full context
  const binding = found ?? (request as ProvisionBinding);
  const target = scope ?? context;
  path.add(key);
  const value = Array.isArray(binding)
    ? yield* resolveCollection(binding, target, path)
    : yield* resolveSource(binding, target, path);
  path.delete(key);
  target.layer[key] = { key, value };
  return value;
}

function* resolveCollection(
  contributions: ProvisionBinding[],
  context: Context,
  path: Set<string>,
): Driver {
  const values = [];
  for (const contribution of contributions) {
    const fragment = yield* resolveSource(contribution, context, path);
    if (!Array.isArray(fragment)) {
      throw contributionNotArray(contribution.key);
    }
    values.push(...fragment);
  }
  return values;
}

function* resolveSource(
  binding: ProvisionBinding,
  context: Context,
  path: Set<string>,
): Driver {
  return "value" in binding
    ? binding.value
    : yield* drive(binding.build(), context, path);
}

function* drive(
  injectable: AnyInjectable<any, any>,
  context: Context,
  path: Set<string>,
): Driver {
  const it =
    Symbol.asyncIterator in injectable
      ? injectable[Symbol.asyncIterator]()
      : injectable[Symbol.iterator]();
  try {
    let step = yield* suspend(it.next());
    while (!step.done) {
      // a promise bubbles up as a suspension; anything else is a request to resolve
      const value = isPromise(step.value)
        ? yield step.value
        : yield* resolve(step.value, context, path);
      step = yield* suspend(it.next(value));
    }
    return step.value;
  } finally {
    yield* suspend(it.return?.());
  }
}
