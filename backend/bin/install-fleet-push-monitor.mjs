
// Install a launchd agent that runs the Supabase fleet-push monitor every 15 minutes.
// Logs: ~/Library/Logs/frwhoop-fleet-push-monitor.log (exit 1 lines = alert).
// Remove: launchctl unload ~/Library/LaunchAgents/com.frwhoop.fleetpush.monitor.plist
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(backend, '..');
const node = process.execPath;
const label = 'com.frwhoop.fleetpush.monitor';
const agents = path.join(os.homedir(), 'Library', 'LaunchAgents');
const logs = path.join(os.homedir(), 'Library', 'Logs');
fs.mkdirSync(agents, { recursive: true });
fs.mkdirSync(logs, { recursive: true });

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>WorkingDirectory</key><string>${xml(repo)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(path.join(backend, 'bin', 'monitor-fleet-push.mjs'))}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(path.dirname(node))}:/usr/bin:/bin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${xml(path.join(logs, 'frwhoop-fleet-push-monitor.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, 'frwhoop-fleet-push-monitor.log'))}</string>
</dict>
</plist>
`;
const plistPath = path.join(agents, `${label}.plist`);
fs.writeFileSync(plistPath, plist);
spawnSync('launchctl', ['unload', plistPath]);
const r = spawnSync('launchctl', ['load', plistPath]);
if (r.error) { console.error(String(r.error)); process.exit(1); }
console.log(`Installed + loaded ${label} (every 15 min; log ${path.join(logs, 'frwhoop-fleet-push-monitor.log')})`);
