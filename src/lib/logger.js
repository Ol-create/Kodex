// Tiny structured logger. "json" writes one JSON object per line (what log
// collectors such as CloudWatch expect); "text" is easier to read locally.
// LOG_FORMAT picks one; production defaults to json.
export function createLogger({ format = "text", write = (line, level) => (level === "error" ? console.error : console.log)(line) } = {}) {
  const log = (level) => (msg, fields = {}) => {
    if (format === "json") {
      write(JSON.stringify({ time: new Date().toISOString(), level, msg, ...serialize(fields) }), level);
    } else {
      const extra = Object.entries(serialize(fields))
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      write(extra ? `${msg} ${extra}` : msg, level);
    }
  };
  return { info: log("info"), warn: log("warn"), error: log("error") };
}

// Errors don't JSON.stringify; keep what helps debugging.
function serialize(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    out[k] = v instanceof Error ? { name: v.name, message: v.message, code: v.code, stack: v.stack } : v;
  }
  return out;
}

export const logger = createLogger({
  format: process.env.LOG_FORMAT ?? (process.env.NODE_ENV === "production" ? "json" : "text"),
});
