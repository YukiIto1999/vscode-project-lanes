'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const E2E_PICK_REPLACEMENT_FOLDER_COMMAND = 'projectLanes.e2e.pickReplacementFolder';
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

const registerReplacementPickerCommand = ({ resultIdentity, vscodeApi }) => {
  if (
    resultIdentity.scenario !== 'missing-lane-recovery' ||
    resultIdentity.phase !== 'locate-and-reconcile'
  ) {
    return undefined;
  }

  const workspaceFile = vscodeApi.workspace.workspaceFile;
  assert.ok(workspaceFile, 'Expected an open workspace file for replacement picker');
  const workspaceDirectory = path.dirname(workspaceFile.fsPath);
  const replacementPath = path.join(workspaceDirectory, 'lane-a-moved');

  return vscodeApi.commands.registerCommand(E2E_PICK_REPLACEMENT_FOLDER_COMMAND, (options) => {
    assert.equal(options.title, 'Locate Lane Folder');
    assert.equal(options.openLabel, 'Locate Folder');
    assert.equal(options.canSelectFiles, false);
    assert.equal(options.canSelectFolders, true);
    assert.equal(options.canSelectMany, false);
    assert.equal(path.resolve(options.defaultUri.fsPath), path.resolve(workspaceDirectory));
    return vscodeApi.Uri.file(replacementPath);
  });
};

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
      const replacementPicker = registerReplacementPickerCommand({ resultIdentity, vscodeApi });
      try {
        await suite.run({
          environment,
          vscodeApi,
          log(value) {
            message = value;
          },
        });
      } finally {
        replacementPicker?.dispose();
      }
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

module.exports = { activate, deactivate, registerReplacementPickerCommand, runDriver };
