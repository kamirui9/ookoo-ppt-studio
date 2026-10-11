import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const ROOT = path.resolve(__dirname, '../..');
const DATA = process.env.LAUNCH_DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
// 测试使用独立配置文件，避免读取真实模型凭据。
const envFile = process.env.LAUNCH_ENV_FILE || path.join(ROOT, '.env');
if (!fs.existsSync(envFile)) {
  let value = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  value = value.replace(/^SESSION_SECRET=$/m, `SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}`);
  fs.writeFileSync(envFile, value, { mode: 0o600 });
}
function config(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  for (const k of Object.keys(out)) if (process.env[k] !== undefined) out[k] = process.env[k];
  return out;
}
function safeError(err: unknown): string {
  let msg = err instanceof Error ? err.message : String(err);
  for (const [k, value] of Object.entries(config())) {
    if (/KEY|TOKEN|SECRET|PASSWORD/.test(k) && value) msg = msg.split(value).join('[已隐藏]');
  }
  return msg.replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]').replace(/sk-[A-Za-z0-9_-]+/g, '[已隐藏]');
}
export { ROOT, DATA, config, safeError };
