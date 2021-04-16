/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as ts from 'typescript';
import * as vscode from 'vscode';
import { TestCase, TestFile, TestSuite } from './testTree';

const suiteNames = new Set(['suite', 'flakySuite']);

export const extractTestFromNode = (
  src: ts.SourceFile,
  node: ts.Node,
  parent: vscode.TestItem<TestSuite | TestFile>,
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
  const range = new vscode.Range(
    new vscode.Position(start.line, start.character),
    new vscode.Position(end.line, end.character)
  );

  if (lhs.escapedText === 'test') {
    return TestCase.create(name.text, range, generation, parent);
  }

  if (suiteNames.has(lhs.escapedText.toString())) {
    return TestSuite.create(name.text, range, generation, parent);
  }

  return undefined;
};
