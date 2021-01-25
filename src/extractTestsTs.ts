/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as ts from 'typescript';
import * as vscode from 'vscode';
import { TestCase, TestRoot, TestSuite, VSCodeTest } from './testTree';

export interface IExtractOpts {
  root: TestRoot;
  file: vscode.Uri;
  onTestCase(name: string, location: vscode.Location): TestCase;
  onTestSuite(name: string, location: vscode.Location): TestSuite;
}

export const extractTestsTs = (source: string, opts: IExtractOpts) => {
  const ast = ts.createSourceFile(
    opts.file.path.split('/').pop()!,
    source,
    ts.ScriptTarget.ESNext,
    false,
    ts.ScriptKind.TS
  );

  const parents: (TestRoot | TestSuite)[] = [opts.root];
  const changedTests = new Set<VSCodeTest>();
  const traverse = (node: ts.Node) => {
    const testItem = extractTestFromNode(ast, node, opts);
    if (!testItem) {
      ts.forEachChild(node, traverse);
      return;
    }

    const parent = parents[parents.length - 1];
    const [deduped, changed] = parent.addChild(testItem);
    if (changed) {
      changedTests.add(deduped);
    }

    if (deduped === testItem) {
      changedTests.add(parent);
      if (testItem instanceof TestCase) {
        testItem.connect();
      }
    }

    if (deduped instanceof TestSuite) {
      parents.push(deduped);
      ts.forEachChild(node, traverse);
      parents.pop();
    }
  };

  ts.forEachChild(ast, traverse);

  return changedTests;
};

const suiteNames = new Set(['suite', 'flakySuite']);

const extractTestFromNode = (src: ts.SourceFile, node: ts.Node, opts: IExtractOpts) => {
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
  const range = new vscode.Range(
    new vscode.Position(start.line, start.character),
    new vscode.Position(end.line, end.character)
  );
  const location = new vscode.Location(opts.file, range);

  if (lhs.escapedText === 'test') {
    return opts.onTestCase(name.text, location);
  }

  if (suiteNames.has(lhs.escapedText.toString())) {
    return opts.onTestSuite(name.text, location);
  }

  return undefined;
};
