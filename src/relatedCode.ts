/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { getContentFromFilesystem, itemData, TestFile } from './testTree';

type ChildIterator = { forEach(fn: (t: vscode.TestItem) => void): void };

/**
 * Updates the "related code" of tests in the file.
 */
export const updatedRelatedCodeForTestFile = async (file: TestFile, testItems: ChildIterator) => {
  if (!file.relatedCodeFile) {
    return;
  }

  const content = await getContentFromFilesystem(file.relatedCodeFile);
  if (!content) {
    return;
  }

  return updatedRelatedCodeFromContents(file.relatedCodeFile, testItems, content);
};

/**
 * Updates the "related code" of tests that have implementations in
 * the file. Assumes the tests are already discovered, doesn't
 * eagerly do discovery.
 */
export const updateRelatedCodeForImplementation = async (
  file: vscode.Uri,
  children: vscode.TestItemCollection,
  contents: string
) => {
  children.forEach(child => {
    const item = itemData.get(child);
    if (item instanceof TestFile && item.relatedCodeFile?.path === file.path) {
      updatedRelatedCodeFromContents(file, child.children, contents);
    }
  });
};

const isDocCommentLike = /^\s* \* /;

/**
 * Updates related code in each TestItem from the contents of the
 * implementation code. Assumes that each test involves testing a
 * method, function, or class and is labeled correspondingly. This
 * may not hold true for all tests, but is true for some tests.
 */
const updatedRelatedCodeFromContents = (
  uri: vscode.Uri,
  testItems: ChildIterator,
  relatedCodeFileContents: string
) => {
  const lines = relatedCodeFileContents.split(/\r?\n/g);
  const addRelatedCode = (testItem: vscode.TestItem) => {
    let found = false;
    for (let line = 0; line < lines.length; line++) {
      const contents = lines[line];
      if (contents.startsWith('//') || isDocCommentLike.test(contents)) {
        continue;
      }

      const index = contents.indexOf(testItem.label);
      if (index === -1) {
        continue;
      }

      testItem.relatedCode = [
        new vscode.Location(
          uri,
          new vscode.Range(
            new vscode.Position(line, index),
            new vscode.Position(line, index + testItem.label.length)
          )
        ),
      ];
      found = true;
      break;
    }

    if (!found) {
      testItem.relatedCode = undefined;
    }

    testItem.children.forEach(addRelatedCode);
  };
  testItems.forEach(addRelatedCode);
};
