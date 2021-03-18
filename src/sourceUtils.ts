/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as ts from 'typescript';
import { Location, Position, Range, Uri } from 'vscode';
import { TestCase, TestFile, TestSuite } from './testTree';

const suiteNames = new Set(['suite', 'flakySuite']);

export const extractTestFromNode = (
  fileUri: Uri,
  src: ts.SourceFile,
  node: ts.Node,
  parent: TestSuite | TestFile,
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
    return new TestCase(name.text, location, generation, parent);
  }

  if (suiteNames.has(lhs.escapedText.toString())) {
    return new TestSuite(name.text, location, generation, parent);
  }

  return undefined;
};
