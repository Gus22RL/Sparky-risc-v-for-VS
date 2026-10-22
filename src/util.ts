import * as path from 'path';

export type NumberFormat = 'hex' | 'decimal' | 'both';

/** Key used to compare file paths coming from VS Code and from RARS. */
export function pathKey(p: string): string {
  const n = path.normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

export function hex32(n: number): string {
  return '0x' + (n >>> 0).toString(16).padStart(8, '0');
}

/** Formats a register value that the bridge sent as a signed decimal string. */
export function formatInt(valueDec: string, rv64: boolean, mode: NumberFormat): string {
  const bits = rv64 ? 64 : 32;
  const v = BigInt(valueDec);
  const hex = '0x' + BigInt.asUintN(bits, v).toString(16).padStart(bits / 4, '0');
  const dec = BigInt.asIntN(bits, v).toString();
  if (mode === 'hex') return hex;
  if (mode === 'decimal') return dec;
  return `${hex}  (${dec})`;
}

export function formatFloatReg(valueDec: string, f32: string | undefined, f64: string | undefined, mode: NumberFormat): string {
  const v = BigInt.asUintN(64, BigInt(valueDec));
  const upperZero = v >> 32n === 0n;
  const hex = '0x' + v.toString(16).padStart(upperZero ? 8 : 16, '0');
  const asFloat = upperZero ? f32 : f64;
  if (mode === 'decimal') return asFloat ?? hex;
  if (mode === 'hex') return hex;
  return asFloat !== undefined ? `${hex}  (${asFloat})` : hex;
}

export function utf8Bytes(s: string): number[] {
  return Array.from(Buffer.from(s, 'utf8'));
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

export function nonce(): string {
  let t = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
  return t;
}
