// A hidden one-line prompt for secrets typed at an interactive terminal (`keys add`). Nothing is
// echoed; the prompt goes to stderr so stdout stays clean for --json.

/** Read one line from an interactive stdin without echoing it. Ctrl+C or Ctrl+D aborts. */
export function readHiddenLine(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.reject(new Error("no interactive terminal to read the secret from"));
  process.stderr.write(prompt);
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const wasRaw = stdin.isRaw;
    const finish = (err: Error | null) => {
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") return finish(null);
        if (ch === "\u0003" || ch === "\u0004") return finish(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.resume();
  });
}
