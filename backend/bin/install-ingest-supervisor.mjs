#!/usr/bin/env node
/**
 * Install a launchd KeepAlive supervisor for the FRWHOOP ingest API.
 * Does not kill a healthy unmanaged process — the supervisor adopts on exit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const label = 'com.rahulvijayan.frwhoop.ingest';
const agents = path.join(os.homedir(), 'Library', 'LaunchAgents');
const plistPath = path.join(agents, `${label}.plist`);
const supervise = path.join(backend, 'bin', 'supervise-ingest.mjs');
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
  <key>WorkingDirectory</key><string>${xml(backend)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(supervise)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(path.dirname(node))}:/usr/bin:/bin</string>
    <key>PORT</key>
    <string>8080</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>${xml(path.join(logs, 'frwhoop-ingest.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logs, 'frwhoop-ingest.err'))}</string>
</dict>
</plist>
`;
fs.writeFileSync(plistPath, plist);

const uid = process.getuid?.() ?? '';
const domain = `gui/${uid}`;
spawnSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
const loaded = spawnSync('launchctl', ['bootstrap', domain, plistPath], { encoding: 'utf8' });
if (loaded.status !== 0) {
  console.error(loaded.stderr || loaded.stdout || 'launchctl bootstrap failed');
  process.exit(loaded.status || 1);
}
console.log(`ingest_supervisor ${plistPath}`);
