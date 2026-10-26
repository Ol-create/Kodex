// One line per request: method, path, status, duration and tenant (if resolved).
export function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const tenant = req.tenant ? ` tenant=${req.tenant.slug}` : "";
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms${tenant}`);
  });
  next();
}
