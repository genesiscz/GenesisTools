// @ts-expect-error - no types for this import
import Select from 'enquirer/lib/prompts/select';
import { spawn } from 'child_process';
import path from 'path';

async function main() {
  const choices = [
    {
      name: 'watch',
      message: 'Watch a directory for file changes (fb-watchman)',
      value: 'watch',
    },
    {
      name: 'github-release-notes',
      message: 'Fetch and save GitHub release notes as markdown',
      value: 'github-release-notes',
    },
  ];

  const prompt = new Select({
    name: 'command',
    message: 'What do you want to do?',
    choices,
  });

  const command = await prompt.run();

  console.log(command);
  let scriptPath = '';
  if (command === 'watch') {
    scriptPath = path.join(__dirname, 'src/watch', 'index.ts');
  } else if (command === 'github-release-notes') {
    scriptPath = path.join(__dirname, 'src/github-release-notes', 'index.ts');
  } else {
    console.error('Unknown command');
    process.exit(1);
  }

  // Forward all arguments after the command
  const args = process.argv.slice(2);
  const bunProcess = spawn('bun', [scriptPath, ...args], {
    stdio: 'inherit',
  });

  bunProcess.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}

main(); 