/**
 * Generates spoken-form variants of element names for voice recognition.
 *
 * Element names like "C-03", "F24", "AB-7" need to be recognisable when
 * spoken aloud in German. Vosk's constrained grammar only matches exact
 * phrases, so we enumerate plausible ways a worker might say the name.
 *
 * Each variant maps back to the original element name so the command
 * system can look it up regardless of how it was spoken.
 */

const DIGIT_WORDS_DE: Record<string, string> = {
  '0': 'null',
  '1': 'eins',
  '2': 'zwei',
  '3': 'drei',
  '4': 'vier',
  '5': 'fünf',
  '6': 'sechs',
  '7': 'sieben',
  '8': 'acht',
  '9': 'neun',
};

const TEENS_DE: Record<string, string> = {
  '10': 'zehn',
  '11': 'elf',
  '12': 'zwölf',
  '13': 'dreizehn',
  '14': 'vierzehn',
  '15': 'fünfzehn',
  '16': 'sechzehn',
  '17': 'siebzehn',
  '18': 'achtzehn',
  '19': 'neunzehn',
};

const TENS_DE: Record<string, string> = {
  '20': 'zwanzig',
  '30': 'dreißig',
  '40': 'vierzig',
  '50': 'fünfzig',
};

/** Convert a number string (1-2 digits) into German spoken forms. */
function numberToWords(num: string): string[] {
  // Remove leading zeros for word lookup but keep the original for digit-by-digit
  const n = parseInt(num, 10);
  const words: string[] = [];

  if (isNaN(n) || n < 0 || n > 99) return [num];

  // Single digit
  if (n <= 9) {
    words.push(DIGIT_WORDS_DE[String(n)]);
  }
  // Teens
  else if (n >= 10 && n <= 19) {
    words.push(TEENS_DE[String(n)]);
  }
  // Tens
  else if (n % 10 === 0 && TENS_DE[String(n)]) {
    words.push(TENS_DE[String(n)]);
  }
  // Compound (e.g. 24 = "vierundzwanzig")
  else {
    const ones = n % 10;
    const tens = n - ones;
    if (DIGIT_WORDS_DE[String(ones)] && TENS_DE[String(tens)]) {
      words.push(`${DIGIT_WORDS_DE[String(ones)]}und${TENS_DE[String(tens)]}`);
    }
  }

  // Always add digit-by-digit reading (e.g. "null drei" for "03", "zwei vier" for "24")
  if (num.length > 1) {
    const digitByDigit = num
      .split('')
      .map((d) => DIGIT_WORDS_DE[d] ?? d)
      .join(' ');
    words.push(digitByDigit);
  }

  return [...new Set(words)];
}

/**
 * Splits an element name into letter and number parts.
 * "C-03" -> [["c"], ["03"]]
 * "F24"  -> [["f"], ["24"]]
 * "AB-7" -> [["a","b"], ["7"]]
 * "Säule 5" -> [["säule"], [" "], ["5"]]
 */
function splitName(name: string): { letters: string; numbers: string }[] {
  const lower = name.toLowerCase();
  const parts: { letters: string; numbers: string }[] = [];

  // Split on hyphens, spaces, and letter/digit boundaries
  const segments = lower.split(/[-\s]+/).filter(Boolean);

  for (const seg of segments) {
    // Further split into letter runs and digit runs
    const runs = seg.match(/([a-zäöüß]+|\d+)/g);
    if (!runs) continue;
    for (const run of runs) {
      if (/^\d+$/.test(run)) {
        parts.push({ letters: '', numbers: run });
      } else {
        parts.push({ letters: run, numbers: '' });
      }
    }
  }

  return parts;
}

/**
 * Returns all spoken-form variants of an element name.
 * Each variant is lowercased and suitable for Vosk grammar.
 */
export function elementNameVariants(name: string): string[] {
  const lower = name.toLowerCase();
  const parts = splitName(name);
  const variants = new Set<string>();

  // Always include the raw lowercase name (with hyphens/spaces stripped for speech)
  variants.add(lower);
  variants.add(lower.replace(/[-]/g, ' ').replace(/\s+/g, ' ').trim());

  // Build spoken forms by combining letter and number variants
  // e.g. "C-03" -> ["c null drei", "c drei", "c 03"]
  // e.g. "F24"  -> ["f vierundzwanzig", "f zwei vier", "f 24"]
  const partVariants: string[][] = parts.map((p) => {
    if (p.numbers) {
      // Number part: spoken word forms + raw digits
      const wordForms = numberToWords(p.numbers);
      return [...wordForms, p.numbers];
    }
    if (p.letters.length <= 3) {
      // Short letter prefix: spell it out ("ab" -> "a b") + keep as-is
      const spelled = p.letters.split('').join(' ');
      return spelled !== p.letters ? [p.letters, spelled] : [p.letters];
    }
    // Longer word: keep as-is
    return [p.letters];
  });

  // Generate all combinations
  function combine(idx: number, current: string): void {
    if (idx >= partVariants.length) {
      const trimmed = current.trim();
      if (trimmed) variants.add(trimmed);
      return;
    }
    for (const v of partVariants[idx]) {
      combine(idx + 1, current + (current ? ' ' : '') + v);
    }
  }
  combine(0, '');

  return [...variants];
}
