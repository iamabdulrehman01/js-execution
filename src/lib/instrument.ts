import { parse } from "acorn";
import { generate } from "astring";
import type { Node } from "acorn";

export type StepEvent =
  | { kind: "line"; line: number; snippet: string }
  | { kind: "push"; line: number; name: string }
  | { kind: "pop"; line: number; name: string }
  | { kind: "log"; line: number; text: string }
  | { kind: "error"; line: number; text: string }
  // event-loop events
  | { kind: "webapi"; id: number; label: string; api: "timer" | "promise" | "other" }
  | { kind: "webapi_done"; id: number }
  | { kind: "enqueue"; id: number; label: string; queue: "micro" | "macro" }
  | { kind: "dequeue"; id: number; queue: "micro" | "macro" }
  | { kind: "heap"; id: number; label: string }
  | { kind: "tick"; phase: string }
  | { kind: "done" };

const STATEMENT_TYPES = new Set([
  "ExpressionStatement",
  "VariableDeclaration",
  "ReturnStatement",
  "IfStatement",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
  "ThrowStatement",
  "TryStatement",
  "SwitchStatement",
  "BreakStatement",
  "ContinueStatement",
]);

function makeStepCall(line: number, snippet: string) {
  return {
    type: "ExpressionStatement",
    expression: {
      type: "CallExpression",
      callee: { type: "Identifier", name: "__step" },
      arguments: [
        { type: "Literal", value: line },
        { type: "Literal", value: snippet },
      ],
      optional: false,
    },
  } as unknown as Node;
}

function instrumentBlock(body: any[], source: string) {
  const out: any[] = [];
  for (const stmt of body) {
    if (STATEMENT_TYPES.has(stmt.type) && stmt.loc) {
      const line = stmt.loc.start.line;
      const snippet = source.slice(stmt.start, stmt.end).split("\n")[0].slice(0, 80);
      out.push(makeStepCall(line, snippet));
    }
    instrumentChildren(stmt, source);
    out.push(stmt);
  }
  return out;
}

function instrumentChildren(node: any, source: string) {
  if (!node || typeof node !== "object") return;

  if (
    (node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression") &&
    node.body &&
    node.body.type === "BlockStatement"
  ) {
    const name =
      node.id?.name || (node.type === "ArrowFunctionExpression" ? "arrow" : "anonymous");
    const line = node.loc?.start.line ?? 0;
    const inner = instrumentBlock(node.body.body, source);

    const wrapped = [
      {
        type: "ExpressionStatement",
        expression: {
          type: "CallExpression",
          callee: { type: "Identifier", name: "__push" },
          arguments: [
            { type: "Literal", value: line },
            { type: "Literal", value: name },
          ],
          optional: false,
        },
      },
      {
        type: "TryStatement",
        block: { type: "BlockStatement", body: inner },
        handler: null,
        finalizer: {
          type: "BlockStatement",
          body: [
            {
              type: "ExpressionStatement",
              expression: {
                type: "CallExpression",
                callee: { type: "Identifier", name: "__pop" },
                arguments: [
                  { type: "Literal", value: line },
                  { type: "Literal", value: name },
                ],
                optional: false,
              },
            },
          ],
        },
      },
    ];
    node.body.body = wrapped;
    return;
  }

  if (node.type === "BlockStatement") {
    node.body = instrumentBlock(node.body, source);
  }

  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    const v = (node as any)[key];
    if (Array.isArray(v)) v.forEach((c) => instrumentChildren(c, source));
    else if (v && typeof v === "object" && v.type) instrumentChildren(v, source);
  }
}

export function instrument(source: string): string {
  const ast: any = parse(source, { ecmaVersion: "latest", locations: true });
  ast.body = instrumentBlock(ast.body, source);
  return generate(ast);
}

export function collectEvents(code: string): StepEvent[] {
  const events: StepEvent[] = [];
  let instrumented: string;
  try {
    instrumented = instrument(code);
  } catch (err: any) {
    events.push({ kind: "error", line: 0, text: `Parse error: ${err.message}` });
    events.push({ kind: "done" });
    return events;
  }

  let nextId = 0;
  let now = 0;
  const microQueue: { id: number; label: string; fn: () => void }[] = [];
  const macroQueue: { id: number; label: string; fn: () => void }[] = [];
  const pendingTimers: { id: number; label: string; fn: () => void; dueAt: number }[] = [];

  const MAX_STEPS = 8000;
  let stepCount = 0;

  const __step = (line: number, snippet: string) => {
    if (++stepCount > MAX_STEPS) {
      throw new Error(`Step limit (${MAX_STEPS}) exceeded — possible infinite loop`);
    }
    events.push({ kind: "line", line, snippet });
  };
  const __push = (line: number, name: string) => {
    events.push({ kind: "push", line, name });
  };
  const __pop = (line: number, name: string) => {
    events.push({ kind: "pop", line, name });
  };
  const __heap = (label: string) => {
    const id = ++nextId;
    events.push({ kind: "heap", id, label });
    return id;
  };

  const fakeConsole = {
    log: (...args: unknown[]) => {
      events.push({
        kind: "log",
        line: 0,
        text: args
          .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
          .join(" "),
      });
    },
  };

  const fakeSetTimeout = (fn: () => void, delay = 0) => {
    const id = ++nextId;
    const d = Math.max(0, Number(delay) || 0);
    events.push({ kind: "webapi", id, label: `setTimeout(${d}ms)`, api: "timer" });
    pendingTimers.push({ id, label: `timer cb (${d}ms)`, fn, dueAt: now + d });
    return id;
  };

  const fakeQueueMicrotask = (fn: () => void) => {
    const id = ++nextId;
    events.push({ kind: "enqueue", id, label: "microtask", queue: "micro" });
    microQueue.push({ id, label: "microtask", fn });
  };

  // Minimal Promise-like for demo: .then schedules microtask
  const fakePromise = {
    resolve: (val?: unknown) => ({
      then: (cb: (v: unknown) => unknown) => {
        const id = ++nextId;
        events.push({ kind: "enqueue", id, label: "promise.then", queue: "micro" });
        microQueue.push({ id, label: "promise.then", fn: () => cb(val) });
        return fakePromise.resolve();
      },
    }),
  };

  const runCallback = (label: string, fn: () => void) => {
    events.push({ kind: "push", line: 0, name: label });
    try {
      fn();
    } catch (err: any) {
      events.push({ kind: "error", line: 0, text: String(err?.message ?? err) });
    } finally {
      events.push({ kind: "pop", line: 0, name: label });
    }
  };

  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      "__step",
      "__push",
      "__pop",
      "__heap",
      "console",
      "setTimeout",
      "queueMicrotask",
      "Promise",
      instrumented,
    );
    events.push({ kind: "tick", phase: "run main script" });
    fn(
      __step,
      __push,
      __pop,
      __heap,
      fakeConsole,
      fakeSetTimeout,
      fakeQueueMicrotask,
      fakePromise,
    );

    // Event loop simulation
    let safety = 0;
    while (microQueue.length || macroQueue.length || pendingTimers.length) {
      if (++safety > 200) break;

      // 1. Drain microtasks fully (highest priority)
      while (microQueue.length) {
        const t = microQueue.shift()!;
        events.push({ kind: "tick", phase: "event loop → microtask queue" });
        events.push({ kind: "dequeue", id: t.id, queue: "micro" });
        runCallback(t.label, t.fn);
      }

      // 2. Move any ready (or earliest) timer from Web APIs to macro queue
      if (pendingTimers.length && !macroQueue.length) {
        pendingTimers.sort((a, b) => a.dueAt - b.dueAt);
        const t = pendingTimers.shift()!;
        now = Math.max(now, t.dueAt);
        events.push({ kind: "webapi_done", id: t.id });
        events.push({ kind: "enqueue", id: t.id, label: t.label, queue: "macro" });
        macroQueue.push({ id: t.id, label: t.label, fn: t.fn });
      }

      // 3. Run ONE macrotask, then loop back to drain micro
      if (macroQueue.length) {
        const t = macroQueue.shift()!;
        events.push({ kind: "tick", phase: "event loop → callback queue" });
        events.push({ kind: "dequeue", id: t.id, queue: "macro" });
        runCallback(t.label, t.fn);
      }
    }
  } catch (err: any) {
    events.push({ kind: "error", line: 0, text: String(err?.message ?? err) });
  } finally {
    events.push({ kind: "done" });
  }
  return events;
}

export async function runInstrumented(
  code: string,
  onEvent: (e: StepEvent) => void,
  stepDelayMs = 350,
  isCancelled: () => boolean = () => false,
): Promise<void> {
  const events = collectEvents(code);
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  for (const e of events) {
    if (isCancelled()) return;
    onEvent(e);
    if (e.kind === "line") await sleep(stepDelayMs);
    else if (
      e.kind === "webapi" ||
      e.kind === "webapi_done" ||
      e.kind === "enqueue" ||
      e.kind === "dequeue" ||
      e.kind === "tick"
    ) {
      await sleep(Math.max(120, stepDelayMs / 2));
    }
  }
}
