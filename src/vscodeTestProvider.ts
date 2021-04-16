/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import styles from 'ansi-styles';
import { SourceMapConsumer } from 'source-map';
import * as vscode from 'vscode';
import { MochaEvent, TestOutputScanner } from './testOutputScanner';
import {
  DocumentTestRoot,
  getContentFromFilesystem,
  TestCase,
  TestFile,
  TestRoot,
  VSCodeTest,
  WorkspaceTestRoot,
} from './testTree';
import { PlatformTestRunner } from './vscodeTestRunner';

export class VSCodeTestController implements vscode.TestController<VSCodeTest> {
  private queue = Promise.resolve();

  /**
   * @inheritdoc
   */
  public createWorkspaceTestRoot(workspaceFolder: vscode.WorkspaceFolder) {
    return WorkspaceTestRoot.create(workspaceFolder);
  }

  /**
   * @inheritdoc
   */
  public createDocumentTestRoot(document: vscode.TextDocument) {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) {
      return;
    }

    return DocumentTestRoot.create(document, folder);
  }

  public async runTests(
    req: vscode.TestRunRequest<VSCodeTest>,
    cancellationToken: vscode.CancellationToken
  ) {
    let maybeRoot = req.tests[0];
    while (!(maybeRoot.data instanceof TestRoot)) {
      maybeRoot = maybeRoot.parent!;
    }

    const root = maybeRoot as vscode.TestItem<TestRoot>;
    const runner = new PlatformTestRunner(root.data.workspaceFolder);
    const map = await getPendingTestMap(req.tests);
    const task = vscode.test.createTestRunTask(req);
    for (const test of map.values()) {
      task.setState(test, vscode.TestResultState.Queued);
    }

    return (this.queue = this.queue.then(async () => {
      await scanTestOutput(
        map,
        task,
        req.debug ? await runner.debug(req.tests) : await runner.run(req.tests),
        cancellationToken
      );
    }));
  }
}

async function scanTestOutput(
  tests: Map<string, vscode.TestItem<VSCodeTest>>,
  task: vscode.TestRunTask<VSCodeTest>,
  scanner: TestOutputScanner,
  cancellation: vscode.CancellationToken
): Promise<void> {
  const locationDerivations: Promise<void>[] = [];
  try {
    if (cancellation.isCancellationRequested) {
      return;
    }

    await new Promise<void>(resolve => {
      cancellation.onCancellationRequested(() => {
        resolve();
      });

      scanner.onRunnerError(err => {
        task.appendOutput(err + '\r\n');
        resolve();
      });

      scanner.onOtherOutput(str => {
        task.appendOutput(str + '\r\n');
      });

      scanner.onMochaEvent(evt => {
        switch (evt[0]) {
          case MochaEvent.Start:
            break; // no-op
          case MochaEvent.Pass:
            {
              const title = evt[1].fullTitle;
              const tcase = tests.get(title);
              task.appendOutput(` ${styles.green.open}√${styles.green.close} ${title}\r\n`);
              if (tcase) {
                task.setState(tcase, vscode.TestResultState.Passed, evt[1].duration);
                tests.delete(title);
              }
            }
            break;
          case MochaEvent.Fail:
            {
              const { err, stack, duration, expected, actual, fullTitle: id } = evt[1];
              const tcase = tests.get(id);
              task.appendOutput(`${styles.red.open} x ${id}${styles.red.close}\r\n`);
              const rawErr = stack || err;
              if (rawErr) {
                task.appendOutput(forceCRLF(rawErr));
              }

              if (!tcase) {
                return;
              }

              tests.delete(id);
              const testFirstLine =
                tcase.range &&
                new vscode.Location(
                  tcase.uri,
                  new vscode.Range(
                    tcase.range.start,
                    new vscode.Position(tcase.range.start.line, 100)
                  )
                );

              locationDerivations.push(
                tryDeriveLocation(rawErr).then(location => {
                  const message = new vscode.TestMessage(tryMakeMarkdown(err));
                  message.location = location ?? testFirstLine;
                  message.actualOutput = String(actual);
                  message.expectedOutput = String(expected);
                  task.appendMessage(tcase, message);
                  task.setState(tcase, vscode.TestResultState.Failed, duration);
                })
              );
            }
            break;
          case MochaEvent.End:
            resolve();
            break;
        }
      });
    });
    await Promise.all(locationDerivations);
  } catch (e) {
    task.appendOutput(e.stack || e.message);
  } finally {
    scanner.dispose();
    task.end();
  }
}

const forceCRLF = (str: string) => str.replace(/(?<!\r)\n/gm, '\r\n');

const tryMakeMarkdown = (message: string) => {
  const lines = message.split('\n');
  const start = lines.findIndex(l => l.includes('+ actual'));
  if (start === -1) {
    return message;
  }

  lines.splice(start, 1, '```diff');
  lines.push('```');
  return new vscode.MarkdownString(lines.join('\n'));
};

async function tryDeriveLocation(stack: string) {
  const parts = /(file:\/{3}.+):([0-9]+):([0-9]+)/.exec(stack);
  if (!parts) {
    return;
  }

  const [, fileUri, line, col] = parts;
  let sourceMap: SourceMapConsumer;
  try {
    const sourceMapUri = fileUri + '.map';
    const contents = await getContentFromFilesystem(vscode.Uri.parse(sourceMapUri));
    sourceMap = await new SourceMapConsumer(contents, sourceMapUri);
  } catch (e) {
    console.warn(`Error parsing sourcemap for ${fileUri}: ${e.stack}`);
    return;
  }

  const position = sourceMap.originalPositionFor({
    column: Number(col) - 1,
    line: Number(line),
  });

  if (position.line === null || position.column === null || position.source === null) {
    return;
  }

  return new vscode.Location(
    vscode.Uri.parse(position.source),
    new vscode.Position(position.line - 1, position.column)
  );
}

async function getPendingTestMap(tests: ReadonlyArray<vscode.TestItem<VSCodeTest>>) {
  const queue: Iterable<vscode.TestItem<VSCodeTest>>[] = [tests];
  const titleMap = new Map<string, vscode.TestItem<TestCase>>();
  while (queue.length) {
    for (const child of queue.pop()!) {
      if (child.data instanceof TestFile) {
        if (child.status === vscode.TestItemStatus.Pending) {
          await child.data.refresh();
        }
        queue.push(child.children.values());
      } else if (child.data instanceof TestCase) {
        titleMap.set(child.data.fullLabel, child as vscode.TestItem<TestCase>);
      } else {
        queue.push(child.children.values());
      }
    }
  }

  return titleMap;
}
