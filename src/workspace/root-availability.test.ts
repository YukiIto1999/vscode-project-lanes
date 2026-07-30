import { describe, expect, it, vi } from 'vitest';
import type { AbsolutePath } from '../foundation/model';
import { createLaneRootAvailabilityInspector } from './root-availability';

const rootPath = '/repo/web' as AbsolutePath;
const readExecuteAccessMode = 0b101;

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

const createFileSystem = ({
  isDirectory = true,
  statError,
  accessError,
}: {
  readonly isDirectory?: boolean;
  readonly statError?: unknown;
  readonly accessError?: unknown;
} = {}) => {
  const stat = vi.fn(() => {
    if (statError !== undefined) throw statError;
    return { isDirectory: () => isDirectory };
  });
  const access = vi.fn(() => {
    if (accessError !== undefined) throw accessError;
  });
  return { stat, access, readExecuteAccessMode };
};

describe('createLaneRootAvailabilityInspector', () => {
  it('read と execute が可能な directory を available と判定する', () => {
    const fileSystem = createFileSystem();
    const inspector = createLaneRootAvailabilityInspector(fileSystem);

    expect(inspector.inspect(rootPath)).toBe('available');
    expect(fileSystem.stat).toHaveBeenCalledWith(rootPath);
    expect(fileSystem.access).toHaveBeenCalledWith(rootPath, readExecuteAccessMode);
  });

  it('directory ではない path を inaccessible と判定して access しない', () => {
    const fileSystem = createFileSystem({ isDirectory: false });
    const inspector = createLaneRootAvailabilityInspector(fileSystem);

    expect(inspector.inspect(rootPath)).toBe('inaccessible');
    expect(fileSystem.access).not.toHaveBeenCalled();
  });

  it.each(['ENOENT', 'ENOTDIR'])('stat の %s を missing と判定する', (code) => {
    const inspector = createLaneRootAvailabilityInspector({
      ...createFileSystem({ statError: errno(code) }),
      readExecuteAccessMode,
    });

    expect(inspector.inspect(rootPath)).toBe('missing');
  });

  it.each(['EACCES', 'EPERM'])('stat の %s を inaccessible と判定する', (code) => {
    const inspector = createLaneRootAvailabilityInspector({
      ...createFileSystem({ statError: errno(code) }),
      readExecuteAccessMode,
    });

    expect(inspector.inspect(rootPath)).toBe('inaccessible');
  });

  it('stat の未知エラーを inaccessible と判定する', () => {
    const inspector = createLaneRootAvailabilityInspector(
      createFileSystem({ statError: new Error('I/O failure') }),
    );

    expect(inspector.inspect(rootPath)).toBe('inaccessible');
  });

  it.each([
    ['ENOENT', 'missing'],
    ['ENOTDIR', 'missing'],
    ['EACCES', 'inaccessible'],
    ['EPERM', 'inaccessible'],
    ['EIO', 'inaccessible'],
  ] as const)('stat 後の access %s を %s と判定する', (code, expected) => {
    const inspector = createLaneRootAvailabilityInspector(
      createFileSystem({ accessError: errno(code) }),
    );

    expect(inspector.inspect(rootPath)).toBe(expected);
  });

  it('非 Error の例外を inaccessible と判定する', () => {
    const inspector = createLaneRootAvailabilityInspector(
      createFileSystem({ accessError: 'access failed' }),
    );

    expect(inspector.inspect(rootPath)).toBe('inaccessible');
  });
});
