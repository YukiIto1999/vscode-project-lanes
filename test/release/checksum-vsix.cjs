const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const checksumPathFor = (artifactPath) => `${artifactPath}.sha256`;

const sha256File = (artifactPath) =>
  crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');

const formatChecksumLine = (hash, artifactName) => `${hash}  ${artifactName}\n`;

const writeChecksum = (artifactPath, checksumPath = checksumPathFor(artifactPath)) => {
  const line = formatChecksumLine(sha256File(artifactPath), path.basename(artifactPath));
  fs.writeFileSync(checksumPath, line);
  return checksumPath;
};

const parseChecksumLine = (contents) => {
  const match = contents.match(/^([a-f0-9]{64})  ([^\r\n]+)\n$/);
  if (!match) {
    throw new Error('Checksum file must contain exactly one GNU SHA256 checksum line');
  }
  return { hash: match[1], artifactName: match[2] };
};

const verifyChecksum = (artifactPath, checksumPath = checksumPathFor(artifactPath)) => {
  const expected = parseChecksumLine(fs.readFileSync(checksumPath, 'utf8'));
  const artifactName = path.basename(artifactPath);
  if (expected.artifactName !== artifactName) {
    throw new Error(`Checksum filename is ${expected.artifactName}, expected ${artifactName}`);
  }

  const actualHash = sha256File(artifactPath);
  if (actualHash !== expected.hash) {
    throw new Error(`SHA256 mismatch for ${artifactName}`);
  }

  return { artifactName, checksumPath };
};

const runCli = () => {
  const [command, artifactArgument, checksumArgument, ...rest] = process.argv.slice(2);
  if (!['write', 'verify'].includes(command) || !artifactArgument || rest.length > 0) {
    throw new Error('Usage: node checksum-vsix.cjs <write|verify> <artifact.vsix> [checksum]');
  }

  const artifactPath = path.resolve(artifactArgument);
  const checksumPath = checksumArgument
    ? path.resolve(checksumArgument)
    : checksumPathFor(artifactPath);

  if (command === 'write') {
    writeChecksum(artifactPath, checksumPath);
    process.stdout.write(`${checksumPath}\n`);
    return;
  }

  const result = verifyChecksum(artifactPath, checksumPath);
  process.stdout.write(`Verified ${result.artifactName}\n`);
};

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  checksumPathFor,
  formatChecksumLine,
  parseChecksumLine,
  verifyChecksum,
  writeChecksum,
};
