export type CommandToken = {
  value: string;
  start: number;
  end: number;
};

export function tokenizeCommand(input: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let i = 0;

  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i++;
    if (i >= input.length) break;

    const start = i;
    let value = "";
    let quote: "'" | '"' | null = null;

    while (i < input.length) {
      const ch = input[i];

      if (quote) {
        if (ch === quote) {
          quote = null;
          i++;
          continue;
        }
        if (ch === "\\" && quote === '"' && i + 1 < input.length) {
          value += input[i + 1];
          i += 2;
          continue;
        }
        value += ch;
        i++;
        continue;
      }

      if (/\s/.test(ch)) break;
      if (ch === "'" || ch === '"') {
        quote = ch;
        i++;
        continue;
      }
      if (ch === "\\" && i + 1 < input.length) {
        value += input[i + 1];
        i += 2;
        continue;
      }
      value += ch;
      i++;
    }

    tokens.push({ value, start, end: i });
  }

  return tokens;
}

export function singleCommandValue(input: string): string {
  const trimmed = input.trim();
  const tokens = tokenizeCommand(trimmed);
  if (tokens.length === 1 && tokens[0].start === 0 && tokens[0].end === trimmed.length) {
    return tokens[0].value;
  }
  return trimmed;
}

export function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["0", "false", "off", "no"].includes(value.toLowerCase());
}

export function parsePositiveInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
