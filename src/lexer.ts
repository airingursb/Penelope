// Penelope lexer.
// `tokenize(source: string)` returns an array of tokens terminated by EOF.

export type TokenKind =
  | 'INT' | 'IDENT' | 'STRING' | 'TEMPLATE_STRING'
  | 'LET' | 'FN' | 'IF' | 'ELSE' | 'TRUE' | 'FALSE' | 'PAUSE' | 'PRINT' | 'MATCH' | 'IMPORT'
  | 'PLUS' | 'MINUS' | 'STAR' | 'SLASH'
  | 'LT' | 'GT' | 'LE' | 'GE' | 'EQ_EQ' | 'BANG_EQ'
  | 'EQ' | 'FAT_ARROW'
  | 'LPAREN' | 'RPAREN' | 'LBRACE' | 'RBRACE' | 'LBRACK' | 'RBRACK' | 'COMMA' | 'SEMI' | 'COLON' | 'PIPE' | 'DOTDOTDOT'
  | 'EOF';

export type TemplatePart = { kind: 'text'; value: string } | { kind: 'expr'; source: string };

export type Token = {
  kind: TokenKind;
  line: number;
  col: number;
  text?: string;
  value?: number;
  parts?: TemplatePart[];   // For TEMPLATE_STRING — interleaved literal / expression
};

const KEYWORDS: Record<string, TokenKind> = {
  let:    'LET',
  fn:     'FN',
  if:     'IF',
  else:   'ELSE',
  true:   'TRUE',
  false:  'FALSE',
  pause:  'PAUSE',
  match:  'MATCH',
  import: 'IMPORT',
};

function isDigit(c: string): boolean { return c >= '0' && c <= '9'; }
function isAlpha(c: string): boolean { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'; }
function isAlphaNum(c: string): boolean { return isAlpha(c) || isDigit(c); }
function isHexDigit(c: string): boolean { return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }

// Comment captured during tokenization. `text` excludes the leading `//` (or `///`).
// `doc` is true if the original prefix was `///`.
export type Comment = { line: number; col: number; text: string; doc: boolean };

export function tokenize(source: string): Token[] {
  return tokenizeWithComments(source).tokens;
}

export function tokenizeWithComments(source: string): { tokens: Token[]; comments: Comment[] } {
  const tokens: Token[] = [];
  const comments: Comment[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (): string => {
    const c = source[i++];
    if (c === '\n') { line++; col = 1; } else { col++; }
    return c;
  };

  while (i < source.length) {
    const c = source[i];
    const startLine = line;
    const startCol = col;

    // whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      advance();
      continue;
    }

    // block comment /* ... */ (non-nested)
    if (c === '/' && source[i + 1] === '*') {
      advance(); advance();   // consume /*
      let text = '';
      while (i + 1 < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        text += advance();
      }
      if (i + 1 >= source.length) {
        throw new Error(`lexer: unterminated block comment at line ${startLine} col ${startCol}`);
      }
      advance(); advance();   // consume */
      comments.push({ line: startLine, col: startCol, text, doc: false });
      continue;
    }

    // line comment (incl. /// doc comments)
    if (c === '/' && source[i + 1] === '/') {
      // Consume slashes
      advance(); advance();
      let doc = false;
      if (source[i] === '/') { advance(); doc = true; }
      // Skip a single leading space, conventional
      if (source[i] === ' ') advance();
      let text = '';
      while (i < source.length && source[i] !== '\n') text += advance();
      comments.push({ line: startLine, col: startCol, text, doc });
      continue;
    }

    // string literal — may contain ${...} interpolation
    if (c === '"') {
      advance();  // consume opening quote
      const parts: TemplatePart[] = [];
      let current = '';
      let hasInterp = false;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          advance();
          if (i >= source.length) throw new Error(`lexer: unterminated string at line ${startLine} col ${startCol}`);
          const esc = source[i];
          if (esc === 'n')       current += '\n';
          else if (esc === '\\') current += '\\';
          else if (esc === '"')  current += '"';
          else if (esc === '$')  current += '$';
          else throw new Error(`lexer: unknown escape '\\${esc}' at line ${line} col ${col}`);
          advance();
          continue;
        }
        if (source[i] === '$' && source[i + 1] === '{') {
          hasInterp = true;
          parts.push({ kind: 'text', value: current });
          current = '';
          advance(); advance();   // consume ${
          // Capture until matching } (track brace depth)
          let depth = 1;
          let exprSrc = '';
          while (i < source.length && depth > 0) {
            const ch = source[i];
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) break; }
            exprSrc += advance();
          }
          if (i >= source.length) throw new Error(`lexer: unterminated \${...} in string at line ${startLine} col ${startCol}`);
          advance();   // consume closing }
          parts.push({ kind: 'expr', source: exprSrc });
          continue;
        }
        current += advance();
      }
      if (i >= source.length) {
        throw new Error(`lexer: unterminated string at line ${startLine} col ${startCol}`);
      }
      advance();  // consume closing quote
      if (hasInterp) {
        parts.push({ kind: 'text', value: current });
        tokens.push({ kind: 'TEMPLATE_STRING', line: startLine, col: startCol, parts });
      } else {
        tokens.push({ kind: 'STRING', line: startLine, col: startCol, text: current });
      }
      continue;
    }

    // integer literal — decimal, hex (0xFF), binary (0b101); underscores allowed as separators
    if (isDigit(c)) {
      let text = '';
      let value: number;
      if (c === '0' && (source[i + 1] === 'x' || source[i + 1] === 'X')) {
        advance(); advance();  // consume 0x
        while (i < source.length && (isHexDigit(source[i]) || source[i] === '_')) text += advance();
        if (text.replace(/_/g, '') === '') throw new Error(`lexer: empty hex literal at line ${startLine} col ${startCol}`);
        value = parseInt(text.replace(/_/g, ''), 16);
      } else if (c === '0' && (source[i + 1] === 'b' || source[i + 1] === 'B')) {
        advance(); advance();  // consume 0b
        while (i < source.length && (source[i] === '0' || source[i] === '1' || source[i] === '_')) text += advance();
        if (text.replace(/_/g, '') === '') throw new Error(`lexer: empty binary literal at line ${startLine} col ${startCol}`);
        value = parseInt(text.replace(/_/g, ''), 2);
      } else {
        while (i < source.length && (isDigit(source[i]) || source[i] === '_')) text += advance();
        value = Number(text.replace(/_/g, ''));
      }
      tokens.push({ kind: 'INT', line: startLine, col: startCol, value });
      continue;
    }

    // identifier or keyword
    if (isAlpha(c)) {
      let text = '';
      while (i < source.length && isAlphaNum(source[i])) text += advance();
      const kw = KEYWORDS[text];
      if (kw) {
        tokens.push({ kind: kw, line: startLine, col: startCol });
      } else {
        tokens.push({ kind: 'IDENT', line: startLine, col: startCol, text });
      }
      continue;
    }

    // two-char operators (peek ahead)
    if (i + 1 < source.length) {
      const two = source[i] + source[i + 1];
      const twoChar: Record<string, TokenKind> = {
        '<=': 'LE', '>=': 'GE', '==': 'EQ_EQ', '!=': 'BANG_EQ', '=>': 'FAT_ARROW',
      };
      if (twoChar[two]) {
        advance(); advance();
        tokens.push({ kind: twoChar[two], line: startLine, col: startCol });
        continue;
      }
    }

    // three-char operators
    if (i + 2 < source.length && source[i] === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      advance(); advance(); advance();
      tokens.push({ kind: 'DOTDOTDOT', line: startLine, col: startCol });
      continue;
    }

    // single-char operators and punctuation
    const oneChar: Record<string, TokenKind> = {
      '+': 'PLUS', '-': 'MINUS', '*': 'STAR', '/': 'SLASH',
      '<': 'LT', '>': 'GT', '=': 'EQ',
      '(': 'LPAREN', ')': 'RPAREN', '{': 'LBRACE', '}': 'RBRACE',
      '[': 'LBRACK', ']': 'RBRACK',
      ',': 'COMMA', ';': 'SEMI', ':': 'COLON', '|': 'PIPE',
    };
    if (oneChar[c]) {
      advance();
      tokens.push({ kind: oneChar[c], line: startLine, col: startCol });
      continue;
    }

    throw new Error(`lexer: unexpected character '${c}' at line ${line} col ${col}`);
  }

  tokens.push({ kind: 'EOF', line, col });
  return { tokens, comments };
}
