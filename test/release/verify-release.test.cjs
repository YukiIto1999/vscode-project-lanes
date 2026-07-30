const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { verifyRelease } = require('./verify-release.cjs');

const git = (root, ...args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

const writeReleaseFiles = (
  root,
  { version = '0.1.13', lockVersion = version, duplicate = false } = {},
) => {
  writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'project-lanes', version }, null, 2)}\n`,
  );
  writeFileSync(
    path.join(root, 'package-lock.json'),
    `${JSON.stringify(
      {
        name: 'project-lanes',
        version: lockVersion,
        lockfileVersion: 3,
        packages: {
          '': { name: 'project-lanes', version: lockVersion },
        },
      },
      null,
      2,
    )}\n`,
  );
  const currentSection = `## [${version}] - 2026-07-30\n\n### Fixed\n\n- Release candidate.\n`;
  writeFileSync(
    path.join(root, 'CHANGELOG.md'),
    `# Changelog\n\n${currentSection}\n${duplicate ? `${currentSection}\n` : ''}## [0.1.12] - 2026-07-08\n\n### Fixed\n\n- Previous release.\n`,
  );
};

const createReleaseRepository = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'project-lanes-release-test-'));
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.name', 'Release Test');
  git(root, 'config', 'user.email', 'release-test@example.invalid');
  writeReleaseFiles(root, { version: '0.1.12' });
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'previous release');
  git(root, 'tag', 'v0.1.12');

  writeReleaseFiles(root);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'candidate release');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(root, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
  return root;
};

test('release candidate matches package metadata, changelog, main, and develop', () => {
  const root = createReleaseRepository();

  assert.deepEqual(verifyRelease(root), {
    version: '0.1.13',
    tag: 'v0.1.13',
    previousVersion: '0.1.12',
    releaseNotes: '### Fixed\n\n- Release candidate.',
  });
});

test('rejects a package-lock root version mismatch', () => {
  const root = createReleaseRepository();
  writeReleaseFiles(root, { lockVersion: '0.1.12' });

  assert.throws(
    () => verifyRelease(root),
    /package-lock\.json.*0\.1\.12.*package\.json.*0\.1\.13/i,
  );
});

test('rejects duplicate changelog sections for the candidate version', () => {
  const root = createReleaseRepository();
  writeReleaseFiles(root, { duplicate: true });

  assert.throws(() => verifyRelease(root), /CHANGELOG.*0\.1\.13.*exactly once/i);
});

test('rejects a candidate that is not origin main HEAD', () => {
  const root = createReleaseRepository();
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD^');

  assert.throws(() => verifyRelease(root), /HEAD.*origin\/main/i);
});

test('rejects a candidate outside origin develop history', () => {
  const root = createReleaseRepository();
  git(root, 'update-ref', 'refs/remotes/origin/develop', 'HEAD^');

  assert.throws(() => verifyRelease(root), /HEAD.*ancestor.*origin\/develop/i);
});

test('rejects an existing candidate tag that points to another commit', () => {
  const root = createReleaseRepository();
  git(root, 'tag', 'v0.1.13', 'HEAD^');

  assert.throws(() => verifyRelease(root), /v0\.1\.13.*HEAD/i);
});

test('accepts an existing candidate tag only when it points to HEAD', () => {
  const root = createReleaseRepository();
  git(root, 'tag', 'v0.1.13');

  assert.equal(verifyRelease(root).tag, 'v0.1.13');
});

test('ignores a newer tag that is not reachable from the candidate HEAD', () => {
  const root = createReleaseRepository();
  git(root, 'tag', 'v0.1.13');
  writeFileSync(path.join(root, 'later-release.txt'), 'later\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'later release');
  git(root, 'tag', 'v0.1.14');
  git(root, 'checkout', '--detach', 'v0.1.13');

  assert.equal(verifyRelease(root).previousVersion, '0.1.12');
});

test('rejects a version that is not newer than the previous release', () => {
  const root = createReleaseRepository();
  writeReleaseFiles(root, { version: '0.1.11' });

  assert.throws(() => verifyRelease(root), /0\.1\.11.*newer.*0\.1\.12/i);
});
