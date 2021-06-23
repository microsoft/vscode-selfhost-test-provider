/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { scanTestOutput } from './testOutputScanner';
import { guessWorkspaceFolder, TestCase, TestFile, TestRoot, VSCodeTest } from './testTree';
import { PlatformTestRunner } from './vscodeTestRunner';

const TEST_FILE_PATTERN = 'src/vs/**/*.test.ts';

const getWorkspaceFolderForTestFile = (uri: vscode.Uri) =>
  uri.path.endsWith('.test.ts') ? vscode.workspace.getWorkspaceFolder(uri) : undefined;

export function activate(context: vscode.ExtensionContext) {
  const ctrl = vscode.test.createTestController<VSCodeTest>('selfhost-test-controller');

  ctrl.root.label = 'VS Code Unit Tests';
  ctrl.root.canResolveChildren = true;
  ctrl.root.debuggable = true;
  ctrl.root.data = new TestRoot();

  ctrl.resolveChildrenHandler = async test => {
    if (test === ctrl.root) {
      context.subscriptions.push(await startWatchingWorkspace(ctrl));
    } else if (test.data instanceof TestFile) {
      // No need to watch this, updates will be triggered on file changes
      // either by the text document or file watcher.
      await test.data.updateFromDisk(ctrl, test);
    }
  };

  let runQueue = Promise.resolve();
  ctrl.runHandler = async (req, cancellationToken) => {
    const folder = await guessWorkspaceFolder();
    if (!folder) {
      return;
    }

    const runner = new PlatformTestRunner(folder);
    const map = await getPendingTestMap(ctrl, req.tests);
    const task = ctrl.createTestRun(req);
    for (const test of map.values()) {
      task.setState(test, vscode.TestResultState.Queued);
    }

    return (runQueue = runQueue.then(async () => {
      await scanTestOutput(
        map,
        task,
        req.debug ? await runner.debug(req.tests) : await runner.run(req.tests),
        cancellationToken
      );
    }));
  };

  function updateNodeForDocument(e: vscode.TextDocument) {
    const node = getOrCreateFile(ctrl, e.uri);
    if (node) {
      node.data.updateFromContents(ctrl, e.getText(), node);
    }
  }

  for (const document of vscode.workspace.textDocuments) {
    updateNodeForDocument(document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(updateNodeForDocument),
    vscode.workspace.onDidChangeTextDocument(e => updateNodeForDocument(e.document))
  );
}

function getOrCreateFile(
  controller: vscode.TestController,
  uri: vscode.Uri
): vscode.TestItem<TestFile> | undefined {
  const folder = getWorkspaceFolderForTestFile(uri);
  if (!folder) {
    return undefined;
  }

  const data = new TestFile(uri, folder);
  const existing = controller.root.children.get(data.getId());
  if (existing) {
    return existing;
  }

  const file = controller.createTestItem(data.getId(), data.getLabel(), controller.root, uri, data);
  file.canResolveChildren = true;
  file.debuggable = true;
  return file;
}

async function startWatchingWorkspace(controller: vscode.TestController) {
  const workspaceFolder = await guessWorkspaceFolder();
  if (!workspaceFolder) {
    return new vscode.Disposable(() => undefined);
  }

  const pattern = new vscode.RelativePattern(workspaceFolder, TEST_FILE_PATTERN);
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  const contentChange = new vscode.EventEmitter<vscode.Uri>();

  watcher.onDidCreate(uri => getOrCreateFile(controller, uri));
  watcher.onDidChange(uri => contentChange.fire(uri));
  watcher.onDidDelete(uri => controller.root.children.get(uri.toString())?.dispose());

  for (const file of await vscode.workspace.findFiles(pattern)) {
    getOrCreateFile(controller, file);
  }

  return watcher;
}

async function getPendingTestMap(
  ctrl: vscode.TestController,
  tests: ReadonlyArray<vscode.TestItem<VSCodeTest>>
) {
  const queue: Iterable<vscode.TestItem<VSCodeTest>>[] = [tests];
  const titleMap = new Map<string, vscode.TestItem<TestCase>>();
  while (queue.length) {
    for (const child of queue.pop()!) {
      if (child.data instanceof TestFile) {
        if (!child.data.hasBeenRead) {
          await child.data.updateFromDisk(ctrl, child);
        }
        queue.push(child.children.values());
      } else if (child.data instanceof TestCase) {
        titleMap.set(child.data.fullName, child as vscode.TestItem<TestCase>);
      } else {
        queue.push(child.children.values());
      }
    }
  }

  return titleMap;
}
