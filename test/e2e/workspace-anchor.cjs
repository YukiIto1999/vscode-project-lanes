'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const HASH_PREFIX = 'project-lanes:workspace-anchor:v1\0';

const deriveWorkspaceAnchor = (workspaceFile) => {
  const workspaceUri =
    workspaceFile.toString === Object.prototype.toString
      ? pathToFileURL(workspaceFile.fsPath).toString()
      : workspaceFile.toString();
  const workspaceKey = `workspace:${workspaceUri}`;
  const hash = crypto.createHash('sha256').update(`${HASH_PREFIX}${workspaceKey}`).digest('hex');
  const rootDirectoryPath = path.join(path.dirname(workspaceFile.fsPath), '.lanes-root');
  const namespaceDirectoryPath = path.join(rootDirectoryPath, hash);
  return {
    workspaceKey,
    hash,
    rootDirectoryPath,
    namespaceDirectoryPath,
    activeLinkPath: path.join(namespaceDirectoryPath, 'active'),
    legacyActiveLinkPath: path.join(rootDirectoryPath, 'active'),
  };
};

module.exports = { deriveWorkspaceAnchor };
