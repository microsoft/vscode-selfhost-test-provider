/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { FileCoverageData } from 'istanbul-lib-coverage';
import { IstanbulCoverage } from 'istanbul-to-vscode';
import * as vscode from 'vscode';
import { SourceMapStore } from './testOutputScanner';

export class CoverageProvider extends IstanbulCoverage {
  constructor(files: Record<string, FileCoverageData>, private readonly store: SourceMapStore) {
    super(files);
  }

  protected override async mapFileUri(compiledUri: vscode.Uri): Promise<vscode.Uri> {
    return (await this.store.getSourceFile(compiledUri.toString())) || compiledUri;
  }

  protected override async mapLocation(
    compiledUri: vscode.Uri,
    base0Line: number,
    base0Column: number
  ): Promise<vscode.Location | undefined> {
    return this.store.getSourceLocation(compiledUri.toString(), base0Line, base0Column + 1);
  }
}
