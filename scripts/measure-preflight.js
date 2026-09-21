/**
 * Preflight for every comparison measurement: records the machine state and refuses to measure when THIS repository left
 * processes behind. Output files must go to docs/results-data (never the scratchpad).
 *   const { preflight, resultsPath } = require('./measure-preflight');
 *   const state = preflight();           // { freeMemGB, loadHint, strayRepoNodeProcesses, otherNodeProcesses: {count, MB}, ... }
 *
 * "Stray" = a node process whose command line points into THIS repository (scripts/test-*, scripts/measure-*, dist/) other than
 * the current process. Node processes of other tools (Codex runtimes, MCP servers, other projects) are only REPORTED: they are not
 * ours to kill and their parents are alive.
 */
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

function nodeProcesses() {
  if (process.platform !== 'win32') return [];
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId, WorkingSetSize, CommandLine | ConvertTo-Json -Compress";
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 20_000 });
    const parsed = JSON.parse(out || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ pid: p.ProcessId, mb: Math.round((p.WorkingSetSize || 0) / 1048576), cmd: String(p.CommandLine || '') }));
  } catch { return []; }
}

function preflight({ failOnStray = true } = {}) {
  const procs = nodeProcesses().filter((p) => p.pid !== process.pid);
  const mine = procs.filter((p) => p.cmd.toLowerCase().includes(repoRoot.toLowerCase().replace(/\\/g, '\\')) || /parpar sagol/i.test(p.cmd));
  const others = procs.filter((p) => !mine.includes(p));
  const state = {
    at: new Date().toISOString(),
    freeMemGB: +(os.freemem() / 1e9).toFixed(1), totalMemGB: +(os.totalmem() / 1e9).toFixed(1),
    load1m: os.loadavg()[0],
    strayRepoNodeProcesses: mine.map((p) => ({ pid: p.pid, mb: p.mb, cmd: p.cmd.slice(0, 160) })),
    otherNodeProcesses: { count: others.length, MB: others.reduce((a, p) => a + p.mb, 0) },
  };
  if (mine.length && failOnStray) {
    console.error('PREFLIGHT FAILED: node processes from this repository are still running (a test/measurement script that did not exit):');
    for (const p of state.strayRepoNodeProcesses) console.error(`  pid=${p.pid} ${p.mb}MB ${p.cmd}`);
    process.exit(3);
  }
  return state;
}

/** Results always land in docs/results-data. */
function resultsPath(name) { return path.join(repoRoot, 'docs', 'results-data', name); }

module.exports = { preflight, resultsPath };
if (require.main === module) console.log(JSON.stringify(preflight({ failOnStray: false }), null, 1));
