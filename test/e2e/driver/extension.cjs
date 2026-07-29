'use strict';

const fs = require('node:fs');

const E2E_RESULT_PATH_KEY = 'PROJECT_LANES_E2E_RESULT_PATH';
const E2E_RUN_KEY = 'PROJECT_LANES_E2E_RUN';
const E2E_SUITE_PATH_KEY = 'PROJECT_LANES_E2E_SUITE_PATH';

const requiredEnvironmentValue = (environment, key) => {
  const value = environment[key];
  if (!value) throw new Error(`Missing E2E environment variable: ${key}`);
  return value;
};

const serializeError = (error) => ({
  message: error instanceof Error ? error.message : String(error),
  stack: error instanceof Error ? error.stack : undefined,
});

const writeResultMarker = ({ fileSystem, markerPath, processApi, result }) => {
  const temporaryMarkerPath = `${markerPath}.tmp-${processApi.pid}`;
  fileSystem.writeFileSync(temporaryMarkerPath, JSON.stringify(result), {
    encoding: 'utf8',
    flag: 'wx',
  });
  let publishError;
  try {
    fileSystem.linkSync(temporaryMarkerPath, markerPath);
  } catch (error) {
    publishError = error;
  }
  try {
    fileSystem.unlinkSync(temporaryMarkerPath);
  } catch (cleanupError) {
    if (publishError) {
      throw new AggregateError(
        [publishError, cleanupError],
        'E2E marker publish and cleanup failed',
      );
    }
    throw cleanupError;
  }
  if (publishError) throw publishError;
};

const runDriver = async ({
  environment = process.env,
  fileSystem = fs,
  loadSuite = (suitePath) => require(suitePath),
  processApi = process,
  vscodeApi = require('vscode'),
} = {}) => {
  let driverError;

  try {
    const markerPath = requiredEnvironmentValue(environment, E2E_RESULT_PATH_KEY);
    const suitePath = requiredEnvironmentValue(environment, E2E_SUITE_PATH_KEY);
    const resultIdentity = JSON.parse(requiredEnvironmentValue(environment, E2E_RUN_KEY));
    let result;

    try {
      let message;
      const suite = loadSuite(suitePath);
      await suite.run({
        environment,
        vscodeApi,
        log(value) {
          message = value;
        },
      });
      result = {
        ...resultIdentity,
        status: 'PASS',
        message: message ?? `E2E PASS: ${resultIdentity.scenario} (${resultIdentity.phase})`,
      };
    } catch (error) {
      result = {
        ...resultIdentity,
        status: 'FAIL',
        error: serializeError(error),
      };
    }

    writeResultMarker({ fileSystem, markerPath, processApi, result });
  } catch (error) {
    driverError = error;
  }

  try {
    await vscodeApi.commands.executeCommand('workbench.action.quit');
  } catch (quitError) {
    if (driverError) {
      throw new AggregateError([driverError, quitError], 'E2E driver shutdown failed');
    }
    throw quitError;
  }
  if (driverError) throw driverError;
};

const activate = () => runDriver();
const deactivate = () => {};

module.exports = { activate, deactivate, runDriver };
