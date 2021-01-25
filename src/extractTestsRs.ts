/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as ts from 'typescript';
import * as vscode from 'vscode';
import { extract } from '../test-extractor/pkg/test_extractor';
import { TestCase, TestRoot, TestSuite, VSCodeTest } from './testTree';

export interface IExtractOpts {
  root: TestRoot;
  file: vscode.Uri;
  onTestCase(name: string, location: vscode.Location): TestCase;
  onTestSuite(name: string, location: vscode.Location): TestSuite;
}

export const extractTestsTs = (source: string, opts: IExtractOpts) => {
  const results = extract(source);
  const tree = [opts.root];
  for (let i = 0; i < results.length;) {
    const depth = results[i++];
    const caseStart = results[i++];
    const caseLen = results[i++];
    const nameStart = results[i++];
    const nameLen = results[i++];

    while (tree.length > depth + 1) {
      tree.pop();
    }

    let subject: TestCase | TestSuite;
    if (source.slice(caseStart, caseLen).startsWith('test(')) {
      subject = opts.onTestCase(source.slice(subject.nam))
    }
  }
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
