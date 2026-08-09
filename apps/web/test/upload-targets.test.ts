/**
 * UC2-036 — the customs upload target.
 *
 * Customs is the odd one out twice over: it carries no document discriminator
 * (the server routes on the filename) and it has no dry run (there is no
 * parse-without-persist endpoint). Both exceptions are load-bearing, so both are
 * pinned here — a future edit that "tidies" customs into the shape of the other
 * modules would produce a Validate button that 404s and a discriminator the
 * server silently ignores.
 */
import { describe, expect, it } from 'vitest';
import { UPLOAD_TARGETS } from '../src/panels/uploadTargets.js';

const targets = Object.entries(UPLOAD_TARGETS);

describe('upload targets', () => {
  it('names a module for every target', () => {
    for (const [key, t] of targets) {
      expect(t.module, `${key} has no module`).toBeTruthy();
    }
  });

  it('gives every discriminator-carrying module both param and value', () => {
    // A param without a value (or vice versa) posts a malformed form the server
    // rejects at upload time, not at compile time.
    for (const [key, t] of targets) {
      const anyT = t as { param?: string; value?: string };
      expect(Boolean(anyT.param) === Boolean(anyT.value), `${key} half-declares its discriminator`).toBe(true);
    }
  });

  it('declares customs with no discriminator — the server reads the filename', () => {
    const customs = UPLOAD_TARGETS.customs as { param?: string; value?: string; module: string };

    expect(customs.module).toBe('customs');
    expect(customs.param).toBeUndefined();
    expect(customs.value).toBeUndefined();
  });

  it('declares customs as having no dry run and no template', () => {
    const customs = UPLOAD_TARGETS.customs as { dryRun?: boolean; template?: boolean };

    // Both endpoints genuinely do not exist. Flipping either flag back to true
    // puts a button in the dialog that 404s.
    expect(customs.dryRun).toBe(false);
    expect(customs.template).toBe(false);
  });

  it('leaves every other module on the two-step flow', () => {
    for (const [key, t] of targets) {
      if (key === 'customs') continue;
      const anyT = t as { dryRun?: boolean; template?: boolean };
      // Undefined means default-true, which is the two-step flow.
      expect(anyT.dryRun ?? true, `${key} lost its dry run`).toBe(true);
      expect(anyT.template ?? true, `${key} lost its template`).toBe(true);
    }
  });

  it('accepts the customs file types the corpus actually holds', () => {
    // IGM/OOC/SMTP are XML, RMS lists are .txt, LEO and Shipping Bill are .xlsx.
    const accept = String((UPLOAD_TARGETS.customs as { accept?: string }).accept ?? '');
    for (const ext of ['.xml', '.txt', '.xlsx']) {
      expect(accept, `customs cannot pick ${ext}`).toContain(ext);
    }
  });
});
