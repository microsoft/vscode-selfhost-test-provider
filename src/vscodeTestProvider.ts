/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { SourceMapConsumer } from 'source-map';
import * as ts from 'typescript';
import {
  CancellationToken,
  EventEmitter,
  Location,
  MarkdownString,
  OutputChannel,
  Position,
  Range,
  RelativePattern,
  TestMessage,
  TestProvider,
  TestResult,
  TestRun,
  TestState,
  TextDocument,
  Uri,
  window,
  workspace,
  WorkspaceFolder,
} from 'vscode';
import { debounce } from './debounce';
import { MochaEvent, TestOutputScanner } from './testOutputScanner';
import { idPrefix, TestCase, TestRoot, TestSuite, VSCodeTest } from './testTree';
import { PlatformTestRunner } from './vscodeTestRunner';

declare const TextDecoder: typeof import('util').TextDecoder; // node in the typings yet

const TEST_FILE_PATTERN = 'src/vs/**/*.test.ts';
const MAX_BLOCKING_TARGET = 0.5;

export class VscodeTestProvider implements TestProvider<VSCodeTest> {
  private outputChannel?: OutputChannel;
  private queue = Promise.resolve();

  /**
   * @inheritdoc
   */
  public provideWorkspaceTestHierarchy(workspaceFolder: WorkspaceFolder, token: CancellationToken) {
    const root = new TestRoot(workspaceFolder, `$root/${workspaceFolder.uri.toString()}`);
    const pattern = new RelativePattern(workspaceFolder, TEST_FILE_PATTERN);

    const changedEmitter = new EventEmitter<VSCodeTest>();
    const invalidateEmitter = new EventEmitter<VSCodeTest>();
    const watcher = workspace.createFileSystemWatcher(pattern);
    watcher.onDidCreate(uri => updateTestsInFile(root, uri, changedEmitter, invalidateEmitter));
    watcher.onDidChange(uri => updateTestsInFile(root, uri, changedEmitter, invalidateEmitter));
    watcher.onDidDelete(uri => removeTestsForFile(root, uri, changedEmitter));
    token.onCancellationRequested(() => watcher.dispose());

    const discoveredInitialTests = workspace.findFiles(pattern).then(async files => {
      const workers: Promise<void>[] = [];
      const startedAt = Date.now();
      let totalProcessedTime = 0;

      for (let i = 0; i < 4; i++) {
        workers.push(
          (async () => {
            while (files.length) {
              totalProcessedTime += await updateTestsInFile(root, files.pop()!, changedEmitter);

              // Parsing a lot of TS is slow. Throttle ourselves to avoid
              // blocking the ext host for too long.
              const duration = Date.now() - startedAt;
              const actualPercentOfTimeOnMainThread = totalProcessedTime / duration;
              const overusePercentage = actualPercentOfTimeOnMainThread - MAX_BLOCKING_TARGET;
              const delayToGetBackDownToTarget = overusePercentage * duration;
              if (delayToGetBackDownToTarget > 1) {
                await delay(delayToGetBackDownToTarget);
              }
            }
          })()
        );

        await Promise.all(workers);
      }
    });

    return {
      root,
      onDidChangeTest: changedEmitter.event,
      discoveredInitialTests,
    };
  }

  /**
   * @inheritdoc
   */
  public provideDocumentTestHierarchy(document: TextDocument, token: CancellationToken) {
    const folder = workspace.getWorkspaceFolder(document.uri);
    if (!folder) {
      return;
    }

    const root = new TestRoot(folder, `$root/${document.uri.toString()}`);
    const changeTestEmitter = new EventEmitter<VSCodeTest>();
    const contentProvider = () => document.getText();
    const discoveredInitialTests = updateTestsInFile(
      root,
      document.uri,
      changeTestEmitter,
      undefined,
      contentProvider
    );

    const invalidatedTestEmitter = new EventEmitter<VSCodeTest>();
    const updateTests = debounce(700, () =>
      updateTestsInFile(root, document.uri, changeTestEmitter, invalidatedTestEmitter)
    );
    const changeListener = workspace.onDidChangeTextDocument(e => {
      if (e.document === document) {
        updateTests();
      }
    });

    token.onCancellationRequested(() => {
      changeListener.dispose();
      updateTests.clear();
    });

    return {
      root,
      onDidChangeTest: changeTestEmitter.event,
      onDidInvalidateTest: invalidatedTestEmitter.event,
      discoveredInitialTests,
    };
  }

  public async runTests(req: TestRun<VSCodeTest>, cancellationToken: CancellationToken) {
    const root = req.tests[0].root;
    const runner = new PlatformTestRunner(root.workspaceFolder);

    const pending = getPendingTestMap(req.tests);
    return (this.queue = this.queue.then(async () => {
      const output = this.getOutputChannel();
      output.appendLine('');
      output.appendLine(`Starting test run at ${new Date().toLocaleString()}`);
      output.appendLine('');

      const outcome = await scanTestOutput(
        output,
        req,
        req.debug ? await runner.debug(req.tests) : await runner.run(req.tests),
        pending,
        cancellationToken
      );

      // some error:
      if (outcome !== TestResult.Skipped) {
        output.show();
      }
    }));
  }

  private getOutputChannel() {
    if (!this.outputChannel) {
      this.outputChannel = window.createOutputChannel('VS Code Tests');
    }

    return this.outputChannel;
  }
}

const delay = (duration: number) => new Promise<void>(r => setTimeout(r, duration));

function scanTestOutput(
  outputChannel: OutputChannel,
  req: TestRun<VSCodeTest>,
  scanner: TestOutputScanner,
  tests: Map<string, TestCase>,
  cancellation: CancellationToken
): Promise<TestResult> {
  if (cancellation.isCancellationRequested) {
    scanner.dispose();
    return Promise.resolve(TestResult.Skipped);
  }

  return new Promise<TestResult>(resolve => {
    cancellation.onCancellationRequested(() => {
      resolve(TestResult.Skipped);
    });

    scanner.onRunnerError(err => {
      outputChannel.appendLine(err);
      resolve(TestResult.Errored);
    });

    scanner.onOtherOutput(str => {
      outputChannel.appendLine(str);
    });

    scanner.onMochaEvent(evt => {
      switch (evt[0]) {
        case MochaEvent.Start:
          break; // no-op
        case MochaEvent.Pass:
          {
            const id = evt[1].fullTitle;
            const tcase = tests.get(idPrefix + id);
            outputChannel.appendLine(` √ ${id}`);
            if (tcase) {
              const state = new TestState(TestResult.Passed);
              state.duration = evt[1].duration;
              req.setState(tcase, state);
              tests.delete(id);
            }
          }
          break;
        case MochaEvent.Fail:
          {
            const { err, stack, duration, expected, actual, fullTitle: id } = evt[1];
            const tcase = tests.get(idPrefix + id);
            outputChannel.appendLine(` x ${id}`);
            if (!tcase) {
              return;
            }

            tests.delete(id);
            const testFirstLine = new Location(
              tcase.location.uri,
              new Range(
                tcase.location.range.start,
                new Position(tcase.location.range.start.line, 100)
              )
            );

            tryDeriveLocation(stack || err).then(location => {
              const message = new TestMessage(tryMakeMarkdown(err));
              message.location = location ?? testFirstLine;
              message.actualOutput = actual;
              message.expectedOutput = expected;
              req.setState(tcase, { duration, messages: [message], state: TestResult.Failed });
              outputChannel.appendLine(stack || err);
            });
          }
          break;
        case MochaEvent.End:
          resolve(TestResult.Skipped);
          break;
      }
    });
  }).finally(() => scanner.dispose());
}

const tryMakeMarkdown = (message: string) => {
  const lines = message.split('\n');
  const start = lines.findIndex(l => l.includes('+ actual'));
  if (start === -1) {
    return message;
  }

  lines.splice(start, 1, '```diff');
  lines.push('```');
  return new MarkdownString(lines.join('\n'));
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
    const contents = await getContentsFromFile(Uri.parse(sourceMapUri));
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

  return new Location(Uri.parse(position.source), new Position(position.line - 1, position.column));
}

function getPendingTestMap(tests: ReadonlyArray<VSCodeTest>) {
  const queue: Iterable<VSCodeTest>[] = [tests];
  const titleMap = new Map<string, TestCase>();
  while (queue.length) {
    for (const child of queue.pop()!) {
      if (child instanceof TestCase) {
        titleMap.set(child.id, child);
      } else {
        queue.push(child.children);
      }
    }
  }

  return titleMap;
}

let generation = 0;

function removeTestsForFile(root: TestRoot, file: Uri, changeEmitter: EventEmitter<VSCodeTest>) {
  const changes = new Set<VSCodeTest>();
  root.prune(file, generation++, changes);
  for (const change of changes) {
    changeEmitter.fire(change);
  }
}

const getContentsFromFile = async (file: Uri) => {
  const contents = await workspace.fs.readFile(file);
  return new TextDecoder('utf-8').decode(contents);
};

/**
 * Gets tests in the file by doing a full parse in TS. Returns the amount of
 * main-thread time taken.
 */
async function updateTestsInFile(
  root: TestRoot,
  file: Uri,
  changeEmitter: EventEmitter<VSCodeTest>,
  outdatedEmitter?: EventEmitter<VSCodeTest>,
  getContents: (uri: Uri) => string | Promise<string> = getContentsFromFile
) {
  try {
    const decoded = await getContents(file);
    const ast = ts.createSourceFile(
      file.path.split('/').pop()!,
      decoded,
      ts.ScriptTarget.ESNext,
      false,
      ts.ScriptKind.TS
    );

    const startedAt = Date.now();
    const thisGeneration = generation++;
    const parents: (TestRoot | TestSuite)[] = [root];
    const changedTests = new Set<VSCodeTest>();
    const traverse = (node: ts.Node) => {
      const parent = parents[parents.length - 1];
      const testItem = extractTestFromNode(file, root, ast, node, parent, thisGeneration);
      if (!testItem) {
        ts.forEachChild(node, traverse);
        return;
      }

      const [deduped, changed] = parent.addChild(testItem);
      if (changed) {
        changedTests.add(deduped);
        outdatedEmitter?.fire(deduped);
      }

      if (deduped === testItem) {
        changedTests.add(parent);
      }

      if (deduped instanceof TestSuite) {
        parents.push(deduped);
        ts.forEachChild(node, traverse);
        parents.pop();
      }
    };

    ts.forEachChild(ast, traverse);
    root.prune(file, thisGeneration, changedTests);

    for (const change of changedTests) {
      changeEmitter.fire(change);
    }

    return Date.now() - startedAt;
  } catch (e) {
    console.warn('Error reading tests in file', file.toString(), e);
    return 1;
  }
}

const suiteNames = new Set(['suite', 'flakySuite']);

const extractTestFromNode = (
  fileUri: Uri,
  root: TestRoot,
  src: ts.SourceFile,
  node: ts.Node,
  parent: TestSuite | TestRoot,
  generation: number
) => {
  if (!ts.isCallExpression(node)) {
    return undefined;
  }

  const lhs = node.expression;
  const name = node.arguments[0];
  const func = node.arguments[1];
  if (!name || !ts.isIdentifier(lhs) || !ts.isStringLiteralLike(name)) {
    return undefined;
  }

  if (!func || !ts.isFunctionLike(func)) {
    return undefined;
  }

  const start = src.getLineAndCharacterOfPosition(name.pos);
  const end = src.getLineAndCharacterOfPosition(func.end);
  const range = new Range(
    new Position(start.line, start.character),
    new Position(end.line, end.character)
  );
  const location = new Location(fileUri, range);

  if (lhs.escapedText === 'test') {
    return new TestCase(name.text, location, generation, root, parent);
  }

  if (suiteNames.has(lhs.escapedText.toString())) {
    return new TestSuite(name.text, location, root, parent);
  }

  return undefined;
};
