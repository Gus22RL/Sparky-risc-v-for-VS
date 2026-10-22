import * as vscode from 'vscode';
import { BridgeOptions } from './bridge';
import { AssembleOptions } from './types';
import { NumberFormat } from './util';

export function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('sparky');
}

/** Assembler/simulator options from the user's settings; a launch configuration may override each of them. */
export function assembleOptions(overrides: Partial<AssembleOptions> = {}): AssembleOptions {
  const c = cfg();
  const pick = <T>(over: T | undefined, key: string, def: T): T => (over !== undefined ? over : c.get<T>(key, def));
  return {
    rv64: pick(overrides.rv64, 'rv64', false),
    pseudo: pick(overrides.pseudo, 'pseudoInstructions', true),
    startAtMain: pick(overrides.startAtMain, 'startAtMain', false),
    selfModifyingCode: pick(overrides.selfModifyingCode, 'selfModifyingCode', false),
    warningsAreErrors: pick(overrides.warningsAreErrors, 'warningsAreErrors', false),
    memoryConfig: pick(overrides.memoryConfig, 'memoryConfiguration', 'Default'),
    reverse: pick(overrides.reverse, 'reverseDebugging', true),
    programArguments: overrides.programArguments ?? [],
  };
}

export function bridgeOptions(extensionPath: string, log: (line: string) => void): BridgeOptions {
  const c = cfg();
  return {
    extensionPath,
    javaPath: c.get<string>('javaPath', ''),
    jarPath: c.get<string>('jarPath', ''),
    log,
  };
}

export function numberFormat(): NumberFormat {
  return cfg().get<NumberFormat>('numberFormat', 'both');
}
