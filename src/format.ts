// Penelope source formatter.
// AST-based: parse + re-print. Idempotent (format(format(x)) === format(x)).
// Comments are dropped (AST doesn't preserve them).

import type { ASTNode, ASTBundle, NodeId } from './ast.js';

export type FormatOpts = {
  indent?: string;          // default '  '
};

export function format(ast: ASTBundle, opts: FormatOpts = {}): string {
  const indent = opts.indent ?? '  ';
  const ctx: FormatCtx = { ast, indent, depth: 0 };
  return formatNode(ast.nodes[ast.rootId], ctx);
}

type FormatCtx = {
  ast: ASTBundle;
  indent: string;
  depth: number;
};

function pad(ctx: FormatCtx): string {
  return ctx.indent.repeat(ctx.depth);
}

function formatNode(node: ASTNode, ctx: FormatCtx): string {
  switch (node.kind) {
    case 'Program':
      return node.stmtIds.map(id => pad(ctx) + formatNode(ctx.ast.nodes[id], ctx)).join('\n') + (node.stmtIds.length ? '\n' : '');
    case 'IntLit':    return String(node.value);
    case 'BoolLit':   return node.value ? 'true' : 'false';
    case 'StringLit': return JSON.stringify(node.value);
    case 'Pause':     return 'pause';
    case 'Var':       return node.name;
    case 'ExprStmt':  return formatNode(ctx.ast.nodes[node.exprId], ctx) + ';';
    case 'Let':       return `let ${node.name} = ${formatNode(ctx.ast.nodes[node.valueId], ctx)};`;
    case 'BinOp': {
      const l = formatNode(ctx.ast.nodes[node.leftId], ctx);
      const r = formatNode(ctx.ast.nodes[node.rightId], ctx);
      return `${parenIfBinOp(l, ctx.ast.nodes[node.leftId])} ${node.op} ${parenIfBinOp(r, ctx.ast.nodes[node.rightId])}`;
    }
    case 'If': {
      const cond = formatNode(ctx.ast.nodes[node.condId], ctx);
      const then = formatBlock(node.thenBlockId, ctx);
      const elseB = formatBlock(node.elseBlockId, ctx);
      return `if (${cond}) ${then} else ${elseB}`;
    }
    case 'Fn': {
      const body = formatBlock(node.bodyBlockId, ctx);
      return `fn(${node.params.join(', ')}) ${body}`;
    }
    case 'Call': {
      const callee = formatNode(ctx.ast.nodes[node.calleeId], ctx);
      const args = node.argIds.map(id => formatNode(ctx.ast.nodes[id], ctx)).join(', ');
      return `${callee}(${args})`;
    }
    case 'Block':
      return formatBlock(node.id as NodeId, ctx);
    default: {
      const n = node as ASTNode;
      throw new Error(`format: unhandled node kind ${n.kind}`);
    }
  }
}

function formatBlock(id: NodeId, ctx: FormatCtx): string {
  const blk = ctx.ast.nodes[id];
  if (blk.kind !== 'Block') throw new Error(`formatBlock: not a Block`);
  if (blk.stmtIds.length === 0 && blk.trailingExprId === null) return `{}`;
  // Single trailing expr, no stmts → keep on one line
  if (blk.stmtIds.length === 0 && blk.trailingExprId !== null) {
    const e = formatNode(ctx.ast.nodes[blk.trailingExprId], ctx);
    return `{ ${e} }`;
  }
  const inner: FormatCtx = { ...ctx, depth: ctx.depth + 1 };
  const innerPad = pad(inner);
  const lines: string[] = [];
  for (const sid of blk.stmtIds) {
    lines.push(innerPad + formatNode(ctx.ast.nodes[sid], inner));
  }
  if (blk.trailingExprId !== null) {
    lines.push(innerPad + formatNode(ctx.ast.nodes[blk.trailingExprId], inner));
  }
  return `{\n${lines.join('\n')}\n${pad(ctx)}}`;
}

// Add parens around a child BinOp if needed for unambiguous round-trip.
// Conservative: parenthesize all child BinOps. Idempotent but slightly noisy.
function parenIfBinOp(text: string, node: ASTNode): string {
  if (node.kind === 'BinOp') return `(${text})`;
  return text;
}
