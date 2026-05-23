// Penelope lexer.
// `tokenize(source: string)` returns an array of tokens terminated by EOF.

export type TokenKind =
  | 'INT' | 'IDENT' | 'STRING'
  | 'LET' | 'FN' | 'IF' | 'ELSE' | 'TRUE' | 'FALSE' | 'PAUSE' | 'PRINT'
  | 'PLUS' | 'MINUS' | 'STAR' | 'SLASH'
  | 'LT' | 'GT' | 'LE' | 'GE' | 'EQ_EQ' | 'BANG_EQ'
  | 'EQ'
  | 'LPAREN' | 'RPAREN' | 'LBRACE' | 'RBRACE' | 'COMMA' | 'SEMI'
  | 'EOF';

export type Token = {
  kind: TokenKind;
  line: number;
  col: number;
  text?: string;
  value?: number;
};

const KEYWORDS: Record<string, TokenKind> = {
  let:    'LET',
  fn:     'FN',
  if:     'IF',
  else:   'ELSE',
  true:   'TRUE',
  false:  'FALSE',
  pause:  'PAUSE',
};

function isDigit(c: string): boolean { return c >= '0' && c <= '9'; }
function isAlpha(c: string): boolean { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'; }
function isAlphaNum(c: string): boolean { return isAlpha(c) || isDigit(c); }

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

    // string literal
    if (c === '"') {
      advance();  // consume opening quote
      let text = '';
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          advance();  // consume backslash
          if (i >= source.length) {
            throw new Error(`lexer: unterminated string at line ${startLine} col ${startCol}`);
          }
          const esc = source[i];
          if (esc === 'n')       text += '\n';
          else if (esc === '\\') text += '\\';
          else if (esc === '"')  text += '"';
          else throw new Error(`lexer: unknown escape '\\${esc}' at line ${line} col ${col}`);
          advance();
        } else {
          text += advance();
        }
      }
      if (i >= source.length) {
        throw new Error(`lexer: unterminated string at line ${startLine} col ${startCol}`);
      }
      advance();  // consume closing quote
      tokens.push({ kind: 'STRING', line: startLine, col: startCol, text });
      continue;
    }

    // integer literal
    if (isDigit(c)) {
      let text = '';
      while (i < source.length && isDigit(source[i])) text += advance();
      tokens.push({ kind: 'INT', line: startLine, col: startCol, value: Number(text) });
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
        '<=': 'LE', '>=': 'GE', '==': 'EQ_EQ', '!=': 'BANG_EQ',
      };
      if (twoChar[two]) {
        advance(); advance();
        tokens.push({ kind: twoChar[two], line: startLine, col: startCol });
        continue;
      }
    }

    // single-char operators and punctuation
    const oneChar: Record<string, TokenKind> = {
      '+': 'PLUS', '-': 'MINUS', '*': 'STAR', '/': 'SLASH',
      '<': 'LT', '>': 'GT', '=': 'EQ',
      '(': 'LPAREN', ')': 'RPAREN', '{': 'LBRACE', '}': 'RBRACE',
      ',': 'COMMA', ';': 'SEMI',
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
