import path from 'node:path';

export const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'time', 'command', 'exec']);
export const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Finds an unquoted heredoc operator (`<<` or `<<-`, excluding `<<<`) on a line
 * and returns its delimiter token, or null if none is present.
 */
function findUnquotedHeredocDelimiter(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && ch === '\\') {
      i++;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (ch === '#') break;
    if (ch === '<' && line[i + 1] === '<') {
      if (line[i + 2] === '<') {
        while (i + 1 < line.length && line[i + 1] === '<') i++;
        continue;
      }
      const m = /^<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(line.slice(i));
      if (m) return m[1] ?? m[2] ?? m[3];
    }
  }
  return null;
}

/**
 * Strips heredoc bodies while preserving command lines and heredoc headers.
 */
export function stripHeredocs(cmd) {
  if (typeof cmd !== 'string') return '';
  const lines = cmd.split('\n');
  const out = [];
  let endToken = null;
  for (const line of lines) {
    if (endToken !== null) {
      if (line.trim() === endToken) endToken = null;
      continue;
    }
    const delim = findUnquotedHeredocDelimiter(line);
    if (delim !== null) endToken = delim;
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Replaces single- and double-quoted literals with `""` so regex scans ignore quoted text.
 */
export function maskQuotes(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, '""');
}

/**
 * Advances `idx` past a balanced `$(...)` starting at `str[idx] === '$' && str[idx + 1] === '('`.
 * Returns the index immediately after the closing `)` (or `str.length` if unclosed).
 */
function scanCommandSubstitutionEnd(str, idx) {
  let depth = 1;
  let j = idx + 2;
  let inDouble = false;

  while (j < str.length && depth > 0) {
    const c = str[j];
    if (!inDouble && c === "'") {
      j++;
      while (j < str.length && str[j] !== "'") j++;
      if (j < str.length) j++;
      continue;
    }
    if (c === '"') {
      inDouble = !inDouble;
      j++;
      continue;
    }
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) {
        return j + 1;
      }
    }
    j++;
  }
  return j;
}

/**
 * Advances `idx` past a balanced backtick substitution starting at `str[idx] === '`'`.
 * Returns the index immediately after the closing backtick (or `str.length` if unclosed).
 */
function scanBacktickEnd(str, idx) {
  let j = idx + 1;
  while (j < str.length) {
    if (str[j] === '\\') {
      j += 2;
      continue;
    }
    if (str[j] === '`') {
      return j + 1;
    }
    j++;
  }
  return j;
}

/**
 * Reads one shell word token starting at `idx`, stopping at whitespace (or optionally redirection chars).
 * Returns `{ value, nextIndex, hadContent }`.
 */
function readWordToken(str, startIdx, { stopAtRedir = false } = {}) {
  let i = startIdx;
  let value = '';
  let hadQuotes = false;

  while (i < str.length) {
    const ch = str[i];
    if (/\s/.test(ch)) break;
    if (stopAtRedir && (ch === '<' || ch === '>')) break;

    if (ch === "'") {
      hadQuotes = true;
      i++;
      while (i < str.length && str[i] !== "'") {
        value += str[i++];
      }
      if (i < str.length) i++;
      continue;
    }

    if (ch === '"') {
      hadQuotes = true;
      i++;
      while (i < str.length && str[i] !== '"') {
        if (str[i] === '\\' && i + 1 < str.length) {
          const next = str[i + 1];
          if (next === '"' || next === '\\' || next === '`') {
            value += next;
            i += 2;
            continue;
          }
          value += str[i] + next;
          i += 2;
          continue;
        }
        value += str[i++];
      }
      if (i < str.length) i++;
      continue;
    }

    if (ch === '\\' && i + 1 < str.length) {
      value += str[i + 1];
      i += 2;
      continue;
    }

    if (ch === '$' && str[i + 1] === '(') {
      const end = scanCommandSubstitutionEnd(str, i);
      value += str.slice(i, end);
      i = end;
      continue;
    }

    if (ch === '`') {
      const end = scanBacktickEnd(str, i);
      value += str.slice(i, end);
      i = end;
      continue;
    }

    value += ch;
    i++;
  }

  return { value, nextIndex: i, hadContent: hadQuotes || i > startIdx };
}

/**
 * Quote-aware shell word tokenizer.
 */
export function tokenize(seg) {
  if (typeof seg !== 'string') return [];
  const tokens = [];
  let i = 0;
  while (i < seg.length) {
    while (i < seg.length && /\s/.test(seg[i])) i++;
    if (i >= seg.length) break;
    const { value, nextIndex, hadContent } = readWordToken(seg, i);
    if (hadContent) tokens.push(value);
    if (nextIndex <= i) i++;
    else i = nextIndex;
  }
  return tokens;
}

/**
 * Strips leading environment variable assignments and command wrappers
 * (`sudo`, `env`, `nohup`, `time`, `command`, `exec`).
 */
export function stripWrappers(tokens) {
  if (!Array.isArray(tokens)) {
    return { bin: null, rest: [], envAssignments: [], wrappers: [] };
  }
  let i = 0;
  const envAssignments = [];
  const wrappers = [];
  while (i < tokens.length) {
    const t = tokens[i];
    if (ASSIGN_RE.test(t)) {
      envAssignments.push(t);
      i++;
      continue;
    }
    if (WRAPPERS.has(t)) {
      wrappers.push(t);
      i++;
      continue;
    }
    break;
  }
  return {
    bin: tokens[i] ? path.basename(tokens[i]) : null,
    rest: tokens.slice(i + 1),
    envAssignments,
    wrappers,
  };
}

/**
 * Returns the target directory if a segment or token list invokes `cd`, otherwise null.
 */
export function parseCdSegment(segOrTokens) {
  const tokens = Array.isArray(segOrTokens) ? segOrTokens : tokenize(segOrTokens);
  const { bin, rest } = stripWrappers(tokens);
  if (bin !== 'cd') return null;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--') return rest[i + 1] ?? null;
    if (tok.startsWith('-')) continue;
    return tok;
  }
  return null;
}

/**
 * Extracts nested command strings from `bash|sh|zsh|dash -c <cmd>` and `eval <cmd...>`.
 */
export function parseNestedCommand(segOrTokens) {
  const tokens = Array.isArray(segOrTokens) ? segOrTokens : tokenize(segOrTokens);
  const { bin, rest } = stripWrappers(tokens);
  if (!bin) return null;
  if (bin === 'bash' || bin === 'sh' || bin === 'zsh' || bin === 'dash') {
    for (let j = 0; j < rest.length - 1; j++) {
      const tok = rest[j];
      if (tok === '--') break;
      if (tok === '-c' || /^-[A-Za-z]*c$/.test(tok)) {
        return rest[j + 1];
      }
    }
    return null;
  }
  if (bin === 'eval' && rest.length > 0) {
    return rest.join(' ');
  }
  return null;
}

/**
 * Recursively extracts `$(...)` and backtick command substitutions outside single quotes.
 */
export function extractSubshells(str) {
  if (typeof str !== 'string') return [];
  const subshells = [];
  let i = 0;
  let inDoubleQuote = false;

  while (i < str.length) {
    const ch = str[i];

    if (!inDoubleQuote && ch === "'") {
      i++;
      while (i < str.length && str[i] !== "'") i++;
      if (i < str.length) i++;
      continue;
    }

    if (ch === '"') {
      inDoubleQuote = !inDoubleQuote;
      i++;
      continue;
    }

    if (ch === '\\') {
      i += 2;
      continue;
    }

    if (ch === '$' && str[i + 1] === '(') {
      const end = scanCommandSubstitutionEnd(str, i);
      const innerEnd = end > i + 2 && str[end - 1] === ')' ? end - 1 : end;
      subshells.push(str.slice(i + 2, innerEnd));
      i = end;
      continue;
    }

    if (ch === '`') {
      const end = scanBacktickEnd(str, i);
      const innerEnd = end > i + 1 && str[end - 1] === '`' ? end - 1 : end;
      subshells.push(str.slice(i + 1, innerEnd));
      i = end;
      continue;
    }

    i++;
  }

  return subshells;
}

/**
 * Attempts to parse an unquoted redirection at `str[i]` (must be at token boundary).
 * Returns `{ redir, nextIndex }` or null.
 */
function tryParseRedirection(str, i) {
  const slice = str.slice(i);

  // `&>>` or `&>` (redirect both stdout and stderr)
  if (slice.startsWith('&>>') || slice.startsWith('&>')) {
    const op = slice.startsWith('&>>') ? '&>>' : '&>';
    let j = i + op.length;
    while (j < str.length && (str[j] === ' ' || str[j] === '\t')) j++;
    const tok = readWordToken(str, j, { stopAtRedir: true });
    const target = tok.hadContent ? tok.value : null;
    return {
      redir: {
        op,
        fd: 'all',
        target,
        isDevNull: target === '/dev/null',
        isInput: false,
        isOutput: true,
        isFdDup: false,
        raw: str.slice(i, tok.nextIndex).trim(),
      },
      nextIndex: tok.nextIndex,
    };
  }

  const m = /^([0-9])?(<<-|<<<|<<|<>|<&|<|>>|>&|>\||>)/.exec(slice);
  if (!m) return null;

  const explicitFd = m[1] !== undefined ? Number(m[1]) : null;
  const rawOp = m[2];
  let j = i + m[0].length;
  while (j < str.length && (str[j] === ' ' || str[j] === '\t')) j++;
  const tok = readWordToken(str, j, { stopAtRedir: true });
  const rawTarget = tok.hadContent ? tok.value : null;
  const raw = str.slice(i, tok.nextIndex).trim();

  if (rawOp === '<<' || rawOp === '<<-' || rawOp === '<<<') {
    return {
      redir: {
        op: rawOp,
        fd: explicitFd ?? 0,
        target: rawTarget,
        isDevNull: false,
        isInput: false,
        isOutput: false,
        isFdDup: false,
        raw,
      },
      nextIndex: tok.nextIndex,
    };
  }

  if (rawOp === '>&' || rawOp === '<&') {
    const defaultFd = rawOp === '<&' ? 0 : 1;
    const fd = explicitFd ?? defaultFd;
    const isFdNumOrClose = rawTarget !== null && /^(?:\d+|-)$/.test(rawTarget);

    // Unprefixed `>& file` in bash redirects both stdout and stderr when target is not fd/-
    if (rawOp === '>&' && explicitFd === null && !isFdNumOrClose) {
      return {
        redir: {
          op: '&>',
          fd: 'all',
          target: rawTarget,
          isDevNull: rawTarget === '/dev/null',
          isInput: false,
          isOutput: true,
          isFdDup: false,
          raw,
        },
        nextIndex: tok.nextIndex,
      };
    }

    const dupOp = `${explicitFd !== null ? explicitFd : ''}${rawOp}${rawTarget ?? ''}`;
    return {
      redir: {
        op: dupOp,
        fd,
        target: rawTarget !== null ? `&${rawTarget}` : null,
        isDevNull: false,
        isInput: false,
        isOutput: false,
        isFdDup: true,
        raw,
      },
      nextIndex: tok.nextIndex,
    };
  }

  if (rawOp === '<' || rawOp === '<>') {
    const fd = explicitFd ?? 0;
    return {
      redir: {
        op: rawOp,
        fd,
        target: rawTarget,
        isDevNull: rawTarget === '/dev/null',
        isInput: true,
        isOutput: rawOp === '<>',
        isFdDup: false,
        raw,
      },
      nextIndex: tok.nextIndex,
    };
  }

  // Output redirections: `>`, `>>`, `>|`
  const fd = explicitFd ?? 1;
  const op = fd === 1 ? rawOp : `${fd}${rawOp}`;
  return {
    redir: {
      op,
      fd,
      target: rawTarget,
      isDevNull: rawTarget === '/dev/null',
      isInput: false,
      isOutput: true,
      isFdDup: false,
      raw,
    },
    nextIndex: tok.nextIndex,
  };
}

/**
 * Parses a single pipeline stage string into cleaned tokens, wrappers/command info,
 * per-stage I/O redirections, and stdout destination metadata.
 */
export function parseStage(rawStage, { pipeIn = null, pipeOut = null, stageIndex = 0, stageCount = 1 } = {}) {
  const raw = typeof rawStage === 'string' ? rawStage.trim() : '';
  const tokens = [];
  const redirections = [];
  let i = 0;

  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i])) i++;
    if (i >= raw.length) break;

    const redirHit = tryParseRedirection(raw, i);
    if (redirHit) {
      redirections.push(redirHit.redir);
      i = redirHit.nextIndex;
      continue;
    }

    const word = readWordToken(raw, i, { stopAtRedir: true });
    if (word.hadContent) {
      tokens.push(word.value);
      i = word.nextIndex;
      continue;
    }

    // Fallback when stuck on a bare metacharacter (e.g. solitary `&` not followed by `>`)
    const fallback = readWordToken(raw, i, { stopAtRedir: false });
    if (fallback.hadContent) tokens.push(fallback.value);
    i = fallback.nextIndex > i ? fallback.nextIndex : i + 1;
  }

  const { bin, rest, envAssignments, wrappers } = stripWrappers(tokens);

  let stdoutDestination = pipeOut ? 'pipe' : 'terminal';
  let stdoutTarget = null;
  for (const r of redirections) {
    if (r.isOutput && (r.fd === 1 || r.fd === 'all')) {
      if (r.isDevNull) {
        stdoutDestination = 'devnull';
        stdoutTarget = '/dev/null';
      } else if (r.target) {
        stdoutDestination = 'file';
        stdoutTarget = r.target;
      }
    }
  }

  const inputFiles = redirections
    .filter((r) => r.isInput && r.target)
    .map((r) => r.target);

  return {
    raw,
    tokens,
    bin,
    rest,
    envAssignments,
    wrappers,
    redirections,
    inputFiles,
    pipeIn,
    pipeOut,
    stageIndex,
    stageCount,
    stdoutDestination,
    stdoutTarget,
  };
}

/**
 * Splits a shell command string on unquoted top-level separators while skipping quotes,
 * escapes, `$(...)`, backticks, and `#` comments.
 */
function splitTopLevel(str, mode) {
  const parts = [];
  let start = 0;
  let pendingSep = null;
  let i = 0;
  let atWordBoundary = true;

  const pushPart = (endIdx, nextSep) => {
    const raw = str.slice(start, endIdx).trim();
    if (raw) {
      parts.push({ raw, separatorBefore: pendingSep });
    }
    pendingSep = nextSep;
  };

  while (i < str.length) {
    const ch = str[i];

    if (ch === "'") {
      i++;
      while (i < str.length && str[i] !== "'") i++;
      if (i < str.length) i++;
      atWordBoundary = false;
      continue;
    }

    if (ch === '"') {
      i++;
      while (i < str.length && str[i] !== '"') {
        if (str[i] === '\\') i += 2;
        else i++;
      }
      if (i < str.length) i++;
      atWordBoundary = false;
      continue;
    }

    if (ch === '\\') {
      i += 2;
      atWordBoundary = false;
      continue;
    }

    if (ch === '$' && str[i + 1] === '(') {
      i = scanCommandSubstitutionEnd(str, i);
      atWordBoundary = false;
      continue;
    }

    if (ch === '`') {
      i = scanBacktickEnd(str, i);
      atWordBoundary = false;
      continue;
    }

    if (ch === '#' && atWordBoundary) {
      // Unquoted shell comment runs to end of line
      const nl = str.indexOf('\n', i);
      if (mode === 'lists') {
        pushPart(i, pendingSep);
        if (nl === -1) {
          start = str.length;
          break;
        }
        pendingSep = '\n';
        start = nl + 1;
        i = nl + 1;
        atWordBoundary = true;
        continue;
      }
      if (nl === -1) {
        i = str.length;
        break;
      }
      i = nl + 1;
      atWordBoundary = true;
      continue;
    }

    if (mode === 'lists') {
      if (ch === ';' || ch === '\n') {
        pushPart(i, ch);
        i++;
        start = i;
        atWordBoundary = true;
        continue;
      }
      if (ch === '&' && str[i + 1] === '&') {
        pushPart(i, '&&');
        i += 2;
        start = i;
        atWordBoundary = true;
        continue;
      }
      if (ch === '|' && str[i + 1] === '|') {
        pushPart(i, '||');
        i += 2;
        start = i;
        atWordBoundary = true;
        continue;
      }
      if (ch === '&') {
        const prev = i > 0 ? str[i - 1] : '';
        const next = str[i + 1] ?? '';
        // Preserve redirections: `&>`, `&>>`, `2>&1`, `<&3`, `|&`
        if (next === '>' || prev === '>' || prev === '<' || prev === '|') {
          i++;
          atWordBoundary = false;
          continue;
        }
        pushPart(i, '&');
        i++;
        start = i;
        atWordBoundary = true;
        continue;
      }
      if (ch === '(' || ch === ')') {
        const prev = i > 0 ? str[i - 1] : '';
        if (ch === '(' && (prev === '$' || prev === '<' || prev === '>')) {
          i++;
          atWordBoundary = false;
          continue;
        }
        pushPart(i, ch);
        i++;
        start = i;
        atWordBoundary = true;
        continue;
      }
    } else if (mode === 'pipeline') {
      if (ch === '|' && str[i + 1] === '|') {
        i += 2;
        atWordBoundary = true;
        continue;
      }
      if (ch === '|' && str[i + 1] === '&') {
        pushPart(i, '|&');
        i += 2;
        start = i;
        atWordBoundary = true;
        continue;
      }
      if (ch === '|') {
        const prev = i > 0 ? str[i - 1] : '';
        // Preserve `>|` noclobber redirection
        if (prev === '>') {
          i++;
          atWordBoundary = false;
          continue;
        }
        pushPart(i, '|');
        i++;
        start = i;
        atWordBoundary = true;
        continue;
      }
    }

    atWordBoundary = /\s/.test(ch);
    i++;
  }

  const tail = str.slice(start).trim();
  if (tail) {
    parts.push({ raw: tail, separatorBefore: pendingSep });
  }
  return parts;
}

/**
 * Parses a shell command into command lists (`;`, `&&`, `||`, `&`, `\n`, grouping `(...)`),
 * each containing ordered pipeline stages (`|`, `|&`) with parsed tokens and I/O redirections.
 */
export function parseCommandLists(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return [];
  const lists = splitTopLevel(cmd, 'lists');
  return lists.map(({ raw, separatorBefore }) => {
    const rawStages = splitTopLevel(raw, 'pipeline');
    const stageCount = rawStages.length;
    const stages = rawStages.map((s, idx) =>
      parseStage(s.raw, {
        pipeIn: s.separatorBefore,
        pipeOut: idx + 1 < stageCount ? rawStages[idx + 1].separatorBefore : null,
        stageIndex: idx,
        stageCount,
      }),
    );
    return {
      raw,
      separatorBefore,
      stages,
    };
  });
}

/**
 * Splits a shell command into flat trimmed stage strings across command-list and pipeline boundaries.
 */
export function splitSegments(cmd) {
  const lists = parseCommandLists(cmd);
  const segs = [];
  for (const list of lists) {
    for (const stage of list.stages) {
      if (stage.raw) segs.push(stage.raw);
    }
  }
  return segs;
}
