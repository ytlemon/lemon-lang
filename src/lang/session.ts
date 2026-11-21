/**
 * REPL 会话：跨行保持环境与符号表，支持 def 累积与裸表达式回显。
 */
import type { SourceFile } from '../utils/source';
import type { FuncDecl, Stmt } from './ast';
import { checkFragment, type CheckOptions, type SymbolInfo } from './checker';
import { displayValue } from './value';
import { Env } from './env';
import { ErrorCodes, LemonError, type Diagnostic } from './errors';
import { Evaluator } from './eval';
import { parseStatements } from './parser';

export interface SessionOptions {
  write(text: string): void;
  check?: CheckOptions;
}

export interface SessionResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  error: LemonError | null;
}

export class Session {
  readonly env: Env = new Env();
  private readonly symbols = new Map<string, SymbolInfo>();
  private readonly write: (text: string) => void;
  private readonly checkOptions: CheckOptions;

  constructor(options: SessionOptions) {
    this.write = options.write;
    this.checkOptions = { ...options.check, allowBareExpr: true, allowRedeclare: true };
  }

  symbolNames(): string[] {
    return [...this.symbols.keys()].sort();
  }

  symbolInfo(name: string): SymbolInfo | undefined {
    return this.symbols.get(name);
  }

  /** 执行一段语句片段 */
  execute(source: SourceFile): SessionResult {
    let statements: Stmt[];
    try {
      statements = parseStatements(source);
    } catch (error) {
      return this.failure(error);
    }

    if (statements.length === 0) {
      return { ok: true, diagnostics: [], error: null };
    }

    const check = checkFragment(statements, this.symbols, this.checkOptions);
    if (check.hasErrors) {
      return { ok: false, diagnostics: check.diagnostics, error: null };
    }
    for (const [name, sym] of check.globals) this.symbols.set(name, sym);

    const evaluator = new Evaluator({ write: this.write });
    const functions = statements.filter((s): s is FuncDecl => s.kind === 'FuncDecl');
    evaluator.defineFunctions(functions, this.env);

    try {
      for (const stmt of statements) {
        if (stmt.kind === 'FuncDecl') continue;
        const value = evaluator.execStatement(stmt, this.env);
        // 裸表达式（非调用）在 REPL 中回显结果，方便随手试值
        if (value !== null && stmt.kind === 'ExprStmt' && stmt.expr.kind !== 'Call') {
          this.write(`${displayValue(value)}\n`);
        }
      }
    } catch (error) {
      return this.failure(error);
    }

    return { ok: true, diagnostics: check.diagnostics, error: null };
  }

  private failure(error: unknown): SessionResult {
    if (error instanceof LemonError) {
      return { ok: false, diagnostics: [error.toDiagnostic()], error };
    }
    const wrapped = new LemonError({
      code: ErrorCodes.UNCAUGHT,
      phase: 'runtime',
      message: error instanceof Error ? error.message : String(error),
      span: { line: 1, col: 1, endLine: 1, endCol: 1, start: 0, end: 0 },
    });
    return { ok: false, diagnostics: [wrapped.toDiagnostic()], error: wrapped };
  }
}
