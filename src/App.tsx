import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';

type DiffLine = {
  type: 'same' | 'added' | 'removed';
  left?: string;
  right?: string;
  text: string;
};

type WordToken = {
  text: string;
  changed: boolean;
};

type DiffRow = {
  type: 'same' | 'added' | 'removed' | 'modified';
  left: string;
  right: string;
  leftTokens?: WordToken[];
  rightTokens?: WordToken[];
};

type Theme = 'night' | 'day';

type Token = {
  text: string;
  type: 'plain' | 'sql-keyword' | 'sql-string' | 'sql-number' | 'sql-symbol' | 'json-key' | 'json-string' | 'json-number' | 'json-literal' | 'json-punctuation';
};

type JsonErrorInfo = {
  message: string;
  index: number | null;
  formattedIndex: number | null;
  line: number | null;
  column: number | null;
  lineText: string;
};

const sampleSql = `select id, name, created_at from users where status = 'active' and deleted_at is null order by created_at desc;`;
const sampleJson = '{"name":"Ministrybrands","features":["timestamp","sql formatter","json formatter","text compare"],"enabled":true}';
const sampleLeft = `Alpha\nBeta\nGamma\nDelta`;
const sampleRight = `Alpha\nBeta\nGamma updated\nEpsilon\nDelta`;

const navItems = [
  { to: '/timestamp', label: 'Timestamp' },
  { to: '/sql', label: 'SQL' },
  { to: '/json', label: 'JSON' },
  { to: '/diff', label: 'Text Diff' },
];

function formatTimestamp(date: Date) {
  return {
    local: date.toLocaleString('en-US', { hour12: false }),
    iso: date.toISOString(),
    unix: Math.floor(date.getTime() / 1000).toString(),
    unixMs: date.getTime().toString(),
  };
}

function formatSql(input: string) {
  const compact = input.trim().replace(/\s+/g, ' ');
  if (!compact) {
    return '';
  }

  const keywords = new Set([
    'select',
    'from',
    'where',
    'group by',
    'order by',
    'having',
    'limit',
    'offset',
    'join',
    'left join',
    'right join',
    'inner join',
    'outer join',
    'full join',
    'on',
    'and',
    'or',
    'insert into',
    'values',
    'update',
    'set',
    'delete from',
  ]);

  const segments = compact.match(/(?:'[^']*'|\(|\)|,|\b(?:select|from|where|group by|order by|having|limit|offset|join|left join|right join|inner join|outer join|full join|on|and|or|insert into|values|update|set|delete from)\b|[^(),\s]+)/gi) ?? [compact];
  const lines: string[] = [];
  let current = '';
  let indent = 0;

  const pushCurrent = () => {
    const value = current.trim();
    if (value) {
      lines.push(`${'  '.repeat(Math.max(indent, 0))}${value}`);
    }
    current = '';
  };

  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (keywords.has(lower)) {
      pushCurrent();
      lines.push(`${'  '.repeat(Math.max(indent, 0))}${segment.toUpperCase()}`);
      if (lower === 'select' || lower === 'insert into' || lower === 'update' || lower === 'delete from') {
        indent = 1;
      }
      continue;
    }

    if (segment === ',') {
      current = `${current.trimEnd()},`;
      pushCurrent();
      continue;
    }

    if (segment === '(') {
      current = `${current.trimEnd()} (`;
      indent += 1;
      continue;
    }

    if (segment === ')') {
      pushCurrent();
      indent = Math.max(indent - 1, 0);
      lines.push(`${'  '.repeat(indent)})`);
      continue;
    }

    current = current ? `${current} ${segment}` : segment;
  }

  pushCurrent();
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function formatJson(input: string) {
  const parsed = JSON.parse(input);
  return JSON.stringify(parsed, null, 2);
}

function compressJson(input: string) {
  const parsed = JSON.parse(input);
  return JSON.stringify(parsed);
}

function getLineColumnText(input: string, index: number) {
  const safe = Math.max(0, Math.min(index, input.length));
  const before = input.slice(0, safe);
  const lines = input.split(/\r?\n/);
  const line = before.split(/\r?\n/).length;
  const lastBreak = before.lastIndexOf('\n');
  const column = lastBreak === -1 ? before.length + 1 : before.length - lastBreak;
  const lineText = lines[Math.max(line - 1, 0)] ?? '';
  return { line, column, lineText };
}

function findLikelyJsonErrorIndex(input: string) {
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === ',') {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) {
        j += 1;
      }
      if (j < input.length && (input[j] === ',' || input[j] === ']' || input[j] === '}')) {
        return j;
      }
    }
  }

  return null;
}

function tryFormatInvalidJson(input: string) {
  let indent = 0;
  let inString = false;
  let escaped = false;
  let output = '';
  const indexMap: number[] = new Array(input.length).fill(0);

  const append = (value: string) => {
    output += value;
  };

  const appendIndent = () => {
    append('  '.repeat(Math.max(indent, 0)));
  };

  const trimLineEndSpaces = () => {
    while (output.endsWith(' ') || output.endsWith('\t')) {
      output = output.slice(0, -1);
    }
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    indexMap[i] = output.length;

    if (inString) {
      append(ch);
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (/\s/.test(ch)) {
      continue;
    }

    if (ch === '"') {
      inString = true;
      append(ch);
      continue;
    }

    if (ch === '{' || ch === '[') {
      append(ch);
      indent += 1;
      append('\n');
      appendIndent();
      continue;
    }

    if (ch === '}' || ch === ']') {
      indent = Math.max(indent - 1, 0);
      trimLineEndSpaces();
      if (!output.endsWith('\n')) {
        append('\n');
      }
      appendIndent();
      append(ch);
      continue;
    }

    if (ch === ',') {
      append(ch);
      append('\n');
      appendIndent();
      continue;
    }

    if (ch === ':') {
      append(': ');
      continue;
    }

    append(ch);
  }

  return {
    formatted: output.trim(),
    indexMap,
  };
}

function getJsonErrorInfo(error: unknown, input: string): JsonErrorInfo {
  const message = error instanceof Error ? error.message : 'Unknown error';
  const match = message.match(/position\s+(\d+)/i);
  const inferredIndex = findLikelyJsonErrorIndex(input);
  if (!match) {
    if (inferredIndex !== null) {
      const location = getLineColumnText(input, inferredIndex);
      return {
        message,
        index: inferredIndex,
        formattedIndex: null,
        line: location.line,
        column: location.column,
        lineText: location.lineText,
      };
    }

    return {
      message,
      index: null,
      formattedIndex: null,
      line: null,
      column: null,
      lineText: '',
    };
  }

  const position = Number(match[1]);
  if (Number.isNaN(position) || position < 0 || position > input.length) {
    return {
      message,
      index: null,
      formattedIndex: null,
      line: null,
      column: null,
      lineText: '',
    };
  }
  const location = getLineColumnText(input, position);

  return {
    message,
    index: position,
    formattedIndex: null,
    line: location.line,
    column: location.column,
    lineText: location.lineText,
  };
}

function tokenizeByRegex(input: string, regex: RegExp, classify: (segment: string) => Token['type']) {
  const tokens: Token[] = [];
  let last = 0;
  let matched: RegExpExecArray | null = regex.exec(input);

  while (matched) {
    const [value] = matched;
    const start = matched.index;
    if (start > last) {
      tokens.push({ text: input.slice(last, start), type: 'plain' });
    }
    tokens.push({ text: value, type: classify(value) });
    last = start + value.length;
    matched = regex.exec(input);
  }

  if (last < input.length) {
    tokens.push({ text: input.slice(last), type: 'plain' });
  }

  return tokens;
}

function highlightSql(input: string) {
  if (!input) {
    return [];
  }

  const sqlTokenRegex = /(\b(?:SELECT|FROM|WHERE|GROUP BY|ORDER BY|HAVING|LIMIT|OFFSET|JOIN|LEFT JOIN|RIGHT JOIN|INNER JOIN|OUTER JOIN|FULL JOIN|ON|AND|OR|INSERT INTO|VALUES|UPDATE|SET|DELETE FROM)\b|'[^']*'|\b\d+(?:\.\d+)?\b|[(),.;])/gi;
  return tokenizeByRegex(input, sqlTokenRegex, (segment) => {
    if (/^'[^']*'$/.test(segment)) {
      return 'sql-string';
    }
    if (/^\d/.test(segment)) {
      return 'sql-number';
    }
    if (/^[(),.;]$/.test(segment)) {
      return 'sql-symbol';
    }
    return 'sql-keyword';
  });
}

function highlightJson(input: string) {
  if (!input) {
    return [];
  }

  const jsonTokenRegex = /("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*")\s*|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\],:]/g;
  return tokenizeByRegex(input, jsonTokenRegex, (segment) => {
    const clean = segment.trim();
    if (/^"(?:\\.|[^"\\])*"\s*:$/.test(clean)) {
      return 'json-key';
    }
    if (/^"(?:\\.|[^"\\])*"$/.test(clean)) {
      return 'json-string';
    }
    if (/^(true|false|null)$/.test(clean)) {
      return 'json-literal';
    }
    if (/^-?\d/.test(clean)) {
      return 'json-number';
    }
    return 'json-punctuation';
  });
}

function renderJsonTokens(tokens: Token[], errorIndex: number | null, totalLength: number) {
  let cursor = 0;
  let markerInserted = false;
  const nodes: ReactNode[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const start = cursor;
    const end = start + token.text.length;

    if (errorIndex !== null && !markerInserted && errorIndex >= start && errorIndex < end) {
      const splitAt = errorIndex - start;
      const before = token.text.slice(0, splitAt);
      const errorChar = token.text.slice(splitAt, splitAt + 1);
      const after = token.text.slice(splitAt + 1);

      if (before) {
        nodes.push(
          <span key={`json-before-${i}`} className={`token ${token.type}`}>
            {before}
          </span>,
        );
      }

      nodes.push(
        <span key={`json-marker-${i}`} className="json-error-inline-marker">
          {'\n▲ Error location\n'}
        </span>,
      );

      if (errorChar) {
        nodes.push(
          <span key={`json-error-char-${i}`} className={`token ${token.type} json-error-char`}>
            {errorChar}
          </span>,
        );
      }

      if (after) {
        nodes.push(
          <span key={`json-after-${i}`} className={`token ${token.type}`}>
            {after}
          </span>,
        );
      }

      markerInserted = true;
      cursor = end;
      continue;
    }

    nodes.push(
      <span key={`json-token-${i}`} className={`token ${token.type}`}>
        {token.text}
      </span>,
    );

    cursor = end;
  }

  if (errorIndex !== null && !markerInserted && errorIndex >= totalLength) {
    nodes.push(
      <span key="json-marker-end" className="json-error-inline-marker">
        {'\n▲ Error location (end)'}
      </span>,
    );
  }

  return nodes;
}

function buildDiff(left: string, right: string): DiffLine[] {
  const leftLines = left.split(/\r?\n/);
  const rightLines = right.split(/\r?\n/);
  const rows = Array.from({ length: leftLines.length + 1 }, () => Array(rightLines.length + 1).fill(0));

  for (let i = leftLines.length - 1; i >= 0; i -= 1) {
    for (let j = rightLines.length - 1; j >= 0; j -= 1) {
      rows[i][j] = leftLines[i] === rightLines[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < leftLines.length && j < rightLines.length) {
    if (leftLines[i] === rightLines[j]) {
      result.push({ type: 'same', left: leftLines[i], right: rightLines[j], text: leftLines[i] });
      i += 1;
      j += 1;
      continue;
    }

    if (rows[i + 1][j] >= rows[i][j + 1]) {
      result.push({ type: 'removed', left: leftLines[i], text: leftLines[i] });
      i += 1;
    } else {
      result.push({ type: 'added', right: rightLines[j], text: rightLines[j] });
      j += 1;
    }
  }

  while (i < leftLines.length) {
    result.push({ type: 'removed', left: leftLines[i], text: leftLines[i] });
    i += 1;
  }

  while (j < rightLines.length) {
    result.push({ type: 'added', right: rightLines[j], text: rightLines[j] });
    j += 1;
  }

  return result;
}

function tokenizeWords(line: string) {
  return line.split(/(\s+|[，。！？；：,.!?;:()\[\]{}'"`~@#$%^&*+=<>/\\|-]+)/g).filter(Boolean);
}

function diffWords(left: string, right: string) {
  const leftParts = tokenizeWords(left);
  const rightParts = tokenizeWords(right);
  const matrix = Array.from({ length: leftParts.length + 1 }, () => Array(rightParts.length + 1).fill(0));

  for (let i = leftParts.length - 1; i >= 0; i -= 1) {
    for (let j = rightParts.length - 1; j >= 0; j -= 1) {
      matrix[i][j] = leftParts[i] === rightParts[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
    }
  }

  const leftTokens: WordToken[] = [];
  const rightTokens: WordToken[] = [];
  let i = 0;
  let j = 0;

  while (i < leftParts.length && j < rightParts.length) {
    if (leftParts[i] === rightParts[j]) {
      leftTokens.push({ text: leftParts[i], changed: false });
      rightTokens.push({ text: rightParts[j], changed: false });
      i += 1;
      j += 1;
      continue;
    }

    if (matrix[i + 1][j] >= matrix[i][j + 1]) {
      leftTokens.push({ text: leftParts[i], changed: true });
      i += 1;
    } else {
      rightTokens.push({ text: rightParts[j], changed: true });
      j += 1;
    }
  }

  while (i < leftParts.length) {
    leftTokens.push({ text: leftParts[i], changed: true });
    i += 1;
  }

  while (j < rightParts.length) {
    rightTokens.push({ text: rightParts[j], changed: true });
    j += 1;
  }

  return { leftTokens, rightTokens };
}

function buildWordDiffRows(left: string, right: string): DiffRow[] {
  const lineDiff = buildDiff(left, right);
  const rows: DiffRow[] = [];

  for (let i = 0; i < lineDiff.length; i += 1) {
    const current = lineDiff[i];
    const next = lineDiff[i + 1];

    if (current.type === 'removed' && next?.type === 'added') {
      const paired = diffWords(current.left ?? '', next.right ?? '');
      rows.push({
        type: 'modified',
        left: current.left ?? '',
        right: next.right ?? '',
        leftTokens: paired.leftTokens,
        rightTokens: paired.rightTokens,
      });
      i += 1;
      continue;
    }

    if (current.type === 'same') {
      rows.push({ type: 'same', left: current.left ?? '', right: current.right ?? '' });
      continue;
    }

    if (current.type === 'removed') {
      rows.push({ type: 'removed', left: current.left ?? '', right: '' });
      continue;
    }

    rows.push({ type: 'added', left: '', right: current.right ?? '' });
  }

  return rows;
}

function copyText(text: string) {
  return navigator.clipboard.writeText(text);
}

function ToolCard(props: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="tool-card">
      <div className="tool-card__header">
        <div>
          <h2>{props.title}</h2>
          <p>{props.description}</p>
        </div>
      </div>
      {props.children}
    </section>
  );
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(() => {
    const cached = window.localStorage.getItem('tool-theme');
    return cached === 'day' ? 'day' : 'night';
  });
  const [now, setNow] = useState(() => new Date());
  const [sqlInput, setSqlInput] = useState(sampleSql);
  const [sqlOutput, setSqlOutput] = useState('');
  const [sqlMessage, setSqlMessage] = useState('Click Format SQL to organize the query.');
  const [jsonInput, setJsonInput] = useState(sampleJson);
  const [jsonOutput, setJsonOutput] = useState('');
  const [jsonMessage, setJsonMessage] = useState('Validate JSON quickly before prettifying or compressing it.');
  const [jsonErrorInfo, setJsonErrorInfo] = useState<JsonErrorInfo | null>(null);
  const [leftText, setLeftText] = useState(sampleLeft);
  const [rightText, setRightText] = useState(sampleRight);
  const [copyMessage, setCopyMessage] = useState('');
  const [activeDiffPointer, setActiveDiffPointer] = useState(-1);
  const diffRowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const diffRows = useMemo(() => buildWordDiffRows(leftText, rightText), [leftText, rightText]);
  const diffRowIndexes = useMemo(
    () => diffRows.map((row, index) => (row.type === 'same' ? -1 : index)).filter((index) => index >= 0),
    [diffRows],
  );
  const isDiffMatched = diffRowIndexes.length === 0;
  const formattedTimestamp = useMemo(() => formatTimestamp(now), [now]);
  const sqlTokens = useMemo(() => highlightSql(sqlOutput), [sqlOutput]);
  const jsonDisplayText = useMemo(() => (jsonOutput ? jsonOutput : (jsonErrorInfo ? jsonInput : '')), [jsonErrorInfo, jsonInput, jsonOutput]);
  const jsonTokens = useMemo(() => highlightJson(jsonDisplayText), [jsonDisplayText]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    window.localStorage.setItem('tool-theme', theme);
  }, [theme]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const handleSqlFormat = () => {
    try {
      const formatted = formatSql(sqlInput);
      setSqlOutput(formatted);
      setSqlMessage(formatted ? 'SQL has been reformatted.' : 'Input is empty.');
    } catch {
      setSqlOutput('');
      setSqlMessage('Automatic formatting is not supported for this SQL snippet yet.');
    }
  };

  const handleJsonFormat = () => {
    try {
      const formatted = formatJson(jsonInput);
      setJsonOutput(formatted);
      setJsonErrorInfo(null);
      setJsonMessage('JSON has been validated and prettified.');
    } catch (error) {
      const rough = tryFormatInvalidJson(jsonInput);
      const info = getJsonErrorInfo(error, jsonInput);
      const formattedIndex = info.index !== null ? (rough.indexMap[info.index] ?? rough.formatted.length) : null;
      setJsonOutput(rough.formatted || jsonInput);
      setJsonErrorInfo({ ...info, formattedIndex });
      setJsonMessage(`JSON format error: ${info.message} (formatting and highlighting were attempted)`);
    }
  };

  const handleJsonCompress = () => {
    try {
      const compressed = compressJson(jsonInput);
      setJsonOutput(compressed);
      setJsonErrorInfo(null);
      setJsonMessage('JSON has been compressed into a single line.');
    } catch (error) {
      const rough = tryFormatInvalidJson(jsonInput);
      const info = getJsonErrorInfo(error, jsonInput);
      const formattedIndex = info.index !== null ? (rough.indexMap[info.index] ?? rough.formatted.length) : null;
      setJsonOutput(rough.formatted || jsonInput);
      setJsonErrorInfo({ ...info, formattedIndex });
      setJsonMessage(`JSON format error: ${info.message} (formatting and highlighting were attempted)`);
    }
  };

  const handleCopy = async (text: string, label: string) => {
    await copyText(text);
    if (label === 'SQL') {
      setSqlMessage('SQL copied to clipboard.');
      return;
    }

    if (label === 'JSON') {
      setJsonMessage('JSON copied to clipboard.');
      return;
    }

    setCopyMessage(`${label} copied to clipboard.`);
  };

  const handleJumpNextDiff = () => {
    if (diffRowIndexes.length === 0) {
      return;
    }

    const nextPointer = (activeDiffPointer + 1) % diffRowIndexes.length;
    const targetIndex = diffRowIndexes[nextPointer];
    setActiveDiffPointer(nextPointer);

    const row = diffRowRefs.current[targetIndex];
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  useEffect(() => {
    setActiveDiffPointer(-1);
    diffRowRefs.current = [];
  }, [leftText, rightText]);

  return (
    <HashRouter>
      <main className="app-shell">
        <div className="background-orb background-orb--one" />
        <div className="background-orb background-orb--two" />

        <nav className="top-nav" aria-label="Tool navigation">
          <div className="top-nav__links">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `top-nav__link${isActive ? ' top-nav__link--active' : ''}`}
              >
                {item.label}
              </NavLink>
            ))}
          </div>
          <button type="button" className="theme-switch" onClick={() => setTheme(theme === 'night' ? 'day' : 'night')}>
            {theme === 'night' ? 'Switch to light theme' : 'Switch to dark theme'}
          </button>
        </nav>

        <div className="page-frame">
          <Routes>
            <Route
              path="/timestamp"
              element={(
                <section className="timestamp-panel">
                  <div>
                    <div className="section-label">Timestamp</div>
                    <p>Useful for quickly grabbing values for screenshots, logs, and sharing.</p>
                    <div className="timestamp-list">
                      <div className="timestamp-item">
                        <div>
                          <div className="timestamp-item__label">Local time</div>
                          <div className="timestamp-item__value">{formattedTimestamp.local}</div>
                        </div>
                        <button className="chip" type="button" onClick={() => handleCopy(formattedTimestamp.local, 'Timestamp')}>
                          Copy local time
                        </button>
                      </div>
                      <div className="timestamp-item">
                        <div>
                          <div className="timestamp-item__label">ISO time</div>
                          <div className="timestamp-item__value">{formattedTimestamp.iso}</div>
                        </div>
                        <button className="chip" type="button" onClick={() => handleCopy(formattedTimestamp.iso, 'Timestamp')}>
                          Copy ISO time
                        </button>
                      </div>
                      <div className="timestamp-item">
                        <div>
                          <div className="timestamp-item__label">Unix seconds</div>
                          <div className="timestamp-item__value">{formattedTimestamp.unix}</div>
                        </div>
                        <button className="chip" type="button" onClick={() => handleCopy(formattedTimestamp.unix, 'Timestamp')}>
                          Copy Unix seconds
                        </button>
                      </div>
                      <div className="timestamp-item">
                        <div>
                          <div className="timestamp-item__label">Unix milliseconds</div>
                          <div className="timestamp-item__value">{formattedTimestamp.unixMs}</div>
                        </div>
                        <button className="chip" type="button" onClick={() => handleCopy(formattedTimestamp.unixMs, 'Timestamp')}>
                          Copy Unix milliseconds
                        </button>
                      </div>
                    </div>
                  </div>
                  <p className="tool-message tool-message--copy">{copyMessage}</p>
                </section>
              )}
            />
            <Route
              path="/sql"
              element={(
                <ToolCard title="SQL Formatter" description="Automatically organizes the structure and keywords of common queries.">
                  <textarea value={sqlInput} onChange={(event) => setSqlInput(event.target.value)} spellCheck={false} />
                  <div className="tool-actions">
                    <button type="button" onClick={handleSqlFormat}>Format SQL</button>
                    <button type="button" className="ghost" onClick={() => handleCopy(sqlOutput || sqlInput, 'SQL')}>Copy result</button>
                  </div>
                  <p className="tool-message">{sqlMessage}</p>
                  <pre className="code-output" aria-label="SQL syntax highlight result">
                    {sqlOutput ? sqlTokens.map((token, index) => (
                      <span key={`${token.type}-${index}`} className={`token ${token.type}`}>
                        {token.text}
                      </span>
                    )) : 'Formatted output will appear here.'}
                  </pre>
                </ToolCard>
              )}
            />
            <Route
              path="/json"
              element={(
                <ToolCard title="JSON Formatter" description="Prettify JSON, validate it quickly, and keep a copyable output.">
                  <textarea value={jsonInput} onChange={(event) => setJsonInput(event.target.value)} spellCheck={false} />
                  <div className="tool-actions">
                    <button type="button" onClick={handleJsonFormat}>Format JSON</button>
                    <button type="button" onClick={handleJsonCompress}>Compress JSON</button>
                    <button type="button" className="ghost" onClick={() => handleCopy(jsonOutput || jsonInput, 'JSON')}>Copy result</button>
                  </div>
                  <p className="tool-message">{jsonMessage}</p>
                  <pre className="code-output" aria-label="JSON syntax highlight result">
                    {jsonDisplayText
                      ? renderJsonTokens(
                        jsonTokens,
                        jsonErrorInfo?.formattedIndex ?? jsonErrorInfo?.index ?? null,
                        jsonDisplayText.length,
                      )
                      : 'Formatted JSON output will appear here.'}
                  </pre>
                </ToolCard>
              )}
            />
            <Route
              path="/diff"
              element={(
                <section className="diff-panel">
                  <div className="tool-card__header">
                    <div>
                      <h2>Text Diff</h2>
                      <p>Pair lines first, then compare word by word to see exactly what changed.</p>
                    </div>
                    <button type="button" className="chip" onClick={handleJumpNextDiff}>
                      Next difference
                    </button>
                  </div>
                  <div className="diff-editors">
                    <textarea value={leftText} onChange={(event) => setLeftText(event.target.value)} spellCheck={false} />
                    <textarea value={rightText} onChange={(event) => setRightText(event.target.value)} spellCheck={false} />
                  </div>
                  <div className="diff-output" aria-label="Word-by-word text diff result">
                    <div className={`diff-status ${isDiffMatched ? 'diff-status--match' : 'diff-status--mismatch'}`}>
                      {isDiffMatched ? 'Match result: identical' : `Match result: different (${diffRowIndexes.length} differences total)`}
                    </div>
                    <div className="diff-head">
                      <span>Original</span>
                      <span>New</span>
                    </div>
                    {diffRows.map((row, index) => (
                      <div
                        key={`${row.type}-${index}`}
                        ref={(element) => {
                          diffRowRefs.current[index] = element;
                        }}
                        className={`diff-row diff-row--${row.type} ${
                          diffRowIndexes[activeDiffPointer] === index ? 'diff-row--focus' : ''
                        }`}
                      >
                        <div className="diff-cell">
                          {row.leftTokens ? row.leftTokens.map((token, tokenIndex) => (
                            <span key={`left-${index}-${tokenIndex}`} className={token.changed ? 'word word--removed' : 'word'}>
                              {token.text}
                            </span>
                          )) : row.left || ' '}
                        </div>
                        <div className="diff-cell">
                          {row.rightTokens ? row.rightTokens.map((token, tokenIndex) => (
                            <span key={`right-${index}-${tokenIndex}`} className={token.changed ? 'word word--added' : 'word'}>
                              {token.text}
                            </span>
                          )) : row.right || ' '}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            />
            <Route path="*" element={<Navigate to="/timestamp" replace />} />
          </Routes>
        </div>
      </main>
    </HashRouter>
  );
}
