const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const subject = (() => {
  try {
    return require('./checksum-vsix.cjs');
  } catch {
    return {};
  }
})();

const createArtifact = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'checksum-vsix-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const artifactPath = path.join(directory, 'project-lanes-linux-x64-0.1.12.vsix');
  fs.writeFileSync(artifactPath, Buffer.from('release artifact bytes\n'));
  return artifactPath;
};

test('writes a GNU sha256sum-compatible checksum beside the artifact', (t) => {
  assert.equal(typeof subject.writeChecksum, 'function');
  const artifactPath = createArtifact(t);
  const expectedHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(artifactPath))
    .digest('hex');

  const checksumPath = subject.writeChecksum(artifactPath);

  assert.equal(checksumPath, `${artifactPath}.sha256`);
  assert.equal(
    fs.readFileSync(checksumPath, 'utf8'),
    `${expectedHash}  ${path.basename(artifactPath)}\n`,
  );
  const checked = spawnSync('sha256sum', ['--check', path.basename(checksumPath)], {
    cwd: path.dirname(artifactPath),
    encoding: 'utf8',
  });
  assert.equal(checked.status, 0, checked.stderr);
});

test('verifies an unchanged artifact', (t) => {
  const artifactPath = createArtifact(t);
  const checksumPath = subject.writeChecksum(artifactPath);

  assert.deepEqual(subject.verifyChecksum(artifactPath, checksumPath), {
    artifactName: path.basename(artifactPath),
    checksumPath,
  });
});

test('rejects a checksum for a different filename', (t) => {
  const artifactPath = createArtifact(t);
  const checksumPath = `${artifactPath}.sha256`;
  fs.writeFileSync(checksumPath, `${'0'.repeat(64)}  other.vsix\n`);

  assert.throws(
    () => subject.verifyChecksum(artifactPath, checksumPath),
    /checksum filename.*other\.vsix/i,
  );
});

test('rejects malformed checksum files', (t) => {
  const artifactPath = createArtifact(t);
  const checksumPath = `${artifactPath}.sha256`;

  for (const contents of [
    'not-a-checksum\n',
    `${'0'.repeat(64)} *${path.basename(artifactPath)}\n`,
    `${'0'.repeat(64)}  ${path.basename(artifactPath)}\nextra\n`,
  ]) {
    fs.writeFileSync(checksumPath, contents);
    assert.throws(
      () => subject.verifyChecksum(artifactPath, checksumPath),
      /GNU SHA256 checksum line/i,
    );
  }
});

test('rejects an artifact whose bytes changed', (t) => {
  const artifactPath = createArtifact(t);
  const checksumPath = subject.writeChecksum(artifactPath);
  fs.appendFileSync(artifactPath, 'tampered');

  assert.throws(() => subject.verifyChecksum(artifactPath, checksumPath), /SHA256 mismatch/i);
});
