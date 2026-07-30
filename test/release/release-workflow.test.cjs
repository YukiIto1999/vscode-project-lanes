const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflow = readFileSync(
  path.resolve(__dirname, '../../.github/workflows/release.yml'),
  'utf8',
);
const continuousIntegration = readFileSync(
  path.resolve(__dirname, '../../.github/workflows/ci.yml'),
  'utf8',
);

const indexOf = (fragment) => {
  const index = workflow.indexOf(fragment);
  assert.notEqual(index, -1, `release workflow must contain ${JSON.stringify(fragment)}`);
  return index;
};

test('serializes release runs without cancelling an in-flight publish', () => {
  assert.match(workflow, /concurrency:\s*\n\s+group:\s*release\s*\n\s+cancel-in-progress:\s*false/);
});

test('rejects a manually dispatched release outside main', () => {
  assert.match(
    workflow,
    /github\.event_name != 'workflow_dispatch' \|\| github\.ref == 'refs\/heads\/main'/,
  );
});

test('runs source and installed-artifact verification before publishing', () => {
  const npmCi = indexOf('npm ci');
  const releaseState = indexOf('npm run verify:release');
  const check = indexOf('npm run check');
  const unit = indexOf('npm test');
  const releaseTests = indexOf('npm run test:release');
  const build = indexOf('npm run build');
  const sourceE2e = indexOf('npm run test:e2e');
  const verifyVsix = indexOf('npm run verify:vsix');
  const installedE2e = indexOf('npm run test:e2e:vsix');
  const publishVsix = indexOf('npm run publish:vsix');

  assert.ok(
    npmCi < releaseState &&
      releaseState < check &&
      check < unit &&
      unit < releaseTests &&
      releaseTests < build &&
      build < sourceE2e &&
      sourceE2e < verifyVsix &&
      verifyVsix < installedE2e &&
      installedE2e < publishVsix,
  );
});

test('packages a Linux x64 VSIX once and publishes that exact path', () => {
  assert.match(workflow, /SOURCE_DATE_EPOCH/);
  assert.match(workflow, /--target linux-x64/);
  assert.match(workflow, /--packagePath "\$VSIX_PATH" --skip-duplicate/);
  assert.doesNotMatch(workflow, /\bnpx\s+@vscode\/vsce\b/);
});

test('uses a draft release as the retry checkpoint', () => {
  assert.match(workflow, /inspect-checkpoint\.cjs/);
  assert.match(workflow, /gh release download/);
  assert.match(workflow, /gh release create[\s\S]*--draft/);
  assert.match(workflow, /gh release edit[\s\S]*--draft=false/);
});

test('treats only a GitHub API 404 as an uncreated release', () => {
  assert.match(workflow, /gh api --include/);
  assert.match(workflow, /HTTP_STATUS/);
  assert.match(workflow, /404\)/);
  assert.doesNotMatch(workflow, /if ! RELEASE_JSON=.*gh release view/);
});

test('repackages a trusted reference before accepting a draft VSIX', () => {
  assert.match(workflow, /steps\.state\.outputs\.reuse == 'true'[\s\S]*REFERENCE_VSIX_PATH/);
  assert.match(
    workflow,
    /npm run verify:vsix -- "\$VSIX_PATH" --reference "\$REFERENCE_VSIX_PATH"/,
  );
});

test('rechecks the local checksum after actions and immediately before Marketplace publish', () => {
  const upload = indexOf('actions/upload-artifact@');
  const finalChecksum = workflow.lastIndexOf('npm run checksum:vsix -- verify');
  const publish = indexOf('npm run publish:vsix');

  assert.ok(upload < finalChecksum && finalChecksum < publish);
});

test('keeps generated release notes outside the repository', () => {
  assert.match(workflow, /\$RUNNER_TEMP\/release-notes\.md/);
  assert.doesNotMatch(workflow, />\s*\.release-notes\.md/);
});

test('runs release contract tests on develop before a release reaches main', () => {
  const unit = continuousIntegration.indexOf('npm test');
  const release = continuousIntegration.indexOf('npm run test:release');
  const build = continuousIntegration.indexOf('npm run build');

  assert.ok(unit !== -1 && release !== -1 && build !== -1 && unit < release && release < build);
});

test('pins every GitHub-authored action to an immutable commit', () => {
  for (const document of [continuousIntegration, workflow]) {
    const actionReferences = [...document.matchAll(/uses:\s+(actions\/[\w-]+)@([^\s]+)/g)];
    assert.ok(actionReferences.length > 0);
    for (const [, action, revision] of actionReferences) {
      assert.match(revision, /^[a-f0-9]{40}$/, `${action} must use a full commit SHA`);
    }
  }
});
