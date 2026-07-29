'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_CACHE_PATH = '/tmp/vscode-project-lanes-vscode-test-cache';
const VSCODE_VERSION = '1.101.0';
const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
const processCleanupRegistries = new WeakMap();

const createProcessCleanupRegistry = (
  processApi,
  {
    reportCleanupError = (error) => {
      console.error('E2E cleanup failed:', error);
    },
  } = {},
) => {
  const activeCleanups = new Set();
  const cleanupAll = () => {
    for (const cleanup of activeCleanups) {
      try {
        cleanup();
      } catch (error) {
        reportCleanupError(error);
      }
    }
  };

  processApi.once('exit', cleanupAll);
  processApi.once('SIGTERM', () => {
    try {
      cleanupAll();
    } finally {
      processApi.kill(processApi.pid, 'SIGTERM');
    }
  });
  return activeCleanups;
};

const getProcessCleanupRegistry = (processApi) => {
  const existingRegistry = processCleanupRegistries.get(processApi);
  if (existingRegistry) return existingRegistry;

  const activeCleanups = createProcessCleanupRegistry(processApi);
  processCleanupRegistries.set(processApi, activeCleanups);
  return activeCleanups;
};

const buildRunTestsOptions = ({
  scenario,
  workspacePath,
  userDataDir,
  extensionsDir,
  environment = process.env,
}) => ({
  version: VSCODE_VERSION,
  cachePath: environment.PROJECT_LANES_VSCODE_TEST_CACHE || DEFAULT_CACHE_PATH,
  extensionDevelopmentPath,
  extensionTestsPath: scenario.extensionTestsPath,
  launchArgs: [
    workspacePath,
    '--disable-extensions',
    '--user-data-dir',
    userDataDir,
    '--extensions-dir',
    extensionsDir,
  ],
});

const runScenario = async (
  scenario,
  {
    runTests,
    fileSystem = fs,
    temporaryDirectory = os.tmpdir(),
    environment = process.env,
    processApi = process,
  },
) => {
  const activeCleanups = getProcessCleanupRegistry(processApi);
  const temporaryRoot = fileSystem.mkdtempSync(
    path.join(temporaryDirectory, `project-lanes-e2e-${scenario.name}-`),
  );
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    fileSystem.rmSync(temporaryRoot, { recursive: true, force: true });
    cleaned = true;
    activeCleanups.delete(cleanup);
  };
  activeCleanups.add(cleanup);

  let scenarioFailed = false;
  let scenarioError;
  try {
    const userDataDir = path.join(temporaryRoot, 'user-data');
    const extensionsDir = path.join(temporaryRoot, 'extensions');
    const workspaceDir = path.join(temporaryRoot, 'workspace');
    const workspacePath = path.join(workspaceDir, path.basename(scenario.workspaceFixture));

    fileSystem.mkdirSync(userDataDir);
    fileSystem.mkdirSync(extensionsDir);
    fileSystem.mkdirSync(workspaceDir);
    fileSystem.copyFileSync(scenario.workspaceFixture, workspacePath);

    await runTests(
      buildRunTestsOptions({
        scenario,
        workspacePath,
        userDataDir,
        extensionsDir,
        environment,
      }),
    );
  } catch (error) {
    scenarioFailed = true;
    scenarioError = error;
  }

  try {
    cleanup();
  } catch (cleanupError) {
    if (scenarioFailed) {
      throw new AggregateError(
        [scenarioError, cleanupError],
        `E2E scenario and cleanup failed: ${scenario.name}`,
      );
    }
    throw cleanupError;
  }

  if (scenarioFailed) throw scenarioError;
};

module.exports = { buildRunTestsOptions, createProcessCleanupRegistry, runScenario };
