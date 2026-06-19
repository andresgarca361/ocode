#!/usr/bin/env node

import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(homedir(), 'ocode');

const DEFAULT_CONFIG = {
  dockerImage: '',
  autoApprove: true,
  outputFormat: 'text',
  quiet: false,
  cwd: process.cwd(),
  env: {},
  keepAwake: false,
  guiPort: 4096,
};

const CONFIG_DIR = join(homedir(), '.ocode');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const HOMEBREW_DIR = join(homedir(), '.local/Homebrew');
const HOMEBREW_BIN = join(HOMEBREW_DIR, 'bin/brew');
const LOCAL_BIN = join(homedir(), '.local/bin');

function ensureHomebrew() {
  if (existsSync(HOMEBREW_BIN)) {
    return HOMEBREW_BIN;
  }
  console.error('[ocode] Homebrew not found, installing locally (no sudo)...');
  mkdirSync(HOMEBREW_DIR, { recursive: true });
  mkdirSync(LOCAL_BIN, { recursive: true });
  
  const result = spawnSync('bash', ['-c', 
    `mkdir -p "${HOMEBREW_DIR}" && curl -L https://github.com/Homebrew/brew/tarball/master | tar xz --strip 1 -C "${HOMEBREW_DIR}"`
  ], { stdio: 'inherit' });
  
  if (result.status !== 0) {
    console.error('[ocode] Failed to install Homebrew');
    return null;
  }
  
  if (!existsSync(join(LOCAL_BIN, 'brew'))) {
    try { require('fs').symlinkSync(HOMEBREW_BIN, join(LOCAL_BIN, 'brew')); } catch {}
  }
  
  const shellRc = process.env.SHELL?.includes('zsh') ? join(homedir(), '.zshrc') : join(homedir(), '.bashrc');
  const pathExport = 'export PATH="$HOME/.local/bin:$PATH"';
  try {
    const rcContent = existsSync(shellRc) ? readFileSync(shellRc, 'utf-8') : '';
    if (!rcContent.includes('.local/bin')) {
      writeFileSync(shellRc, rcContent + `\n${pathExport}\n`);
    }
  } catch {}
  
  console.error('[ocode] Homebrew installed at ~/.local/Homebrew');
  return HOMEBREW_BIN;
}

function ensureTools() {
  const missing = [];
  if (!existsSync('/usr/local/bin/rg') && !existsSync(join(homedir(), '.local/bin/rg'))) missing.push('ripgrep');
  if (!existsSync('/usr/local/bin/fzf') && !existsSync(join(homedir(), '.local/bin/fzf'))) missing.push('fzf');
  
  if (missing.length === 0) return true;
  
  const brew = ensureHomebrew();
  if (!brew) return false;
  
  console.error(`[ocode] Installing missing tools: ${missing.join(', ')}`);
  const result = spawnSync(brew, ['install', ...missing], { stdio: 'inherit' });
  return result.status === 0;
}

function loadConfig() {
  if (existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

function saveConfig(config) {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function buildDockerImage() {
  console.error('Building ocode Docker image...');
  const result = spawnSync('docker', ['build', '-t', 'ocode:latest', '-f', join(PROJECT_ROOT, 'docker/Dockerfile'), PROJECT_ROOT], {
    stdio: 'inherit',
    cwd: PROJECT_ROOT,
  });
  return result.status === 0;
}

function ensureDockerImage() {
  const result = spawnSync('docker', ['image', 'inspect', 'ocode:latest'], {
    stdio: 'ignore',
  });
  if (result.status !== 0) {
    return buildDockerImage();
  }
  return true;
}

function runInDocker(args, config) {
  const cwd = resolve(config.cwd);
  const workspaceMount = `${cwd}:/workspace`;
  const configMount = `${CONFIG_DIR}:/home/node/.ocode`;
  const opencodeDataMount = `${homedir()}/.local/share/opencode:/home/node/.local/share/opencode`;
  const sshMount = `${homedir()}/.ssh:/home/node/.ssh:ro`;

  const dockerArgs = [
    'run',
    '--rm',
    '-i',
    '-v', workspaceMount,
    '-v', configMount,
    '-v', opencodeDataMount,
    '-v', sshMount,
    '-w', '/workspace',
    '-e', `OPENCODE_DATA_DIR=/workspace/.ocode`,
    '-e', `HOME=/workspace`,
    ...Object.entries(config.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    config.dockerImage,
    ...args,
  ];

  return new Promise((resolve) => {
    const child = spawn('docker', dockerArgs, {
      stdio: ['inherit', 'inherit', 'inherit'],
      cwd,
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

function runLocal(args) {
  const opencodePath = join(homedir(), '.opencode/bin/opencode');
  if (!existsSync(opencodePath)) {
    console.error('Error: opencode not found at ~/.opencode/bin/opencode');
    console.error('Install opencode first or use Docker mode (default).');
    return Promise.resolve(1);
  }

  return new Promise((resolve) => {
    const child = spawn(opencodePath, args, {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

let caffeinatePid = null;

function startCaffeinate() {
  if (process.platform === 'darwin') {
    try {
      const child = spawn('caffeinate', ['-d', '-i', '-m', '-s', '-u'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      caffeinatePid = child.pid;
      console.error(`[ocode] Started caffeinate (PID: ${caffeinatePid}) to keep Mac awake`);
    } catch (e) {
      console.error('[ocode] Failed to start caffeinate:', e.message);
    }
  }
}

function stopCaffeinate() {
  if (caffeinatePid && process.platform === 'darwin') {
    try {
      process.kill(caffeinatePid, 'SIGTERM');
      console.error(`[ocode] Stopped caffeinate (PID: ${caffeinatePid})`);
    } catch (e) {
      console.error('[ocode] Failed to stop caffeinate:', e.message);
    }
    caffeinatePid = null;
  }
}

async function startProxy() {
  const { spawn, execSync } = await import('child_process');
  const { join } = await import('path');
  const { homedir } = await import('os');
  const { existsSync } = await import('fs');
  const proxySh = join(homedir(), '.opencode/proxy/start.sh');
  if (existsSync(proxySh)) {
    console.error('[ocode] Starting universal proxy...');
    const proxy = spawn('bash', [proxySh], { stdio: 'inherit', detached: false });
    await new Promise(r => setTimeout(r, 3000));
    console.error('[ocode] Universal proxy running at http://127.0.0.1:18080');
    console.error('[ocode] Open http://127.0.0.1:18080 in browser to configure models & RPM');
    try { execSync('open http://127.0.0.1:18080', { stdio: 'ignore' }); } catch {}
  } else {
    console.error('[ocode] Warning: proxy not found at ' + proxySh);
  }
}

function parseArgs(argv) {
  const config = { ...DEFAULT_CONFIG, ...loadConfig() };
  const args = [];
  let command = 'run';
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];

    switch (arg) {
      case '--help':
      case '-h':
        command = 'help';
        break;
      case '--version':
      case '-v':
        command = 'version';
        break;
      case '--local':
        config.dockerImage = '';
        break;
      case '--docker':
        config.dockerImage = 'ocode:latest';
        break;
      case '--format':
      case '-f':
        config.outputFormat = argv[++i] || 'text';
        break;
      case '--quiet':
      case '-q':
        config.quiet = true;
        break;
      case '--cwd':
      case '-c':
        config.cwd = argv[++i] || process.cwd();
        break;
      case '--env':
      case '-e': {
        const [key, value] = (argv[++i] || '').split('=');
        if (key) config.env[key] = value || '';
        break;
      }
      case '--no-auto-approve':
        config.autoApprove = false;
        break;
      case '--keep-awake':
        config.keepAwake = true;
        break;
      case '--no-keep-awake':
        config.keepAwake = false;
        break;
      case '--proxy':
        config.startProxy = true;
        break;
      case '--gui':
        command = 'gui';
        config.dockerImage = '';
        break;
      case '--gui-port':
        config.guiPort = parseInt(argv[++i]) || 4096;
        break;
      case '--build':
        command = 'build';
        break;
      case 'config':
        command = 'config';
        break;
      case 'login':
        command = 'login';
        break;
      case 'all':
        command = 'all';
        break;
      case 'gui':
        command = 'gui';
        config.dockerImage = '';
        break;
      case 'tui':
        command = 'tui';
        config.dockerImage = '';
        break;
      case 'all-tui':
        command = 'all-tui';
        break;
      case 'help':
        command = 'help';
        break;
      case 'keep-awake':
        command = 'keep-awake';
        break;
      case '/keepalive':
      case '/keep-awake':
        command = 'keep-awake';
        break;
      case '--orbstack':
        config.useOrbstack = true;
        config.dockerImage = '';
        break;
      case '--orbstack-on':
        command = 'orbstack-on';
        break;
      case '--orbstack-off':
        command = 'orbstack-off';
        break;
      case '--orbstack-config':
        command = 'orbstack-config';
        break;
      case '--orbstack-project':
        command = 'orbstack-project';
        break;
      default: {
        const dashMatch = arg.match(/^(gui|tui)(?:-(proxy|keep-?awake))*$/i);
        if (dashMatch) {
          command = dashMatch[1].toLowerCase();
          config.dockerImage = '';
          const parts = arg.toLowerCase().split('-').filter(p => p !== command);
          config.startProxy = parts.some(p => p === 'proxy');
          if (parts.some(p => p === 'keep' || p === 'awake' || p === 'keepawake')) {
            config.keepAwake = true;
          }
          break;
        }
        args.push(arg);
      }
    }
    i++;
  }

  return { args, config, command };
}

function printHelp() {
  console.log(`
ocode - OpenCode wrapper with native macOS support (Homebrew tools, Orbstack optional)

Usage:
  ocode [options] [prompt]
  ocode <command> [options]

Commands:
  run (default)    Run a prompt in headless mode
  gui              Launch GUI web interface (same backend, visual frontend)
  tui              Launch interactive terminal UI
  all              Launch GUI + Proxy + Keep-awake (all-in-one)
  all-tui          Launch TUI + Proxy + Keep-awake (all-in-one)
  config           Manage configuration
  build            Build Docker image (optional)
  login            Authenticate with providers
  help             Show this help
  version          Show version

Options:
  -p, --prompt <text>     Prompt to run (non-interactive mode)
  -f, --format <format>   Output format: text, json (default: text)
  -q, --quiet             Hide spinner in non-interactive mode
  -c, --cwd <dir>         Working directory (default: current dir)
  -e, --env <key=value>   Set environment variable
  --docker                Run in Docker sandbox (optional, Linux VM)
  --orbstack              Use Orbstack VM for isolation (lazy-loaded)
  --orbstack-on           Enable Orbstack for this project
  --orbstack-off          Disable Orbstack for this project
  --orbstack-config       Show Orbstack config for current project
  --orbstack-project      Show Orbstack project status
  --no-auto-approve       Disable auto-approval of permissions
  --keep-awake            Keep Mac awake while agent is working (macOS only)
  --no-keep-awake         Disable keep-awake (default)
  --proxy                 Start universal proxy alongside (composable)
  --gui                   Launch GUI web interface (same backend, visual frontend)
  --gui-port <port>       Port for GUI web server (default: 4096)
  --build                 Build Docker image (optional)
  -h, --help              Show help
  -v, --version           Show version

Examples:
  ocode -p "Explain the codebase"
  ocode -p "Add tests for auth" -f json
  ocode -p "Long task" --keep-awake
  ocode config set keepAwake true
  ocode gui --gui-port 4097
  ocode gui --proxy               # GUI + proxy
  ocode gui --proxy --keep-awake  # GUI + proxy + keep-awake
  ocode gui-proxy-keepawake       # Same, hyphenated
  ocode tui                       # Terminal UI
  ocode tui --proxy               # TUI + proxy
  ocode tui-proxy-keepawake       # TUI + proxy + keep-awake
  ocode --docker -p "Run in Docker sandbox"
  ocode --orbstack -p "Run in Orbstack sandbox"
  ocode --orbstack-on
  ocode --orbstack-project
  ocode build
  ocode all                      # GUI + Proxy + Keep-awake
  ocode all --skip-permissions   # Same + auto-approve all tools
  ocode all-tui                  # TUI + Proxy + Keep-awake
`);
}

function printVersion() {
  console.log('ocode 1.0.0 (wrapper for opencode)');
}

async function handleConfig(args) {
  const config = loadConfig();

  if (args.length === 0 || args[0] === 'get') {
    console.log(JSON.stringify(config, null, 2));
    return 0;
  }

  if (args[0] === 'set') {
    if (args.length < 3) {
      console.error('Usage: ocode config set <key> <value>');
      return 1;
    }
    const key = args[1];
    const value = args[2];
    config[key] = value;
    saveConfig(config);
    console.log(`Set ${key} = ${value}`);
    return 0;
  }

  if (args[0] === 'reset') {
    saveConfig({});
    console.log('Config reset to defaults');
    return 0;
  }

  console.error(`Unknown config command: ${args[0]}`);
  return 1;
}

async function handleLogin(args) {
  const config = { ...DEFAULT_CONFIG, ...loadConfig() };
  const dockerArgs = ['login', ...args];

  if (config.dockerImage) {
    return runInDocker(dockerArgs, config);
  } else {
    return runLocal(dockerArgs);
  }
}

async function handleGui(config) {
  const opencodePath = join(homedir(), '.opencode/bin/opencode');
  if (!existsSync(opencodePath)) {
    console.error('Error: opencode not found at ~/.opencode/bin/opencode');
    console.error('Install opencode first.');
    return 1;
  }

  if (config.keepAwake) {
    startCaffeinate();
    process.on('exit', stopCaffeinate);
    process.on('SIGINT', () => { stopCaffeinate(); process.exit(130); });
    process.on('SIGTERM', () => { stopCaffeinate(); process.exit(143); });
  }

  let port = config.guiPort;
  try {
    const { execSync } = await import('child_process');
    while (true) {
      try {
        execSync(`lsof -ti:${port} 2>/dev/null`, { stdio: 'pipe' });
        port++;
      } catch {
        break;
      }
    }
  } catch {}
  if (port !== config.guiPort) {
    console.error(`[ocode] Port ${config.guiPort} in use, using port ${port} instead`);
  }

  console.error(`[ocode] Starting GUI web interface on port ${port}...`);
  console.error(`[ocode] Open http://localhost:${port} in your browser`);

  const guiArgs = [
    'web',
    '--port', String(port),
    '--hostname', '0.0.0.0',
    '--log-level', 'INFO'
  ];

  return new Promise((resolve) => {
    const child = spawn(opencodePath, guiArgs, {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    child.on('exit', (code) => {
      stopCaffeinate();
      resolve(code ?? 1);
    });
    child.on('error', (err) => {
      stopCaffeinate();
      console.error('[ocode] Failed to start GUI:', err.message);
      resolve(1);
    });
  });
}

async function handleGuiDocker(config) {
  if (!ensureDockerImage()) {
    console.error('Failed to build/verify Docker image');
    return 1;
  }
  if (config.keepAwake) {
    startCaffeinate();
    process.on('exit', stopCaffeinate);
    process.on('SIGINT', () => { stopCaffeinate(); process.exit(130); });
    process.on('SIGTERM', () => { stopCaffeinate(); process.exit(143); });
  }
  console.error(`[ocode] Starting GUI web interface in Docker on port ${config.guiPort}...`);
  const guiArgs = ['web', '--port', String(config.guiPort), '--hostname', '0.0.0.0'];
  return runInDocker(guiArgs, config);
}

async function handleTui(config) {
  const opencodePath = join(homedir(), '.opencode/bin/opencode');
  if (!existsSync(opencodePath)) {
    console.error('Error: opencode not found at ~/.opencode/bin/opencode');
    return 1;
  }

  if (config.keepAwake) {
    startCaffeinate();
    process.on('exit', stopCaffeinate);
    process.on('SIGINT', () => { stopCaffeinate(); process.exit(130); });
    process.on('SIGTERM', () => { stopCaffeinate(); process.exit(143); });
  }

  console.error('[ocode] Starting interactive TUI...');

  return new Promise((resolve) => {
    const child = spawn(opencodePath, [], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    child.on('exit', (code) => {
      stopCaffeinate();
      resolve(code ?? 1);
    });
    child.on('error', (err) => {
      stopCaffeinate();
      console.error('[ocode] Failed to start TUI:', err.message);
      resolve(1);
    });
  });
}

async function handleAll(config, args) {
  const skipPermissions = args.includes('--skip-permissions') || args.includes('-y');
  
  config.useOrbstack = true;
  config.dockerImage = '';
  config.keepAwake = true;
  
  if (skipPermissions) {
    config.autoApprove = true;
  }
  
  saveConfig(config);
  
  console.error('[ocode] Starting all-in-one: GUI + Proxy + Keep-awake' + (skipPermissions ? ' + Skip-permissions' : ''));
  
  const { spawn, execSync } = await import('child_process');
  const { join } = await import('path');
  const { homedir } = await import('os');
  const { existsSync } = await import('fs');
  
  const proxySh = join(homedir(), '.opencode/proxy/start.sh');
  if (existsSync(proxySh)) {
    console.error('[ocode] Starting universal proxy...');
    const { spawn } = await import('child_process');
    const proxy = spawn('bash', [proxySh], {
      stdio: 'inherit',
      detached: false,
    });
    await new Promise(r => setTimeout(r, 3000));
    console.error('[ocode] Universal proxy running at http://127.0.0.1:18080');
    console.error('[ocode] Open http://127.0.0.1:18080 in browser to configure models & RPM');
    try {
      execSync('open http://127.0.0.1:18080', { stdio: 'ignore' });
    } catch {}
  } else {
    console.error('[ocode] Warning: proxy not found at ' + proxySh);
  }
  
  if (config.keepAwake) {
    const { spawn } = await import('child_process');
    const caffeinate = spawn('caffeinate', ['-d', '-i', '-m', '-s', '-u'], {
      detached: true,
      stdio: 'ignore'
    });
    caffeinate.unref();
    console.error('[ocode] Started caffeinate to keep Mac awake');
  }
  
  const opencodePath = join(homedir(), '.opencode/bin/opencode');
  
  if (!existsSync(opencodePath)) {
    console.error('Error: opencode not found at ~/.opencode/bin/opencode');
    return 1;
  }
  
  let port = config.guiPort;
  try {
    const { execSync } = await import('child_process');
    while (true) {
      try {
        execSync(`lsof -ti:${port} 2>/dev/null`, { stdio: 'pipe' });
        port++;
      } catch {
        break;
      }
    }
  } catch {}
  if (port !== config.guiPort) {
    console.error(`[ocode] Port ${config.guiPort} in use, using port ${port} instead`);
  }
  
  const guiArgs = [
    'web',
    '--port', String(port),
    '--hostname', '0.0.0.0',
    '--log-level', 'INFO'
  ];
  
  return new Promise((resolve) => {
    const child = spawn(opencodePath, guiArgs, {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error('[ocode] Failed to start:', err.message);
      resolve(1);
    });
  });
}

async function handleAllTui(config, args) {
  const skipPermissions = args.includes('--skip-permissions') || args.includes('-y');

  config.useOrbstack = true;
  config.dockerImage = '';
  config.keepAwake = true;

  if (skipPermissions) {
    config.autoApprove = true;
  }

  saveConfig(config);

  console.error('[ocode] Starting all-in-one TUI: Proxy + Keep-awake + TUI' + (skipPermissions ? ' + Skip-permissions' : ''));

  await startProxy();

  if (config.keepAwake) {
    const { spawn } = await import('child_process');
    const caffeinate = spawn('caffeinate', ['-d', '-i', '-m', '-s', '-u'], {
      detached: true,
      stdio: 'ignore'
    });
    caffeinate.unref();
    console.error('[ocode] Started caffeinate to keep Mac awake');
  }

  const opencodePath = join(homedir(), '.opencode/bin/opencode');

  if (!existsSync(opencodePath)) {
    console.error('Error: opencode not found at ~/.opencode/bin/opencode');
    return 1;
  }

  return new Promise((resolve) => {
    const child = spawn(opencodePath, [], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      console.error('[ocode] Failed to start TUI:', err.message);
      resolve(1);
    });
  });
}

async function handleKeepAwake(config) {
  const current = config.keepAwake === true || config.keepAwake === 'true';
  console.log(`\nKeep-awake is currently: ${current ? 'ON' : 'OFF'}`);
  console.log('Toggle keep-awake? (y/n): ');
  
  const { createInterface } = await import('node:readline');
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    rl.question('', (input) => {
      rl.close();
      const answer = input.trim().toLowerCase();
      
      if (answer === 'y' || answer === 'yes') {
        config.keepAwake = !current;
        saveConfig(config);
        console.log(`\nKeep-awake: ${!current ? 'ACTIVATED' : 'DEACTIVATED'}`);
        console.log(`Next run will ${!current ? 'keep Mac awake' : 'allow normal sleep'}.`);
      } else {
        console.log('\nCancelled - no change.');
      }
      resolve(0);
    });
  });
}

async function handleOrbstackOn(config) {
  config.useOrbstack = true;
  config.dockerImage = '';
  saveConfig(config);
  console.log('Orbstack enabled for this project');
  return 0;
}

async function handleOrbstackOff(config) {
  config.useOrbstack = false;
  saveConfig(config);
  console.log('Orbstack disabled for this project');
  return 0;
}

async function handleOrbstackConfig(config) {
  console.log(JSON.stringify({ useOrbstack: config.useOrbstack }, null, 2));
  return 0;
}

async function handleOrbstackProject(config) {
  const { basename } = await import('path');
  const projectPath = process.cwd();
  const projectName = basename(process.cwd());
  console.log(`Project: ${config.useOrbstack ? 'Orbstack ON' : 'Orbstack OFF (local)'}`);
  console.log(`Project path: ${process.cwd()}`);
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const { args, config, command } = parseArgs(argv);

  switch (command) {
    case 'help':
      printHelp();
      process.exit(0);
    case 'version':
      printVersion();
      process.exit(0);
    case 'build':
      process.exit(buildDockerImage() ? 0 : 1);
    case 'config':
      process.exit(await handleConfig(args));
    case 'login':
      process.exit(await handleLogin(args));
    case 'keep-awake':
      process.exit(await handleKeepAwake(config));
    case 'all':
      process.exit(await handleAll(config, args));
    case 'all-tui':
      process.exit(await handleAllTui(config, args));
    case 'gui':
      if (config.startProxy) await startProxy();
      if (!config.dockerImage) {
        process.exit(await handleGui(config));
      } else {
        process.exit(await handleGuiDocker(config));
      }
    case 'tui':
      if (config.startProxy) await startProxy();
      process.exit(await handleTui(config));
    case 'orbstack-on':
      process.exit(await handleOrbstackOn(config));
    case 'orbstack-off':
      process.exit(await handleOrbstackOff(config));
    case 'orbstack-config':
      process.exit(await handleOrbstackConfig(config));
    case 'orbstack-project':
      process.exit(await handleOrbstackProject(config));
    case 'run':
      break;
    default:
      // No command, no args -> launch interactive TUI
      if (argv.length === 0) {
        const { join } = await import('path');
        const { homedir } = await import('os');
        const { spawn } = await import('child_process');
        const opencodePath = join(homedir(), '.opencode/bin/opencode');
        const child = spawn(opencodePath, [], { stdio: 'inherit', cwd: process.cwd() });
        child.on('exit', (code) => process.exit(code ?? 0));
        return;
      }
      break;
  }

  if (config.keepAwake) {
    startCaffeinate();
    process.on('exit', stopCaffeinate);
    process.on('SIGINT', () => { stopCaffeinate(); process.exit(130); });
    process.on('SIGTERM', () => { stopCaffeinate(); process.exit(143); });
  }

  // Extract prompt from -p/--prompt or first non-flag arg
  let prompt = '';
  let remainingArgs = [];
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-p' || args[i] === '--prompt') && i + 1 < args.length) {
      prompt = args[i + 1];
      i++;
    } else if (!args[i].startsWith('-')) {
      prompt = args[i];
    } else {
      remainingArgs.push(args[i]);
    }
  }

  if (config.useOrbstack) {
    const { spawnSync } = await import('child_process');
    const orbstackArgs = ['-p', prompt];
    if (config.outputFormat === 'json') orbstackArgs.push('--format', 'json');
    if (config.quiet) orbstackArgs.push('--quiet');
    orbstackArgs.push(...remainingArgs);
    const result = spawnSync(join(LOCAL_BIN, 'ocode-orbstack'), orbstackArgs, {
      stdio: 'inherit',
      cwd: process.cwd()
    });
    process.exit(result.status ?? 1);
  } else if (!config.dockerImage) {
    ensureTools();
    if (prompt) {
      const opencodeArgs = ['run', prompt, '--dangerously-skip-permissions'];
      if (config.outputFormat === 'json') opencodeArgs.push('--format', 'json');
      opencodeArgs.push(...remainingArgs);
      process.exit(await runLocal(opencodeArgs));
    } else {
      // No prompt -> interactive TUI
      const { join } = await import('path');
      const { homedir } = await import('os');
      const { spawn } = await import('child_process');
      const opencodePath = join(homedir(), '.opencode/bin/opencode');
      const child = spawn(opencodePath, remainingArgs, { stdio: 'inherit', cwd: process.cwd() });
      child.on('exit', (code) => process.exit(code ?? 0));
    }
  } else {
    if (!ensureDockerImage()) {
      console.error('Failed to build/verify Docker image');
      process.exit(1);
    }
    if (prompt) {
      const opencodeArgs = ['-p', prompt];
      if (config.outputFormat === 'json') opencodeArgs.push('-f', 'json');
      if (config.quiet) opencodeArgs.push('-q');
      opencodeArgs.push(...remainingArgs);
      process.exit(await runInDocker(opencodeArgs, config));
    } else {
      // Docker interactive
      const { join } = await import('path');
      const { homedir } = await import('os');
      const { spawn } = await import('child_process');
      const opencodePath = join(homedir(), '.opencode/bin/opencode');
      const child = spawn(opencodePath, remainingArgs, { stdio: 'inherit', cwd: process.cwd() });
      child.on('exit', (code) => process.exit(code ?? 0));
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  stopCaffeinate();
  process.exit(1);
});
