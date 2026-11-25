/**
 * AST / Token 的可读格式化输出，支撑 `lemon ast` 与 `lemon tokens` 调试子命令。
 */
import type { Expr, FileReadStmt, FileSaveStmt, Program, Stmt, WebElement } from './ast';
import { Token } from './token';

/* ------------------------------------------------------------------ */
/* AST 树形打印                                                        */
/* ------------------------------------------------------------------ */

export function formatAst(program: Program): string {
  const lines: string[] = ['Program', '└─ __init__'];
  program.statements.forEach((stmt, index) => {
    const last = index === program.statements.length - 1;
    printStmt(stmt, '   ', last, lines);
  });
  return lines.join('\n');
}

export function formatStatements(statements: Stmt[]): string {
  const lines: string[] = ['<片段>'];
  statements.forEach((stmt, index) => printStmt(stmt, ' ', index === statements.length - 1, lines));
  return lines.join('\n');
}

function printStmt(stmt: Stmt, prefix: string, last: boolean, lines: string[]): void {
  const branch = last ? '└─ ' : '├─ ';
  const next = prefix + (last ? '   ' : '│  ');

  switch (stmt.kind) {
    case 'VarDecl': {
      const declared = stmt.className ?? stmt.typeName;
      lines.push(`${prefix}${branch}VarDecl ${declared} ${stmt.name}`);
      printExpr(stmt.initializer, next, true, lines);
      return;
    }
    case 'ListDecl': {
      const count = stmt.elements.length;
      const label = stmt.slot === null ? stmt.name : `编号 ${stmt.slot}`;
      lines.push(`${prefix}${branch}ListDecl ${label}  (${count} 个元素)`);
      stmt.elements.forEach((element, index) =>
        printExpr(element, next, index === stmt.elements.length - 1, lines),
      );
      return;
    }
    case 'ListOp': {
      const label = stmt.target.slot === null ? stmt.target.name : String(stmt.target.slot);
      lines.push(`${prefix}${branch}ListOp ${stmt.op} list(${label})`);
      if (stmt.element !== null) printExpr(stmt.element, next, true, lines);
      return;
    }
    case 'FuncDecl': {
      const label = stmt.isMain ? 'FuncDecl main()' : `FuncDecl ${stmt.name}(${stmt.params.map((p) => p.name).join(', ')})`;
      lines.push(`${prefix}${branch}${label}`);
      stmt.body.forEach((inner, index) => printStmt(inner, next, index === stmt.body.length - 1, lines));
      return;
    }
    case 'ExprStmt': {
      lines.push(`${prefix}${branch}ExprStmt`);
      printExpr(stmt.expr, next, true, lines);
      return;
    }
    case 'TryStmt': {
      lines.push(`${prefix}${branch}TryStmt`);
      lines.push(`${next}├─ try`);
      stmt.body.forEach((inner, index) => printStmt(inner, `${next}│  `, index === stmt.body.length - 1, lines));
      lines.push(`${next}└─ catch (${stmt.catchName})`);
      stmt.catchBody.forEach((inner, index) =>
        printStmt(inner, `${next}   `, index === stmt.catchBody.length - 1, lines),
      );
      return;
    }
    case 'CycleStmt': {
      const head = stmt.count === null ? 'cycle()  无限循环，i 递增' : 'cycle(N)  重复 N 次，i 从 0 开始';
      lines.push(`${prefix}${branch}CycleStmt ${head}`);
      if (stmt.count !== null) printExpr(stmt.count, next, stmt.body.length === 0, lines);
      stmt.body.forEach((inner, index) => printStmt(inner, next, index === stmt.body.length - 1, lines));
      return;
    }
    case 'BreakStmt':
      lines.push(`${prefix}${branch}BreakStmt break`);
      return;
    case 'ReturnStmt': {
      lines.push(`${prefix}${branch}ReturnStmt`);
      if (stmt.value === null) {
        lines.push(`${next}└─ （不带值）`);
        return;
      }
      printExpr(stmt.value, next, true, lines);
      return;
    }
    case 'IfStmt': {
      lines.push(`${prefix}${branch}IfStmt`);
      stmt.branches.forEach((br, index) => {
        const lastBranch = index === stmt.branches.length - 1;
        const branchMark = lastBranch ? '└─ ' : '├─ ';
        const branchNext = next + (lastBranch ? '   ' : '│  ');
        lines.push(`${next}${branchMark}${br.kind}`);
        if (br.condition !== null) {
          // 条件作为该分支的第一个孩子，与 body 并列展示
          printExpr(br.condition, branchNext, false, lines);
        }
        br.body.forEach((inner, i) => printStmt(inner, branchNext, i === br.body.length - 1, lines));
      });
      return;
    }
    case 'WebSets': {
      lines.push(`${prefix}${branch}WebSets websets()`);
      if (stmt.init === null) return;
      lines.push(`${next}└─ web.init()`);
      printWebElements(stmt.init.elements, `${next}   `, lines);
      return;
    }
    case 'Game': {
      lines.push(`${prefix}${branch}Game game()`);
      if (stmt.init === null) return;
      lines.push(`${next}└─ game.init()`);
      const elements = stmt.init.elements;
      const elementPrefix = `${next}   `;
      elements.forEach((el, index) => {
        const lastElement = index === elements.length - 1;
        const elementMark = lastElement ? '└─ ' : '├─ ';
        const elementNext = elementPrefix + (lastElement ? '   ' : '│  ');
        if (el.kind === 'DisplayWin') {
          lines.push(`${elementPrefix}${elementMark}display.win`);
          printExpr(el.width, `${elementNext}├─ `, false, lines);
          printExpr(el.height, `${elementNext}└─ `, true, lines);
        } else {
          lines.push(`${elementPrefix}${elementMark}display.head`);
          printExpr(el.title, `${elementNext}└─ `, true, lines);
        }
      });
      return;
    }
    case 'BuildExe': {
      lines.push(`${prefix}${branch}BuildExe`);
      printExpr(stmt.filename, next, true, lines);
      return;
    }
    case 'Assign': {
      lines.push(`${prefix}${branch}Assign ${stmt.target.name}.${stmt.property} =`);
      printExpr(stmt.value, next, true, lines);
      return;
    }
    case 'Output': {
      lines.push(`${prefix}${branch}Output`);
      printExpr(stmt.value, next, true, lines);
      return;
    }
    case 'Cd': {
      lines.push(`${prefix}${branch}Cd  cd "目录"`);
      printExpr(stmt.path, next, stmt.body.length === 0, lines);
      stmt.body.forEach((inner, index) => printStmt(inner, next, index === stmt.body.length - 1, lines));
      return;
    }
    case 'Running': {
      lines.push(`${prefix}${branch}Running`);
      printExpr(stmt.file, next, true, lines);
      return;
    }
    case 'Delete': {
      lines.push(`${prefix}${branch}Delete`);
      printExpr(stmt.file, next, true, lines);
      return;
    }
    case 'Class': {
      lines.push(`${prefix}${branch}Class ${stmt.name}`);
      for (const field of stmt.fields) {
        lines.push(`${next}├─ ${field.typeName} ${field.name}`);
      }
      for (const method of stmt.methods) {
        lines.push(`${next}├─ def ${method.name}(${method.params.map((p) => p.name).join(', ')})`);
      }
      return;
    }
    case 'FileRead': {
      const name = stmt.name === null ? '（缺 name）' : '<文件名>';
      lines.push(`${prefix}${branch}FileRead name=${name} 编码=${stmt.encoding === null ? 'utf-8' : '<自定义>'} 交互式=${stmt.interactive ? '是' : '否'}`);
      stmt.targets.forEach((target, index) => {
        const lastTarget = index === stmt.targets.length - 1;
        const mark = lastTarget ? '└─ ' : '├─ ';
        const label = target.kind === 'say' ? 'say' : `list(${target.ref.slot ?? target.ref.name})`;
        lines.push(`${next}${mark}read in ${label}`);
      });
      return;
    }
    case 'FileSave': {
      const name = stmt.name === null ? '（缺 name）' : '<文件名>';
      const src = stmt.source === null ? '（缺源）' : `list(${stmt.source.slot ?? stmt.source.name})`;
      lines.push(`${prefix}${branch}FileSave name=${name} 编码=${stmt.encoding === null ? 'utf-8' : '<自定义>'} 源=${src}`);
      return;
    }
    default:
      lines.push(`${prefix}${branch}?`);
  }
}

/** websets 元素（button / div / text）的树形打印 */
function printWebElements(elements: WebElement[], prefix: string, lines: string[]): void {
  elements.forEach((element, index) => {
    const last = index === elements.length - 1;
    const branch = last ? '└─ ' : '├─ ';
    const next = prefix + (last ? '   ' : '│  ');

    switch (element.kind) {
      case 'WebButton': {
        lines.push(`${prefix}${branch}button`);
        if (element.to !== null) {
          lines.push(`${next}└─ to`);
          printExpr(element.to.target, `${next}   `, true, lines);
        }
        return;
      }
      case 'WebText': {
        lines.push(`${prefix}${branch}text`);
        printExpr(element.value, `${next}└─ `, true, lines);
        return;
      }
      case 'WebDiv': {
        lines.push(`${prefix}${branch}div`);
        if (element.box !== null) {
          lines.push(`${next}├─ in`);
          printExpr(element.box.left, `${next}│  ├─ `, false, lines);
          printExpr(element.box.top, `${next}│  ├─ `, false, lines);
          printExpr(element.box.right, `${next}│  ├─ `, false, lines);
          printExpr(element.box.bottom, `${next}│  └─ `, true, lines);
        }
        if (element.color !== null) {
          lines.push(`${next}├─ color`);
          printExpr(element.color, `${next}│  └─ `, true, lines);
        }
        if (element.children.length > 0) {
          lines.push(`${next}└─ children`);
          printWebElements(element.children, `${next}   `, lines);
        }
        return;
      }
    }
  });
}

function printExpr(expr: Expr, prefix: string, last: boolean, lines: string[]): void {
  const branch = last ? '└─ ' : '├─ ';
  const next = prefix + (last ? '   ' : '│  ');

  switch (expr.kind) {
    case 'IntLit':
      lines.push(`${prefix}${branch}IntLit ${expr.raw}`);
      return;
    case 'DoubleLit':
      lines.push(`${prefix}${branch}DoubleLit ${expr.raw}`);
      return;
    case 'TextLit':
      lines.push(`${prefix}${branch}TextLit ${expr.bare ? '(裸文本) ' : ''}"${expr.value}"`);
      return;
    case 'BoolLit':
      lines.push(`${prefix}${branch}BoolLit ${expr.raw}`);
      return;
    case 'Ident': {
      // 静态检查后 AST 节点上带有解析结果，据此标注这个名字的最终身份
      const tag =
        expr.resolution === undefined
          ? ''
          : expr.resolution.kind === 'bareText'
            ? '  (裸文本)'
            : expr.resolution.kind === 'builtin'
              ? '  (内置函数)'
              : expr.resolution.kind === 'function'
                ? '  (函数)'
                : '  (变量)';
      lines.push(`${prefix}${branch}Ident ${expr.name}${tag}`);
      return;
    }
    case 'Call': {
      lines.push(`${prefix}${branch}Call → ${expr.callee.name}`);
      expr.args.forEach((arg, index) => printExpr(arg, next, index === expr.args.length - 1, lines));
      return;
    }
    case 'Binary': {
      lines.push(`${prefix}${branch}Binary '${expr.op}'`);
      printExpr(expr.left, next, false, lines);
      printExpr(expr.right, next, true, lines);
      return;
    }
    case 'Unary': {
      lines.push(`${prefix}${branch}Unary '${expr.op}'`);
      printExpr(expr.operand, next, true, lines);
      return;
    }
    case 'Member': {
      lines.push(`${prefix}${branch}Member .${expr.property}`);
      printExpr(expr.object, next, true, lines);
      return;
    }
    case 'MethodCall': {
      lines.push(`${prefix}${branch}MethodCall .${expr.method}()`);
      printExpr(expr.object, next, expr.args.length === 0, lines);
      expr.args.forEach((arg, index) => printExpr(arg, next, index === expr.args.length - 1, lines));
      return;
    }
    case 'Index': {
      lines.push(`${prefix}${branch}Index []`);
      printExpr(expr.object, next, false, lines);
      printExpr(expr.index, next, true, lines);
      return;
    }
    case 'ListRef': {
      const label = expr.slot === null ? `名字 ${expr.name}` : `编号 ${expr.slot}`;
      lines.push(`${prefix}${branch}ListRef list(${label})`);
      return;
    }
    default:
      lines.push(`${prefix}${branch}?`);
  }
}

/* ------------------------------------------------------------------ */
/* Token 表                                                            */
/* ------------------------------------------------------------------ */

export function formatTokens(tokens: Token[]): string {
  const rows = tokens.map((t) => ({
    pos: `${t.span.line}:${t.span.col}`,
    kind: t.kind,
    lexeme: t.lexeme === '' ? '<EOF>' : t.lexeme.replace(/\n/g, '\\n'),
  }));
  const posWidth = Math.max(4, ...rows.map((r) => r.pos.length));
  const kindWidth = Math.max(6, ...rows.map((r) => r.kind.length));
  return rows
    .map((r) => `${r.pos.padEnd(posWidth)}  ${r.kind.padEnd(kindWidth)}  ${r.lexeme}`)
    .join('\n');
}
