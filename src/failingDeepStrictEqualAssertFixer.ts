/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as ts from 'typescript';
import {
  commands,
  Disposable,
  languages,
  MarkdownString,
  Position,
  Range,
  TestMessage,
  TestResultSnapshot,
  TestRunResult,
  tests,
  TextDocument,
  Uri,
  workspace,
  WorkspaceEdit
} from 'vscode';
import { getTestMessageMetadata } from './metadata';

const fixExpectedValueCommandId = 'selfhost-test.fix-test';

export class FailingDeepStrictEqualAssertFixer {
  private disposables: Disposable[] = [];

  constructor() {
    this.disposables.push(
      commands.registerCommand(fixExpectedValueCommandId, async (uri: Uri, position: Position) => {
        const document = await workspace.openTextDocument(uri);

        const failingAssertion = detectFailingDeepStrictEqualAssertion(document, position);
        if (!failingAssertion) {
          return;
        }

        const expectedValueNode = failingAssertion.assertion.expectedValue;
        if (!expectedValueNode) {
          return;
        }

        const start = document.positionAt(expectedValueNode.getStart());
        const end = document.positionAt(expectedValueNode.getEnd());

        const edit = new WorkspaceEdit();
        edit.replace(uri, new Range(start, end), JSON.stringify(failingAssertion.actualJSONValue));
        await workspace.applyEdit(edit);
      })
    );

    this.disposables.push(
      languages.registerCodeActionsProvider('typescript', {
        provideCodeActions: async (document, range) => {
          const failingAssertion = await detectFailingDeepStrictEqualAssertion(
            document,
            range.start
          );
          if (!failingAssertion) {
            return undefined;
          }

          return [
            {
              title: 'Fix Expected Value',
              command: fixExpectedValueCommandId,
              arguments: [document.uri, range.start],
            },
          ];
        },
      })
    );

    tests.testResults;
  }

  dispose() {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function detectFailingDeepStrictEqualAssertion(
  document: TextDocument,
  position: Position
): { assertion: DeepStrictEqualAssertion; actualJSONValue: unknown } | undefined {
  const sf = ts.createSourceFile('', document.getText(), ts.ScriptTarget.ES5, true);
  const offset = document.offsetAt(position);
  const assertion = DeepStrictEqualAssertion.atPosition(sf, offset);
  if (!assertion) {
    return undefined;
  }

  const startLine = document.positionAt(assertion.offsetStart).line;

  const messages = getAllTestStatusMessagesAt(document.uri, startLine);

  function toString(value: string | MarkdownString): string {
    if (typeof value === 'string') {
      return value;
    }
    return value.value;
  }

  const strictDeepEqualMessage = messages.filter(m =>
    toString(m.message).startsWith('Expected values to be strictly deep-equal:\n')
  )[0];

  if (!strictDeepEqualMessage) {
    return undefined;
  }

  const metadata = getTestMessageMetadata(strictDeepEqualMessage);
  if (!metadata) {
    return undefined;
  }

  return {
    assertion: assertion,
    actualJSONValue: metadata.actualValue,
  };
}

class DeepStrictEqualAssertion {
  public static fromNode(node: ts.Node): DeepStrictEqualAssertion | undefined {
    if (ts.isCallExpression(node) && node.expression.getText() === 'assert.deepStrictEqual') {
      return new DeepStrictEqualAssertion(node);
    }
    return undefined;
  }

  public static atPosition(
    sf: ts.SourceFile,
    offset: number
  ): DeepStrictEqualAssertion | undefined {
    let node = findNodeAt(sf, offset);

    while (node.parent) {
      const obj = DeepStrictEqualAssertion.fromNode(node);
      if (obj) {
        return obj;
      }
      node = node.parent;
    }

    return undefined;
  }

  constructor(private readonly expression: ts.CallExpression) {}

  public get expectedValue(): ts.Expression | undefined {
    return this.expression.arguments[1];
  }

  public get offsetStart(): number {
    return this.expression.getStart();
  }
}

function findNodeAt(parent: ts.Node, offset: number): ts.Node {
  for (const child of parent.getChildren()) {
    if (child.getStart() <= offset && offset <= child.getEnd()) {
      return findNodeAt(child, offset);
    }
  }
  return parent;
}

function getAllTestStatusMessagesAt(uri: Uri, lineNumber: number): TestMessage[] {
  if (tests.testResults.length === 0) {
    return [];
  }

  const run = tests.testResults[0];
  const snapshots = getTestResultsWithUri(run, uri);
  const result: TestMessage[] = [];

  for (const snapshot of snapshots) {
    for (const m of snapshot.taskStates[0].messages) {
      if (
        m.location &&
        m.location.range.start.line <= lineNumber &&
        lineNumber <= m.location.range.end.line
      ) {
        result.push(m);
      }
    }
  }

  return result;
}

function getTestResultsWithUri(testRun: TestRunResult, uri: Uri): TestResultSnapshot[] {
  const results: TestResultSnapshot[] = [];

  const walk = (r: TestResultSnapshot) => {
    for (const c of r.children) {
      walk(c);
    }
    if (r.uri?.toString() === uri.toString()) {
      results.push(r);
    }
  };

  for (const r of testRun.results) {
    walk(r);
  }

  return results;
}
