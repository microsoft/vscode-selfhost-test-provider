/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { FileCoverageData, Range as IstanbulRange } from 'istanbul-lib-coverage';
import * as vscode from 'vscode';
import { SourceMapStore } from './testOutputScanner';

export class CoverageProvider implements vscode.TestCoverageProvider<FileCoverage> {
  constructor(
    private readonly files: Record<string, FileCoverageData>,
    private readonly repoLocation: vscode.WorkspaceFolder,
    private readonly store: SourceMapStore
  ) {}

  /** @inheritdoc */
  public provideFileCoverage(): Promise<FileCoverage[]> {
    return Promise.all(
      Object.values(this.files).map(async (entry: FileCoverageData) => {
        const compiledUri = vscode.Uri.file(entry.path);
        const originalUri = await this.store.getSourceFile(compiledUri.toString());
        return new FileCoverage(originalUri || compiledUri, entry, compiledUri);
      })
    );
  }

  public async resolveFileCoverage(file: FileCoverage): Promise<FileCoverage> {
    const details: vscode.DetailedCoverage[] = [];
    const todo: Promise<void>[] = [];

    for (const [key, branch] of Object.entries(file.original.branchMap)) {
      todo.push(
        Promise.all([
          this.mapRange(file.compiledUri, branch.loc),
          ...branch.locations.map(l =>
            l.start.line !== undefined
              ? this.mapRange(file.compiledUri, l)
              : // the implicit "else" case of 'if' statements are emitted as a
                // branch with no range; use a zero-length range of the conditional
                // end location to represent this.
                this.mapRange(file.compiledUri, { start: branch.loc.end, end: branch.loc.end })
          ),
        ]).then(([loc, ...branches]) => {
          if (!loc || branches.some(b => !b)) {
            // no-op
          } else if (branches.length === 1) {
            details.push(new vscode.StatementCoverage(file.original.b[key][0], branches[0]!));
          } else {
            details.push(
              new vscode.StatementCoverage(
                file.original.s[key],
                loc,
                branches.map((b, i) => new vscode.BranchCoverage(file.original.b[key][i], b!))
              )
            );
          }
        })
      );
    }

    for (const [key, stmt] of Object.entries(file.original.statementMap)) {
      todo.push(
        this.mapRange(file.compiledUri, stmt).then(loc => {
          if (loc) {
            details.push(new vscode.StatementCoverage(file.original.s[key], loc));
          }
        })
      );
    }

    for (const [key, stmt] of Object.entries(file.original.fnMap)) {
      todo.push(
        this.mapRange(file.compiledUri, stmt.loc).then(loc => {
          if (loc) {
            details.push(new vscode.FunctionCoverage(stmt.name, file.original.f[key], loc));
          }
        })
      );
    }

    await Promise.all(todo);

    file.detailedCoverage = details;
    return file;
  }

  private async mapRange(uri: vscode.Uri, range: IstanbulRange) {
    const uriStr = uri.toString();
    const [start, end] = await Promise.all([
      this.store.getSourceLocation(uriStr, range.start.line, range.start.column + 1),
      this.store.getSourceLocation(uriStr, range.end.line, range.end.column + 1),
    ]);
    if (start && end) {
      return new vscode.Range(start.range.start, end.range.end);
    }
    const some = start || end;
    if (some) {
      return some.range;
    }

    return undefined;
  }
}

class FileCoverage extends vscode.FileCoverage {
  constructor(
    uri: vscode.Uri,
    public readonly original: FileCoverageData,
    public readonly compiledUri: vscode.Uri
  ) {
    super(uri, parseToSum(original.s), parseToSum(original.b), parseToSum(original.f));
  }
}

const parseToSum = (p: Record<string, number[] | number>): vscode.CoveredCount => {
  let covered = 0;
  let total = 0;
  for (const count of Object.values(p)) {
    if (count instanceof Array) {
      for (const c of count) {
        covered += c ? 1 : 0;
        total++;
      }
    } else {
      covered += count ? 1 : 0;
      total++;
    }
  }

  return new vscode.CoveredCount(covered, total);
};
