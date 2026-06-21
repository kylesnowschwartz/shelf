// Output discipline for the shelf CLI. The PRIMARY consumer is an AI agent, so
// `--json` to stdout is the product; progress and errors go to stderr; exit
// codes are documented and stable. (clig.dev §"AI Agent Integration".)

/** Documented exit codes — agents map these to failure modes. */
export const EXIT = {
  OK: 0,
  USAGE: 2, // bad flags / arguments
  NO_DATA: 3, // an input the command needs is empty (e.g. no candidates)
  NOT_BUILT: 4, // a required prior artifact is missing (run an earlier command)
  NETWORK: 5, // upstream API failed after retries
};

const isTTY = () => process.stdout.isTTY === true;

/** Progress / status — always stderr, so stdout stays a clean data channel. */
export function log(msg) {
  process.stderr.write(`${msg}\n`);
}

/** Machine-readable structured error to stderr, then exit. */
export function fail(code, message, extra = {}) {
  const payload = { error: { code: codeName(code), message, ...extra } };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exit(code);
}

function codeName(code) {
  return Object.keys(EXIT).find((k) => EXIT[k] === code) || 'ERROR';
}

/**
 * Emit the command's result on stdout. The agent is the primary consumer, so
 * JSON is the default whenever stdout is piped (not a TTY). A human at a real
 * terminal gets the rendered text; `--plain` forces compact text; `--json`
 * forces JSON anywhere.
 */
export function emit(data, opts = {}, renderText) {
  const wantJson = opts.json || (!isTTY() && !opts.plain);
  if (wantJson || !renderText) {
    process.stdout.write(`${JSON.stringify(data, null, opts.plain ? 0 : 2)}\n`);
    return;
  }
  process.stdout.write(`${renderText(data, !!opts.plain)}\n`);
}

/** Simple ANSI, only when stdout is a real terminal. */
export const color = {
  on: isTTY(),
  dim: (s) => (isTTY() ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (isTTY() ? `\x1b[1m${s}\x1b[0m` : s),
  accent: (s) => (isTTY() ? `\x1b[38;5;203m${s}\x1b[0m` : s),
};
