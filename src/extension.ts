/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { VscodeTestProvider } from './vscodeTestProvider';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.test.registerTestProvider(new VscodeTestProvider()));
}
