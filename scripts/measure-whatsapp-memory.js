#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const distIndex = path.join(repoRoot, 'dist', 'index.js');
const labRoot = path.join(repoRoot, 'data', 'memory-lab');
const durationMs = Number(process.env.MEMORY_MEASURE_DURATION_MS || 120000);
const sampleIntervalMs = Number(process.env.MEMORY_MEASURE_INTERVAL_MS || 5000);

const clients = [
  { name: 'webjs-client', provider: 'WEB_JS', port: 3101 },
  { name: 'baileys-client', provider: 'BAILEYS', port: 3102 },
];

function ensureBuilt() {
  if (!fs.existsSync(distIndex)) {
    throw new Error('dist/index.js is missing. Run `npm.cmd run build` first.');
  }
}

function writeStorageFixture(clientDir) {
  fs.mkdirSync(clientDir, { recursive: true });
  const now = new Date().toISOString();
  const storage = {
    savedContacts: [],
    contactsList: [],
    contactQueue: [],
    campaignResults: [],
    uploadedFiles: [],
    clientProfile: { whatsappPhone: '' },
    adminSettings: {
      askNameEnabled: false,
      nameTimeoutMinutes: 5,
      contactsProvider: 'manual',
      askNameText: 'Memory lab name prompt',
      replyText: 'Memory lab reply',
      followupMessages: [],
      decisionFlow: [],
      referralPrefix: 'הגעתי דרך ',
      botSuffix: ' - (Bot)',
    },
    campaigns: [
      {
        id: 'memory-lab-campaign',
        name: 'Memory Lab Campaign',
        triggerType: 1,
        triggerPhrase: 'memory lab',
        suffix: ' - (Bot)',
        active: true,
        conversation: {
          askNameEnabled: false,
          nameTimeoutMinutes: 5,
          askNameText: 'Memory lab name prompt',
          replyText: 'Memory lab reply',
          followupMessages: [],
          decisionFlow: [],
        },
        createdAt: now,
      },
    ],
    twilioOnboarding: {
      businessName: '',
      brandName: '',
      businessWebsite: '',
      businessCategory: '',
      businessDescription: '',
      supportEmail: '',
      supportPhone: '',
      country: 'IL',
      optInDescription: '',
      firstCampaignUseCase: '',
      notes: '',
    },
    twilioTemplates: [],
  };
  fs.writeFileSync(path.join(clientDir, 'contacts.json'), JSON.stringify(storage, null, 2));
}

function execFileText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function getProcessTreeMemory(pid) {
  if (process.platform === 'win32') {
    const script = `
$root=${Number(pid)};
$procs=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,Name;
$ids=New-Object 'System.Collections.Generic.HashSet[int]';
[void]$ids.Add($root);
$changed=$true;
while($changed){
  $changed=$false;
  foreach($p in $procs){
    if($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)){
      [void]$ids.Add([int]$p.ProcessId);
      $changed=$true;
    }
  }
}
$selected=$procs | Where-Object { $ids.Contains([int]$_.ProcessId) };
$bytes=($selected | Measure-Object -Property WorkingSetSize -Sum).Sum;
[pscustomobject]@{
  pid=$root;
  processCount=($selected | Measure-Object).Count;
  rssBytes=[int64]$bytes;
  processes=@($selected | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name; rssBytes=[int64]$_.WorkingSetSize } })
} | ConvertTo-Json -Depth 5 -Compress
`;
    const stdout = await execFileText('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    return JSON.parse(stdout);
  }

  const stdout = await execFileText('ps', ['-eo', 'pid=,ppid=,rss=,comm=']);
  const rows = stdout.trim().split(/\n+/).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) return null;
    return {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      name: match[4],
    };
  }).filter(Boolean);
  const ids = new Set([Number(pid)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (ids.has(row.ppid) && !ids.has(row.pid)) {
        ids.add(row.pid);
        changed = true;
      }
    }
  }
  const processes = rows.filter((row) => ids.has(row.pid));
  return {
    pid: Number(pid),
    processCount: processes.length,
    rssBytes: processes.reduce((sum, row) => sum + row.rssBytes, 0),
    processes,
  };
}

async function stopProcessTree(pid) {
  if (process.platform === 'win32') {
    const script = `
$root=${Number(pid)};
$procs=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId;
$ids=New-Object 'System.Collections.Generic.HashSet[int]';
[void]$ids.Add($root);
$changed=$true;
while($changed){
  $changed=$false;
  foreach($p in $procs){
    if($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)){
      [void]$ids.Add([int]$p.ProcessId);
      $changed=$true;
    }
  }
}
$ids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
`;
    await execFileText('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]).catch(() => '');
    return;
  }
  process.kill(-pid, 'SIGTERM');
}

function startClient(client) {
  const clientDir = path.join(labRoot, client.name);
  writeStorageFixture(clientDir);
  const logPath = path.join(clientDir, 'run.log');
  const out = fs.openSync(logPath, 'w');
  const child = spawn(process.execPath, [distIndex], {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      WHATSAPP_PROVIDER: client.provider,
      BAILEYS_FALLBACK_TO_WEBJS: process.env.BAILEYS_FALLBACK_TO_WEBJS || 'false',
      CLIENT_ACCESS_TOKEN: `memory-${client.provider.toLowerCase()}`,
      CONTACTS_PROVIDER: 'manual',
      PORT: String(client.port),
      STORAGE_PATH: path.join(clientDir, 'contacts.json'),
      SESSION_PATH: path.join(clientDir, 'session'),
      UPLOADS_PATH: path.join(clientDir, 'uploads'),
      GOOGLE_TOKEN_PATH: path.join(clientDir, 'google-token.json'),
      OWNER_STORAGE_PATH: path.join(clientDir, 'owner', 'clients.json'),
    },
  });
  return { child, logPath, clientDir };
}

function summarizeSamples(samples) {
  const rssValues = samples.map((sample) => sample.rssBytes).filter((value) => value > 0);
  const processCounts = samples.map((sample) => sample.processCount);
  return {
    samples: samples.length,
    minMb: Math.round(Math.min(...rssValues) / 1024 / 1024),
    maxMb: Math.round(Math.max(...rssValues) / 1024 / 1024),
    avgMb: Math.round((rssValues.reduce((sum, value) => sum + value, 0) / rssValues.length) / 1024 / 1024),
    maxProcessCount: Math.max(...processCounts),
  };
}

async function measureClient(client) {
  const runtime = startClient(client);
  const samples = [];
  const startedAt = Date.now();
  console.log(`[${client.provider}] started pid=${runtime.child.pid} port=${client.port}`);

  try {
    while (Date.now() - startedAt < durationMs) {
      await new Promise((resolve) => setTimeout(resolve, sampleIntervalMs));
      const memory = await getProcessTreeMemory(runtime.child.pid).catch((err) => ({
        pid: runtime.child.pid,
        processCount: 0,
        rssBytes: 0,
        error: err.message,
      }));
      const sample = {
        at: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        ...memory,
      };
      samples.push(sample);
      console.log(`[${client.provider}] ${Math.round(sample.rssBytes / 1024 / 1024)} MB across ${sample.processCount} processes`);
    }
  } finally {
    await stopProcessTree(runtime.child.pid);
  }

  const result = {
    client,
    pid: runtime.child.pid,
    logPath: runtime.logPath,
    durationMs,
    sampleIntervalMs,
    summary: summarizeSamples(samples),
    samples,
  };
  fs.writeFileSync(path.join(runtime.clientDir, 'memory-result.json'), JSON.stringify(result, null, 2));
  return result;
}

function writeMarkdownReport(results) {
  const reportPath = path.join(labRoot, `memory-report-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  const rows = results.map((result) => {
    const summary = result.summary;
    return `| ${result.client.provider} | ${summary.avgMb} MB | ${summary.maxMb} MB | ${summary.maxProcessCount} | ${result.logPath} |`;
  }).join('\n');
  const text = [
    '# WhatsApp Provider Memory Lab',
    '',
    `Duration: ${Math.round(durationMs / 1000)}s per provider  `,
    `Sample interval: ${Math.round(sampleIntervalMs / 1000)}s  `,
    `Fallback: ${process.env.BAILEYS_FALLBACK_TO_WEBJS || 'false'}`,
    '',
    '| Provider | Avg RSS | Max RSS | Max process count | Log |',
    '| --- | ---: | ---: | ---: | --- |',
    rows,
    '',
    'Notes:',
    '',
    '- RSS includes the Node process and child processes. For WEB_JS this should include Chromium when it starts.',
    '- Each provider uses an isolated local client directory under data/memory-lab.',
    '- The fixture creates one active campaign so the scheduler starts the WhatsApp provider.',
    '',
  ].join('\n');
  fs.writeFileSync(reportPath, text);
  return reportPath;
}

async function main() {
  ensureBuilt();
  fs.mkdirSync(labRoot, { recursive: true });
  const results = [];
  for (const client of clients) {
    results.push(await measureClient(client));
  }
  const reportPath = writeMarkdownReport(results);
  console.log(`Memory report: ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
