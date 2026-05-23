// Penelope lexer.
// `tokenize(source: string)` returns an array of tokens terminated by EOF.

export type TokenKind =
  // literals
  | 'INT' | 'IDENT'
  // keywords
  | 'LET' | 'FN' | 'IF' | 'ELSE' | 'TRUE' | 'FALSE' | 'PAUSE' | 'PRINT'
  // operators
  | 'PLUS' | 'MINUS' | 'STAR' | 'SLASH'
  | 'LT' | 'GT' | 'LE' | 'GE' | 'EQ_EQ' | 'BANG_EQ'
  | 'EQ'
  // punctuation
  | 'LPAREN' | 'RPAREN' | 'LBRACE' | 'RBRACE' | 'COMMA' | 'SEMI'
  // sentinel
  | 'EOF';

export type Token = {
  kind: TokenKind;
  line: number;
  col: number;
  text?: string;     // for IDENT
  value?: number;    // for INT
};

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  void i; // will be used in Task 3

  // (we will fill this in across the next few tasks)

  tokens.push({ kind: 'EOF', line, col });
  return tokens;
}
