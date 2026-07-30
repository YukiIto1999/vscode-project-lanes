import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type { AbsolutePath } from '../../foundation/model';

vi.mock('vscode', () => ({}));

import { createDirectoryAdapter } from './workspace';

describe('createDirectoryAdapter', () => {
  let temporaryDirectory: string;

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(
      nodePath.join(os.tmpdir(), 'proj-lanes-directory-adapter-'),
    );
  });

  afterEach(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('symlink 化された既存 anchor をディレクトリとして受理しない', () => {
    const externalDirectory = nodePath.join(temporaryDirectory, 'external');
    const anchor = nodePath.join(temporaryDirectory, '.lanes-root');
    fs.mkdirSync(externalDirectory);
    fs.symlinkSync(externalDirectory, anchor);

    expect(createDirectoryAdapter().ensureDirectory(anchor as AbsolutePath)).toBe(false);
    expect(fs.lstatSync(anchor).isSymbolicLink()).toBe(true);
  });
});
