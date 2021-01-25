import * as assert from 'assert';
import { EventEmitter, TestItem, Uri } from 'vscode';
import { extractTests } from './extractTestsTs';
import { TestCase, TestRoot, TestSuite, VSCodeTest } from './testTree';

const sampleFile = `
suite('a', () => {
  test('aa', () => {});
  test('ab', () => {});
  suite('ac', () => {
    test('aca', () => {});
  });
});

suite('b', () => {
  test('ba', () => {});
});`;

type Serialized = { e: string; children?: Serialized[] };

const serialize = (node: TestItem): Serialized => ({
  e: node.label,
  children: node.children?.map(serialize),
});

test('extracts with ts', () => {
  const root = new TestRoot({
    index: 0,
    name: 'folder',
    uri: Uri.file('/workspace'),
  });

  const change = new EventEmitter<VSCodeTest>();

  extractTests(sampleFile, {
    root,
    file: Uri.file('/workspace/test.ts'),
    onTestCase: (name, location) => new TestCase(name, location, 0, root, change),
    onTestSuite: (name, location) => new TestSuite(name, location, root),
  });

  assert.deepStrictEqual(serialize(root), {
    e: 'folder',
    children: [
      {
        e: 'a',
        children: [{ e: 'aa' }, { e: 'ab' }, { e: 'ac', children: [{ e: 'aca' }] }],
      },
      {
        e: 'b',
        children: [{ e: 'ba' }],
      },
    ],
  });
});
