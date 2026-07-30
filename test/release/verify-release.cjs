const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const readJson = (filePath) => JSON.parse(readFileSync(filePath, 'utf8'));

const runGit = (root, args, options = {}) => {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (options.allowFailure) {
      return undefined;
    }
    const stderr = error.stderr?.trim();
    throw new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
};

const parseVersion = (version, source) => {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) {
    throw new Error(`${source} version must be a stable semantic version, received ${version}`);
  }
  return match.slice(1).map(Number);
};

const compareVersions = (left, right) => {
  const leftParts = parseVersion(left, 'candidate');
  const rightParts = parseVersion(right, 'previous release');
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
};

const extractReleaseNotes = (changelog, version) => {
  const escapedVersion = version.replaceAll('.', '\\.');
  const heading = new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'gm');
  const matches = [...changelog.matchAll(heading)];
  if (matches.length !== 1) {
    throw new Error(`CHANGELOG section for ${version} must occur exactly once`);
  }

  const notesStart = matches[0].index + matches[0][0].length;
  const remaining = changelog.slice(notesStart);
  const nextHeading = remaining.search(/^## \[/m);
  const notes = remaining.slice(0, nextHeading === -1 ? undefined : nextHeading).trim();
  if (!notes) {
    throw new Error(`CHANGELOG section for ${version} must contain release notes`);
  }
  return notes;
};

const resolvePreviousVersion = (root, candidateVersion) => {
  const tags = runGit(root, ['tag', '--merged', 'HEAD', '--list', 'v[0-9]*', '--sort=-v:refname'])
    .split('\n')
    .filter(Boolean);
  const previousTag = tags.find((tag) => tag !== `v${candidateVersion}`);
  if (!previousTag) {
    throw new Error('A previous vX.Y.Z release tag is required');
  }
  const previousVersion = previousTag.slice(1);
  parseVersion(previousVersion, 'previous release');
  if (compareVersions(candidateVersion, previousVersion) <= 0) {
    throw new Error(
      `Candidate version ${candidateVersion} must be newer than previous release ${previousVersion}`,
    );
  }
  return previousVersion;
};

const verifyRelease = (root = process.cwd()) => {
  const packageJson = readJson(path.join(root, 'package.json'));
  const packageLock = readJson(path.join(root, 'package-lock.json'));
  const version = packageJson.version;
  parseVersion(version, 'package.json');

  const lockVersions = [packageLock.version, packageLock.packages?.['']?.version];
  if (lockVersions.some((lockVersion) => lockVersion !== version)) {
    throw new Error(
      `package-lock.json root version ${lockVersions.join('/')} must match package.json ${version}`,
    );
  }

  const releaseNotes = extractReleaseNotes(
    readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'),
    version,
  );
  const head = runGit(root, ['rev-parse', 'HEAD']);
  const main = runGit(root, ['rev-parse', 'refs/remotes/origin/main']);
  if (head !== main) {
    throw new Error(`HEAD ${head} must equal origin/main ${main}`);
  }

  const develop = runGit(root, ['rev-parse', 'refs/remotes/origin/develop']);
  const isDevelopAncestor = runGit(
    root,
    ['merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/develop'],
    { allowFailure: true },
  );
  if (isDevelopAncestor === undefined) {
    throw new Error(`HEAD ${head} must be an ancestor of origin/develop ${develop}`);
  }

  const tag = `v${version}`;
  const tagCommit = runGit(root, ['rev-parse', '--verify', `${tag}^{commit}`], {
    allowFailure: true,
  });
  if (tagCommit !== undefined && tagCommit !== head) {
    throw new Error(`${tag} must point to HEAD ${head}, received ${tagCommit}`);
  }

  const previousVersion = resolvePreviousVersion(root, version);
  return { version, tag, previousVersion, releaseNotes };
};

const parseArguments = (arguments_) => {
  if (arguments_.length === 0) {
    return {};
  }
  if (arguments_.length === 2 && arguments_[0] === '--notes-file') {
    return { notesFile: arguments_[1] };
  }
  throw new Error('Usage: node test/release/verify-release.cjs [--notes-file <path>]');
};

const main = () => {
  const { notesFile } = parseArguments(process.argv.slice(2));
  const release = verifyRelease();
  if (notesFile) {
    writeFileSync(notesFile, `${release.releaseNotes}\n`);
  }
  process.stdout.write(
    `Verified ${release.tag} against origin/main and origin/develop (previous v${release.previousVersion})\n`,
  );
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  compareVersions,
  extractReleaseNotes,
  verifyRelease,
};
