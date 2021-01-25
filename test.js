const asdf = require('./test-extractor/pkg/test_extractor');
const ts = require('typescript');

const src = `
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

bench('rust', () => asdf.extract(src));

bench('ts', () => {
  const ast = ts.createSourceFile('src.ts', src, ts.ScriptTarget.ESNext, false, ts.ScriptKind.TS);
  const ranges = [];
  const traverse = node => {
    if (extractTestFromNode(node)) {
      ranges.push(1);
    }

    ts.forEachChild(node, traverse);
  };

  ts.forEachChild(ast, traverse);
  return ranges;
});

const extractTestFromNode = node => {
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

  return true;
};
