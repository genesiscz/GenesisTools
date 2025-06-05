import logger from '@/utils/logger.js';
import { ChildProcess, spawn } from 'node:child_process';
import os from 'node:os';

export function runNodeScriptInTerminal(uiScriptPath: string, payload: string): ChildProcess {
  const platform = os.platform();
  let childProcess: ChildProcess;

  if (platform === 'darwin') {
    // macOS - use osascript to open in a new Terminal window
    const escapedScriptPath = uiScriptPath;
    const escapedPayload = payload;

    const nodeCommand = `bun "${escapedScriptPath}" "${escapedPayload}"; exit 0`;

    const escapedNodeCommand = nodeCommand
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');

  //   const command = `osascript -e 'tell application "Warp"
	// 	activate
	// 	tell application "System Events" to tell process "Warp"
	// 		click menu item "New Tab" of menu "File" of menu bar 1
	// 		set frontmost to true
	// 	end tell
	// 	delay 3
	// 	tell application "System Events"
	// 		tell application process "Warp"
	// 			keystroke "${escapedNodeCommand}"
	// 			keystroke return
	// 		end tell
	// 	end tell
	// end tell'`;
  const command = `osascript -e 'tell application "Terminal" to activate' -e 'tell application "Terminal" to do script "${escapedNodeCommand}"'`;

  // const command = `osascript -e 'tell application "Terminal" to do script "${escapedNodeCommand}"'`;
  logger.warn(command);

    const commandArgs: string[] = [];

    childProcess = spawn(command, commandArgs, {
      stdio: ['ignore', 'ignore', 'ignore'],
      shell: true,
      detached: true,
    });
  } else if (platform === 'win32') {
    // Windows
    childProcess = spawn('node', [uiScriptPath, payload], {
      stdio: ['ignore', 'ignore', 'ignore'],
      shell: true,
      detached: true,
      windowsHide: false,
    });
  } else {    // Linux or other
    childProcess = spawn('node', [uiScriptPath, payload], {
      stdio: ['ignore', 'ignore', 'ignore'],
      shell: true,
      detached: true,
    });
  }

  return childProcess;
} 