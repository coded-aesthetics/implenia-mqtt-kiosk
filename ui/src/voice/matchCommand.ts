import { elementNameVariants } from './elementNameVariants';

export interface VoiceCommand {
  id: string;
  phrases: string[];
  precondition: (ctx: VoiceContext) => boolean;
  preconditionHint?: string;
  execute: (ctx: VoiceContext, params: Record<string, string>) => void | Promise<void>;
  description: string;
}

export interface VoiceContext {
  route: { page: 'home' | 'config' | 'element'; params: Record<string, string> };
  recordingState: {
    active: boolean;
    sessionId: number | null;
    elementName: string | null;
    readingCount: number;
  };
  elementNames: string[];
  setActiveTab: (tab: 'messwerte' | 'vorgabe') => void;
  navigate: (path: string) => void;
}

export interface MatchResult {
  command: VoiceCommand;
  params: Record<string, string>;
  score: number;
  matchedPhrase: string;
}

interface ExpandedPhrase {
  command: VoiceCommand;
  phrase: string;
  tokens: string[];
  params: Record<string, string>;
}

const FILLER_WORDS = new Set([
  'bitte', 'mal', 'ähm', 'äh', 'hmm', 'also', 'jetzt', 'dann', 'noch',
  'kannst', 'du', 'könntest', 'mir', 'das', 'die', 'der', 'den', 'dem',
  'ein', 'eine', 'einen', 'auf', 'an', 'zum',
]);

function normalize(text: string): string {
  return text.toLowerCase().trim().replace(/[.,!?;:]+/g, '');
}

function tokenize(text: string): string[] {
  return text.split(/\s+/).filter((t) => t.length > 0);
}

function stripFillers(tokens: string[]): string[] {
  const stripped = tokens.filter((t) => !FILLER_WORDS.has(t));
  return stripped.length > 0 ? stripped : tokens;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[m][n];
}

function tokenMatchScore(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length <= 2 || b.length <= 2) return 0;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (dist <= 1 && maxLen >= 4) return 0.8;
  if (dist <= 2 && maxLen >= 7) return 0.6;
  return 0;
}

function scoreMatch(transcriptTokens: string[], phraseTokens: string[]): number {
  if (transcriptTokens.length === 0 || phraseTokens.length === 0) return 0;

  // Exact full match
  if (transcriptTokens.join(' ') === phraseTokens.join(' ')) return 1.0;

  // Count matched phrase tokens (each phrase token tries to find best match in transcript)
  let matchedScore = 0;
  const usedTranscript = new Set<number>();

  for (const pToken of phraseTokens) {
    let bestScore = 0;
    let bestIdx = -1;
    for (let i = 0; i < transcriptTokens.length; i++) {
      if (usedTranscript.has(i)) continue;
      const s = tokenMatchScore(transcriptTokens[i], pToken);
      if (s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestScore > 0) {
      usedTranscript.add(bestIdx);
      matchedScore += bestScore;
    }
  }

  // Jaccard-style: matched / total unique tokens
  const totalUnique = new Set([...transcriptTokens, ...phraseTokens]).size;
  const score = (matchedScore / totalUnique) * 0.85;

  return Math.min(score, 0.95);
}

export function expandCommands(
  commands: VoiceCommand[],
  elementNames: string[],
): ExpandedPhrase[] {
  const expanded: ExpandedPhrase[] = [];

  // Build variant-to-original mapping for element names
  const elementVariants: { variant: string; original: string }[] = [];
  for (const name of elementNames) {
    for (const variant of elementNameVariants(name)) {
      elementVariants.push({ variant, original: name });
    }
  }

  for (const cmd of commands) {
    for (const phrase of cmd.phrases) {
      if (phrase.includes('{element}')) {
        for (const el of elementVariants) {
          const concrete = phrase.replace('{element}', el.variant);
          expanded.push({
            command: cmd,
            phrase: concrete,
            tokens: tokenize(concrete),
            params: { element: el.original },
          });
        }
      } else {
        expanded.push({
          command: cmd,
          phrase,
          tokens: tokenize(phrase),
          params: {},
        });
      }
    }
  }

  return expanded;
}

export function matchCommand(
  transcript: string,
  expanded: ExpandedPhrase[],
  ctx: VoiceContext,
): MatchResult | null {
  const normalized = normalize(transcript);
  const rawTokens = tokenize(normalized);
  const tokens = stripFillers(rawTokens);
  const stripped = tokens.join(' ');

  // Try exact match first (Vosk grammar returns known phrases)
  // Check both raw normalized and filler-stripped versions
  for (const entry of expanded) {
    if (normalized === entry.phrase || stripped === entry.phrase) {
      if (!entry.command.precondition(ctx)) return null;
      return { command: entry.command, params: entry.params, score: 1.0, matchedPhrase: entry.phrase };
    }
  }

  let best: { entry: ExpandedPhrase; score: number } | null = null;

  for (const entry of expanded) {
    const score = scoreMatch(tokens, entry.tokens);
    if (score >= 0.5 && (!best || score > best.score)) {
      best = { entry, score };
    }
  }

  if (!best) return null;

  // Check precondition
  if (!best.entry.command.precondition(ctx)) {
    return null;
  }

  return {
    command: best.entry.command,
    params: best.entry.params,
    score: best.score,
    matchedPhrase: best.entry.phrase,
  };
}

export function matchCommandWithReason(
  transcript: string,
  expanded: ExpandedPhrase[],
  ctx: VoiceContext,
): { result: MatchResult } | { blocked: string } | { noMatch: true } {
  const normalized = normalize(transcript);
  const rawTokens = tokenize(normalized);
  const tokens = stripFillers(rawTokens);

  // Try exact match first (Vosk grammar returns known phrases)
  // Check both raw normalized and filler-stripped versions
  const stripped = tokens.join(' ');
  for (const entry of expanded) {
    if (normalized === entry.phrase || stripped === entry.phrase) {
      if (!entry.command.precondition(ctx)) {
        return { blocked: entry.command.preconditionHint ?? 'Befehl nicht verfügbar' };
      }
      return {
        result: { command: entry.command, params: entry.params, score: 1.0, matchedPhrase: entry.phrase },
      };
    }
  }

  let best: { entry: ExpandedPhrase; score: number } | null = null;

  for (const entry of expanded) {
    const score = scoreMatch(tokens, entry.tokens);
    if (score >= 0.5 && (!best || score > best.score)) {
      best = { entry, score };
    }
  }

  if (!best) return { noMatch: true };

  if (!best.entry.command.precondition(ctx)) {
    return { blocked: best.entry.command.preconditionHint ?? 'Befehl nicht verfügbar' };
  }

  return {
    result: {
      command: best.entry.command,
      params: best.entry.params,
      score: best.score,
      matchedPhrase: best.entry.phrase,
    },
  };
}
