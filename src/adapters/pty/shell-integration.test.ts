import { describe, expect, it } from 'vitest';
import type { AbsolutePath } from '../../foundation/model';
import { detectShellKind, planShellIntegration } from './shell-integration';

const extensionPath = '/ext' as AbsolutePath;

describe('detectShellKind', () => {
  it.each([
    ['/bin/bash', 'bash'],
    ['/usr/bin/bash', 'bash'],
    ['/usr/bin/zsh', 'zsh'],
    ['/usr/local/bin/zsh', 'zsh'],
    ['/usr/bin/fish', 'unsupported'],
    ['/usr/bin/pwsh', 'unsupported'],
    ['/bin/sh', 'unsupported'],
  ] as const)('%s → %s', (path, expected) => {
    expect(detectShellKind(path)).toBe(expected);
  });
});

describe('planShellIntegration', () => {
  it('bash: --rcfile を統合スクリプトに向ける', () => {
    const plan = planShellIntegration('/bin/bash', { PATH: '/usr/bin' }, extensionPath);
    expect(plan.kind).toBe('bash');
    expect(plan.args).toEqual(['--rcfile', '/ext/resources/shell-integration/lanes-bash.sh']);
    expect(plan.env).toEqual({ PATH: '/usr/bin' });
  });

  it('zsh: ZDOTDIR を切替え、元 ZDOTDIR を退避', () => {
    const plan = planShellIntegration(
      '/usr/bin/zsh',
      { PATH: '/usr/bin', HOME: '/home/u', ZDOTDIR: '/home/u/zsh' },
      extensionPath,
    );
    expect(plan.kind).toBe('zsh');
    expect(plan.args).toEqual([]);
    expect(plan.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      ZDOTDIR: '/ext/resources/shell-integration/zsh',
      LANES_ORIG_ZDOTDIR: '/home/u/zsh',
    });
  });

  it('zsh: ZDOTDIR 未設定なら HOME を退避', () => {
    const plan = planShellIntegration(
      '/usr/bin/zsh',
      { PATH: '/usr/bin', HOME: '/home/u' },
      extensionPath,
    );
    expect(plan.env.LANES_ORIG_ZDOTDIR).toBe('/home/u');
    expect(plan.env.ZDOTDIR).toBe('/ext/resources/shell-integration/zsh');
  });

  it('zsh: HOME も ZDOTDIR も無ければ空文字を退避', () => {
    const plan = planShellIntegration('/usr/bin/zsh', { PATH: '/usr/bin' }, extensionPath);
    expect(plan.env.LANES_ORIG_ZDOTDIR).toBe('');
  });

  it('未対応シェルは args/env を変更しない', () => {
    const baseEnv = { PATH: '/usr/bin', HOME: '/home/u' };
    const plan = planShellIntegration('/usr/bin/fish', baseEnv, extensionPath);
    expect(plan.kind).toBe('unsupported');
    expect(plan.args).toEqual([]);
    expect(plan.env).toEqual(baseEnv);
  });
});
