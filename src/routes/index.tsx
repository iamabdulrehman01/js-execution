import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { runInstrumented, type StepEvent } from "@/lib/instrument";
import { analyzeHoisting, type MemoryStep } from "@/lib/hoisting";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "JS Step Visualizer" },
      {
        name: "description",
        content:
          "Write JavaScript and watch it execute line by line with a live call stack, microtask & callback queue visualization.",
      },
    ],
  }),
  component: Index,
});

const SAMPLE = `var a = 10;
let b = 20;
const c = 30;

function greet() {
  console.log("hi");
}

a = 99;
greet();

setTimeout(function timerA() {
  console.log("timer A");
}, 0);

Promise.resolve().then(function micro1() {
  console.log("promise first!");
});

console.log("script end");
`;

type View = "lines" | "stack" | "memory";

type WebApiItem = { id: number; label: string };
type QueueItem = { id: number; label: string };
type Frame = { line: number; name: string };

function renderHighlightedCode(code: string) {
  const tokens = code.split(/(\s+|[{}();,.=:+\-*/%&|!?<>\[\]'])/g);

  return tokens.map((token, index) => {
    const trimmed = token.trim();
    const isKeyword =
      /\b(var|let|const|function|return|if|else|for|while|setTimeout|Promise|console|new|class|try|catch|throw|break|continue)\b/.test(
        token,
      );
    const isString = /^(['"`]).*\1$/.test(trimmed) || /^(['"`])/.test(trimmed);
    const isNumber = /^-?\d+(\.\d+)?$/.test(trimmed);
    const isComment = /^\/\//.test(trimmed) || /^\/\*|\*\//.test(trimmed);
    const isFunctionName = /\bfunction\b/.test(token) && !/\bfunction\b/.test(trimmed);

    const colorClass = isComment
      ? "text-slate-500"
      : isString
        ? "text-emerald-300"
        : isNumber
          ? "text-amber-300"
          : isKeyword
            ? "text-fuchsia-400 font-semibold"
            : isFunctionName
              ? "text-cyan-300"
              : "text-slate-100";

    return (
      <span key={`${token}-${index}`} className={colorClass}>
        {token}
      </span>
    );
  });
}

function Index() {
  const [code, setCode] = useState(SAMPLE);
  const [view, setView] = useState<View>("lines");
  const [running, setRunning] = useState(false);
  const [currentLine, setCurrentLine] = useState<number | null>(null);
  const [stack, setStack] = useState<Frame[]>([]);
  const [webApis, setWebApis] = useState<WebApiItem[]>([]);
  const [microQ, setMicroQ] = useState<QueueItem[]>([]);
  const [macroQ, setMacroQ] = useState<QueueItem[]>([]);
  const [heap, setHeap] = useState<{ id: number; label: string }[]>([]);
  const [phase, setPhase] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  const cancelRef = useRef(false);

  const lines = useMemo(() => code.split("\n"), [code]);

  const reset = () => {
    setCurrentLine(null);
    setStack([]);
    setWebApis([]);
    setMicroQ([]);
    setMacroQ([]);
    setHeap([]);
    setPhase("");
    setLogs([]);
    setFlash(null);
  };

  const handleRun = async () => {
    if (running) return;
    setRunning(true);
    reset();
    cancelRef.current = false;

    const localStack: Frame[] = [{ line: 0, name: "(global)" }];
    setStack([...localStack]);
    let apis: WebApiItem[] = [];
    let micro: QueueItem[] = [];
    let macro: QueueItem[] = [];
    let heapArr: { id: number; label: string }[] = [];

    await runInstrumented(
      code,
      (e) => {
        if (cancelRef.current) return;
        switch (e.kind) {
          case "line":
            setCurrentLine(e.line);
            break;
          case "push":
            localStack.push({ line: e.line, name: e.name });
            setStack([...localStack]);
            setFlash(`stack`);
            break;
          case "pop":
            localStack.pop();
            setStack([...localStack]);
            break;
          case "log":
            setLogs((l) => [...l, e.text]);
            break;
          case "error":
            setLogs((l) => [...l, `⚠ ${e.text}`]);
            break;
          case "webapi":
            apis = [...apis, { id: e.id, label: e.label }];
            setWebApis(apis);
            setFlash("webapi");
            break;
          case "webapi_done":
            apis = apis.filter((a) => a.id !== e.id);
            setWebApis(apis);
            break;
          case "enqueue":
            if (e.queue === "micro") {
              micro = [...micro, { id: e.id, label: e.label }];
              setMicroQ(micro);
              setFlash("micro");
            } else {
              macro = [...macro, { id: e.id, label: e.label }];
              setMacroQ(macro);
              setFlash("macro");
            }
            break;
          case "dequeue":
            if (e.queue === "micro") {
              micro = micro.filter((m) => m.id !== e.id);
              setMicroQ(micro);
            } else {
              macro = macro.filter((m) => m.id !== e.id);
              setMacroQ(macro);
            }
            break;
          case "heap":
            heapArr = [...heapArr, { id: e.id, label: e.label }];
            setHeap(heapArr);
            break;
          case "tick":
            setPhase(e.phase);
            break;
          case "done":
            setPhase("done");
            break;
        }
      },
      450,
      () => cancelRef.current,
    );

    setRunning(false);
    setCurrentLine(null);
  };

  const handleStop = () => {
    cancelRef.current = true;
    setRunning(false);
  };

  return (
    <main className="relative min-h-screen overflow-hidden bg-transparent px-3 py-4 text-foreground sm:px-4 lg:px-6">
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <header className="glass-panel rounded-[28px] border border-white/10 px-6 py-5">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.25em] text-cyan-200">
            <span className="h-2 w-2 rounded-full bg-cyan-300" />
            Interactive event loop explorer
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            JavaScript Step Visualizer — Event Loop
          </h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-300 sm:text-base">
            Write code on the left. Hit Run to watch line-by-line execution, or switch to{" "}
            <strong className="text-white">Call stack</strong> to see the Heap, Call Stack, Web
            APIs, Microtask Queue (priority), and Callback Queue in motion.
          </p>
        </header>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* LEFT: editor */}
          <section className="glass-panel flex flex-col overflow-hidden rounded-[24px] border border-white/10">
            <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-4 py-3">
              <span className="text-sm font-semibold text-white">Editor</span>
              <div className="flex gap-2">
                <button
                  onClick={handleRun}
                  disabled={running}
                  className="rounded-full bg-gradient-to-r from-fuchsia-500 via-violet-500 to-cyan-500 px-3 py-1.5 text-sm font-semibold text-white shadow-lg shadow-fuchsia-500/20 transition hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {running ? "Running…" : "▶ Run"}
                </button>
                {running && (
                  <button
                    onClick={handleStop}
                    className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-sm font-medium text-slate-100 transition hover:bg-white/20"
                  >
                    Stop
                  </button>
                )}
              </div>
            </div>
            <div className="min-h-[560px] flex-1 overflow-auto bg-[#0f172a] p-0">
              <div className="flex min-h-full bg-[radial-gradient(circle_at_top_left,_rgba(168,85,247,0.16),_transparent_35%),linear-gradient(135deg,_#0f172a_0%,_#111827_100%)]">
                <div className="w-12 select-none border-r border-white/10 bg-slate-950/70 px-2 py-4 text-right font-mono text-xs leading-7 text-slate-500">
                  {lines.map((_, index) => (
                    <div key={index}>{index + 1}</div>
                  ))}
                </div>
                <div className="relative flex-1">
                  <pre className="pointer-events-none absolute inset-0 whitespace-pre-wrap p-4 font-mono text-sm leading-7">
                    <code>{renderHighlightedCode(code)}</code>
                  </pre>
                  <textarea
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    spellCheck={false}
                    className="relative z-10 h-full min-h-[560px] w-full resize-none bg-transparent p-4 font-mono text-sm leading-7 text-transparent caret-slate-50 outline-none"
                  />
                </div>
              </div>
            </div>
          </section>

          {/* RIGHT: visualization */}
          <section className="glass-panel flex flex-col overflow-hidden rounded-[24px] border border-white/10">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-white/5 px-4 py-3">
              <span className="text-sm font-semibold text-white">Visualization</span>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setView("lines")}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                    view === "lines"
                      ? "bg-gradient-to-r from-fuchsia-500 to-cyan-500 text-white shadow-lg"
                      : "border border-white/10 bg-white/10 text-slate-200 hover:bg-white/20"
                  }`}
                >
                  Code line by line
                </button>
                <button
                  onClick={() => setView("stack")}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                    view === "stack"
                      ? "bg-gradient-to-r from-fuchsia-500 to-cyan-500 text-white shadow-lg"
                      : "border border-white/10 bg-white/10 text-slate-200 hover:bg-white/20"
                  }`}
                >
                  Call stack
                </button>
                <button
                  onClick={() => setView("memory")}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                    view === "memory"
                      ? "bg-gradient-to-r from-fuchsia-500 to-cyan-500 text-white shadow-lg"
                      : "border border-white/10 bg-white/10 text-slate-200 hover:bg-white/20"
                  }`}
                >
                  Memory & Hoisting
                </button>
              </div>
            </div>

            <div className="flex flex-1 flex-col">
              {view === "lines" ? (
                <LineView lines={lines} currentLine={currentLine} />
              ) : view === "stack" ? (
                <EventLoopView
                  stack={stack}
                  webApis={webApis}
                  microQ={microQ}
                  macroQ={macroQ}
                  heap={heap}
                  phase={phase}
                  flash={flash}
                />
              ) : (
                <MemoryView code={code} />
              )}

              <div className="border-t border-white/10 bg-slate-950/50 p-3">
                <div className="mb-1 text-xs font-semibold uppercase tracking-[0.25em] text-cyan-200">
                  Console
                </div>
                <div className="max-h-32 overflow-auto font-mono text-xs text-slate-200">
                  {logs.length === 0 ? (
                    <span className="text-slate-400">No output yet.</span>
                  ) : (
                    logs.map((l, i) => (
                      <div key={i} className="whitespace-pre-wrap">
                        {l}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function LineView({ lines, currentLine }: { lines: string[]; currentLine: number | null }) {
  return (
    <div className="overflow-auto bg-slate-950/70 p-2 font-mono text-sm">
      {lines.map((l, i) => {
        const ln = i + 1;
        const active = ln === currentLine;
        return (
          <div
            key={i}
            className={`flex gap-3 rounded-lg px-2 py-1 transition-all ${
              active
                ? "bg-gradient-to-r from-fuchsia-500/20 to-cyan-500/20 ring-1 ring-cyan-400/50"
                : "hover:bg-white/5"
            }`}
          >
            <span className="w-8 select-none text-right text-slate-500">{ln}</span>
            <span className={`whitespace-pre ${active ? "font-semibold text-slate-50" : ""}`}>
              {l ? <code>{renderHighlightedCode(l)}</code> : " "}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Panel({
  title,
  accent,
  children,
  flashed,
  hint,
}: {
  title: string;
  accent: string;
  children: React.ReactNode;
  flashed?: boolean;
  hint?: string;
}) {
  return (
    <div
      className={`rounded-2xl border-2 bg-slate-950/60 p-3 shadow-[0_12px_35px_rgba(2,6,23,0.3)] transition ${
        flashed ? "ring-4 ring-cyan-400/40" : ""
      }`}
      style={{ borderColor: accent }}
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div className="text-xs font-bold uppercase tracking-wide" style={{ color: accent }}>
          {title}
        </div>
        {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function EventLoopView({
  stack,
  webApis,
  microQ,
  macroQ,
  heap,
  phase,
  flash,
}: {
  stack: Frame[];
  webApis: WebApiItem[];
  microQ: QueueItem[];
  macroQ: QueueItem[];
  heap: { id: number; label: string }[];
  phase: string;
  flash: string | null;
}) {
  return (
    <div className="flex-1 overflow-auto p-4">
      {/* JS engine row */}
      <div className="rounded-[22px] border border-cyan-400/30 bg-gradient-to-br from-fuchsia-500/10 via-slate-900/70 to-cyan-500/10 p-3">
        <div className="mb-3 inline-block rounded-full bg-gradient-to-r from-fuchsia-500 to-cyan-500 px-3 py-1 text-[11px] font-black uppercase tracking-[0.3em] text-white">
          JS ENGINE
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Panel title="Heap" accent="#f59e0b" hint="objects / closures">
            <div className="flex min-h-[120px] flex-wrap content-start gap-2">
              {heap.length === 0 && (
                <span className="text-xs text-muted-foreground">(allocations appear here)</span>
              )}
              {heap.map((h) => (
                <span
                  key={h.id}
                  className="rounded bg-amber-200 px-2 py-1 text-[11px] text-amber-900"
                >
                  {h.label}
                </span>
              ))}
            </div>
          </Panel>
          <Panel
            title="Call Stack"
            accent="#3b82f6"
            hint="LIFO — top runs now"
            flashed={flash === "stack"}
          >
            <div className="flex min-h-[120px] flex-col-reverse gap-1">
              {stack.length === 0 && <span className="text-xs text-muted-foreground">(empty)</span>}
              {stack.map((f, i) => {
                const isTop = i === stack.length - 1;
                return (
                  <div
                    key={i}
                    className={`rounded border px-2 py-1.5 text-xs transition ${
                      isTop
                        ? "border-blue-500 bg-blue-500/15 font-semibold"
                        : "border-border bg-muted/40"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span>{f.name}()</span>
                      {f.line > 0 && (
                        <span className="text-[10px] text-muted-foreground">L{f.line}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>
        </div>
      </div>

      {/* Web APIs */}
      <div className="mt-3 flex items-center justify-center">
        <div className="text-xs text-muted-foreground">
          ▲ event loop pushes ready callback onto stack ▲
        </div>
      </div>

      <div className="mt-2">
        <Panel
          title="Web APIs (browser)"
          accent="#10b981"
          hint="setTimeout, fetch, DOM, etc."
          flashed={flash === "webapi"}
        >
          <div className="flex min-h-[60px] flex-wrap gap-2">
            {webApis.length === 0 && (
              <span className="text-xs text-muted-foreground">(no async work in flight)</span>
            )}
            {webApis.map((w) => (
              <span
                key={w.id}
                className="rounded-md border border-emerald-500 bg-emerald-500/10 px-2 py-1 text-xs"
              >
                ⏱ {w.label}
              </span>
            ))}
          </div>
        </Panel>
      </div>

      {/* Queues */}
      <div className="mt-3 grid grid-cols-1 gap-3">
        <Panel
          title="Microtask Queue  ★ HIGHER PRIORITY"
          accent="#a855f7"
          hint="Promise.then, queueMicrotask — fully drained before each macrotask"
          flashed={flash === "micro"}
        >
          <div className="flex min-h-[44px] flex-wrap gap-2">
            {microQ.length === 0 && <span className="text-xs text-muted-foreground">(empty)</span>}
            {microQ.map((m, i) => (
              <span
                key={m.id}
                className="rounded-md border border-purple-500 bg-purple-500/15 px-2 py-1 text-xs"
              >
                {i + 1}. {m.label}
              </span>
            ))}
          </div>
        </Panel>

        <Panel
          title="Callback Queue (macrotasks)"
          accent="#6b7280"
          hint="setTimeout cbs, I/O — only when stack & microtasks are empty"
          flashed={flash === "macro"}
        >
          <div className="flex min-h-[44px] flex-wrap gap-2">
            {macroQ.length === 0 && <span className="text-xs text-muted-foreground">(empty)</span>}
            {macroQ.map((m, i) => (
              <span
                key={m.id}
                className="rounded-md border border-border bg-muted px-2 py-1 text-xs"
              >
                {i + 1}. {m.label}
              </span>
            ))}
          </div>
        </Panel>
      </div>

      {/* Event loop badge */}
      <div className="mt-4 flex items-center justify-center gap-3 rounded-lg border border-border bg-muted/40 p-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-primary text-lg">
          ↻
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-wide text-primary">Event Loop</div>
          <div className="text-xs text-muted-foreground">{phase || "idle — waiting"}</div>
        </div>
        <div className="ml-auto text-[10px] text-muted-foreground">
          stack empty → drain ALL microtasks → run 1 macrotask → repeat
        </div>
      </div>

      <div className="mt-3 rounded-md border border-dashed border-border p-2 text-[11px] text-muted-foreground">
        <strong>Priority order:</strong> 1) sync code on Call Stack → 2) entire Microtask Queue
        (promises) → 3) one Callback Queue task (setTimeout) → back to microtasks. That's why a{" "}
        <code>Promise.then</code> always runs before a <code>setTimeout(0)</code> scheduled earlier.
      </div>
    </div>
  );
}

function MemoryView({ code }: { code: string }) {
  const steps = useMemo<MemoryStep[]>(() => analyzeHoisting(code), [code]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    setIdx(0);
    setPlaying(false);
  }, [code]);

  useEffect(() => {
    if (!playing) return;
    if (idx >= steps.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setIdx((i) => Math.min(i + 1, steps.length - 1)), 900);
    return () => clearTimeout(t);
  }, [playing, idx, steps.length]);

  const step = steps[idx];
  const phaseColor =
    step?.phase === "creation"
      ? "bg-amber-500/15 border-amber-500 text-amber-200"
      : "bg-emerald-500/15 border-emerald-500 text-emerald-200";

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setIdx(0)}
          className="rounded border border-input px-2 py-1 text-xs hover:bg-accent"
        >
          ⏮ Reset
        </button>
        <button
          onClick={() => setIdx((i) => Math.max(0, i - 1))}
          className="rounded border border-input px-2 py-1 text-xs hover:bg-accent"
        >
          ◀ Prev
        </button>
        <button
          onClick={() => setPlaying((p) => !p)}
          className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
        >
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button
          onClick={() => setIdx((i) => Math.min(steps.length - 1, i + 1))}
          className="rounded border border-input px-2 py-1 text-xs hover:bg-accent"
        >
          Next ▶
        </button>
        <span className="ml-auto text-xs text-muted-foreground">
          Step {idx + 1} / {steps.length}
        </span>
      </div>

      {step && (
        <>
          <div className={`mb-3 rounded-lg border-2 p-3 ${phaseColor}`}>
            <div className="text-[10px] font-black uppercase tracking-widest">
              {step.phase === "creation" ? "Phase 1 — Creation (Hoisting)" : "Phase 2 — Execution"}
              {step.line > 0 && <span className="ml-2 opacity-70">· line {step.line}</span>}
            </div>
            <div className="mt-1 text-base font-semibold">{step.title}</div>
            <div className="mt-1 text-xs opacity-90">{step.explanation}</div>
          </div>

          <div className="rounded-lg border-2 border-blue-500 bg-card p-3">
            <div className="mb-2 text-xs font-bold uppercase tracking-wide text-blue-400">
              Memory (Variable Environment)
            </div>
            {step.memory.length === 0 ? (
              <div className="text-xs text-muted-foreground">(empty — nothing allocated yet)</div>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-2">Identifier</th>
                    <th className="py-1 pr-2">Kind</th>
                    <th className="py-1 pr-2">Value in memory</th>
                    <th className="py-1">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {step.memory.map((v) => {
                    const tdz = v.value === "<TDZ>";
                    const undef = v.value === "undefined";
                    return (
                      <tr key={v.name} className="border-t border-border/60">
                        <td className="py-1.5 pr-2 font-mono font-semibold">{v.name}</td>
                        <td className="py-1.5 pr-2">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                              v.kind === "var"
                                ? "bg-orange-500/20 text-orange-300"
                                : v.kind === "let"
                                  ? "bg-sky-500/20 text-sky-300"
                                  : v.kind === "const"
                                    ? "bg-purple-500/20 text-purple-300"
                                    : "bg-emerald-500/20 text-emerald-300"
                            }`}
                          >
                            {v.kind}
                          </span>
                        </td>
                        <td className="py-1.5 pr-2 font-mono">
                          <span
                            className={
                              tdz
                                ? "rounded bg-red-500/20 px-1.5 py-0.5 text-red-300"
                                : undef
                                  ? "text-muted-foreground"
                                  : "text-emerald-300"
                            }
                          >
                            {v.value}
                          </span>
                        </td>
                        <td className="py-1.5 text-muted-foreground">{v.note ?? ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="mt-3 rounded-md border border-dashed border-border p-2 text-[11px] text-muted-foreground">
            <strong>How hoisting works:</strong> before any code runs, JS scans the scope and
            reserves memory. <code>function</code> declarations are stored complete.{" "}
            <code>var</code> gets the slot but value <code>undefined</code>. <code>let</code> /{" "}
            <code>const</code> get a slot but stay in the <strong>Temporal Dead Zone</strong> until
            their line — touching them earlier throws ReferenceError.
          </div>
        </>
      )}
    </div>
  );
}
