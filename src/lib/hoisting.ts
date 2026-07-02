import { parse } from "acorn";

export type MemoryVar = {
  name: string;
  kind: "var" | "let" | "const" | "function";
  value: string; // "undefined" | "<TDZ>" | "<fn>" | actual literal
  note?: string;
};

export type MemoryStep = {
  phase: "creation" | "execution";
  line: number;
  title: string;
  explanation: string;
  memory: MemoryVar[]; // snapshot AFTER this step
};

function valueToString(node: any, source: string): string {
  if (!node) return "undefined";
  if (node.type === "Literal") return JSON.stringify(node.value);
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression")
    return "<fn>";
  if (node.type === "ObjectExpression") return "{…}";
  if (node.type === "ArrayExpression") return "[…]";
  // fallback to source snippet
  try {
    return source.slice(node.start, node.end).slice(0, 30);
  } catch {
    return "…";
  }
}

export function analyzeHoisting(source: string): MemoryStep[] {
  const steps: MemoryStep[] = [];
  let ast: any;
  try {
    ast = parse(source, { ecmaVersion: "latest", locations: true });
  } catch (err: any) {
    return [
      {
        phase: "creation",
        line: 0,
        title: "Parse error",
        explanation: err.message,
        memory: [],
      },
    ];
  }

  const memory: Record<string, MemoryVar> = {};
  const snapshot = (): MemoryVar[] => Object.values(memory).map((v) => ({ ...v }));

  // ---------- PHASE 1: CREATION (HOISTING) ----------
  steps.push({
    phase: "creation",
    line: 0,
    title: "🧠 Creation Phase begins",
    explanation:
      "Before any line runs, the JS engine scans the scope and allocates memory for every declaration. This is HOISTING.",
    memory: [],
  });

  // Pass A: function declarations (fully hoisted with their body)
  for (const node of ast.body) {
    if (node.type === "FunctionDeclaration" && node.id) {
      memory[node.id.name] = {
        name: node.id.name,
        kind: "function",
        value: "<fn>",
        note: "fully hoisted",
      };
      steps.push({
        phase: "creation",
        line: node.loc.start.line,
        title: `hoist function ${node.id.name}`,
        explanation: `Function declarations are hoisted ENTIRELY — name + body. You can call ${node.id.name}() before its line in the source.`,
        memory: snapshot(),
      });
    }
  }

  // Pass B: var declarations (hoisted as undefined)
  for (const node of ast.body) {
    if (node.type === "VariableDeclaration" && node.kind === "var") {
      for (const d of node.declarations) {
        if (d.id.type !== "Identifier") continue;
        memory[d.id.name] = {
          name: d.id.name,
          kind: "var",
          value: "undefined",
          note: "hoisted, initialized to undefined",
        };
        steps.push({
          phase: "creation",
          line: node.loc.start.line,
          title: `hoist var ${d.id.name}`,
          explanation: `\`var\` is hoisted and immediately initialized to \`undefined\`. Reading it before the assignment line gives \`undefined\` — no error.`,
          memory: snapshot(),
        });
      }
    }
  }

  // Pass C: let / const declarations (TDZ)
  for (const node of ast.body) {
    if (
      node.type === "VariableDeclaration" &&
      (node.kind === "let" || node.kind === "const")
    ) {
      for (const d of node.declarations) {
        if (d.id.type !== "Identifier") continue;
        memory[d.id.name] = {
          name: d.id.name,
          kind: node.kind,
          value: "<TDZ>",
          note: "Temporal Dead Zone — declared but unreachable",
        };
        steps.push({
          phase: "creation",
          line: node.loc.start.line,
          title: `hoist ${node.kind} ${d.id.name} (TDZ)`,
          explanation: `\`${node.kind}\` is hoisted too — but kept in the Temporal Dead Zone. Touching it before its line throws ReferenceError.`,
          memory: snapshot(),
        });
      }
    }
  }

  // ---------- PHASE 2: EXECUTION ----------
  steps.push({
    phase: "execution",
    line: 0,
    title: "▶ Execution Phase begins",
    explanation:
      "Now the engine walks the code top-to-bottom. Assignments update memory; function calls push a new Execution Context onto the Call Stack.",
    memory: snapshot(),
  });

  for (const node of ast.body) {
    const line = node.loc.start.line;

    if (node.type === "VariableDeclaration") {
      for (const d of node.declarations) {
        if (d.id.type !== "Identifier") continue;
        const name = d.id.name;
        const val = d.init ? valueToString(d.init, source) : "undefined";
        const prev = memory[name];
        memory[name] = {
          name,
          kind: node.kind,
          value: val,
          note:
            node.kind === "var"
              ? "assigned (was undefined)"
              : prev?.value === "<TDZ>"
                ? "left TDZ → initialized"
                : "re-assigned",
        };
        steps.push({
          phase: "execution",
          line,
          title: `${name} = ${val}`,
          explanation:
            node.kind === "var"
              ? `Engine writes ${val} into the slot it pre-created during hoisting.`
              : `\`${name}\` exits the TDZ and is initialized to ${val}.`,
          memory: snapshot(),
        });
      }
      continue;
    }

    if (node.type === "FunctionDeclaration") {
      steps.push({
        phase: "execution",
        line,
        title: `skip function declaration ${node.id?.name ?? ""}`,
        explanation: `Already hoisted in the creation phase — engine does nothing here at runtime.`,
        memory: snapshot(),
      });
      continue;
    }

    if (node.type === "ExpressionStatement") {
      const expr = node.expression;
      if (expr.type === "AssignmentExpression" && expr.left.type === "Identifier") {
        const name = expr.left.name;
        const val = valueToString(expr.right, source);
        if (memory[name]) {
          memory[name] = { ...memory[name], value: val, note: "re-assigned" };
        } else {
          memory[name] = {
            name,
            kind: "var",
            value: val,
            note: "implicit global (no declaration)",
          };
        }
        steps.push({
          phase: "execution",
          line,
          title: `${name} ${expr.operator} ${val}`,
          explanation: `Assignment updates the slot for \`${name}\` in memory.`,
          memory: snapshot(),
        });
        continue;
      }
      if (expr.type === "CallExpression") {
        const callee =
          expr.callee.type === "Identifier"
            ? expr.callee.name
            : source.slice(expr.callee.start, expr.callee.end);
        steps.push({
          phase: "execution",
          line,
          title: `call ${callee}()`,
          explanation: `A new Execution Context is created for \`${callee}\` and pushed on the Call Stack. When it returns, the context pops off.`,
          memory: snapshot(),
        });
        continue;
      }
    }

    steps.push({
      phase: "execution",
      line,
      title: `run line ${line}`,
      explanation: source.slice(node.start, node.end).split("\n")[0].slice(0, 80),
      memory: snapshot(),
    });
  }

  steps.push({
    phase: "execution",
    line: 0,
    title: "✓ Script finished",
    explanation: "Global Execution Context pops off the Call Stack. Done.",
    memory: snapshot(),
  });

  return steps;
}
