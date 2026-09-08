/**
 * Deterministic synthetic coach-day index.
 *
 * Replaces the old derivative of a personal WHOOP export. Runtime reads
 * backend/data/coach-days.json; this script only regenerates that fixture.
 *
 * Usage: node scripts/generate-coach-days.mjs [--days 120] [--end 2025-06-03]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const argValue = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i > -1 ? process.argv[i + 1] : dflt
}
const DAYS = Math.max(180, Number(argValue('--days', '182')))
const END = argValue('--end', '2025-06-03')
const OUT = path.join(here, '../data/coach-days.json')

function makeRng(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = makeRng(0x4652484f)
const round = (v, d = 1) => Number(v.toFixed(d))
const pad = (n) => String(n).padStart(2, '0')
const dateStr = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
const stamp = (d) =>
  `${dateStr(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
const pick = (arr) => arr[Math.floor(rand() * arr.length)]

const WORKOUTS = {
  Weightlifting: { hr: 110, strain: 5.8, cal: 180 },
  Running: { hr: 152, strain: 8.4, cal: 160 },
  Swimming: { hr: 124, strain: 6.0, cal: 140 },
  Activity: { hr: 118, strain: 5.2, cal: 120 },
}

function synthWorkouts(day) {
  if (rand() > 0.38) return []
  const n = rand() < 0.8 ? 1 : 2
  const out = []
  for (let i = 0; i < n; i++) {
    const name = pick(Object.keys(WORKOUTS))
    const meta = WORKOUTS[name]
    const startMin = 9 * 60 + Math.floor(rand() * 12 * 60)
    const durationMin = 25 + Math.floor(rand() * 50)
    const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0, startMin))
    const end = new Date(start.getTime() + durationMin * 60000)
    const z1 = Math.round(30 + rand() * 40)
    const z2 = Math.round(rand() * 30)
    const z3 = Math.round(rand() * 20)
    const z4 = Math.round(rand() * 8)
    const z5 = Math.max(0, 100 - z1 - z2 - z3 - z4)
    out.push({
      name,
      start: stamp(start),
      end: stamp(end),
      durationMin,
      strain: round(meta.strain + rand() * 2.4, 1),
      calories: Math.round(meta.cal + rand() * 80),
      avgHr: Math.round(meta.hr + (rand() - 0.5) * 12),
      maxHr: Math.round(meta.hr + 18 + rand() * 20),
      zones: [z1, z2, z3, z4, z5],
    })
  }
  return out
}

function synthRow(day) {
  const nap = rand() < 0.12
  const inBedMin = nap ? 70 + Math.floor(rand() * 50) : 420 + Math.floor(rand() * 140)
  const awakeMin = nap ? 4 + Math.floor(rand() * 12) : 40 + Math.floor(rand() * 70)
  const asleepMin = inBedMin - awakeMin
  const deepMin = Math.round(asleepMin * (0.18 + rand() * 0.08))
  const remMin = Math.round(asleepMin * (0.18 + rand() * 0.1))
  const lightMin = Math.max(0, asleepMin - deepMin - remMin)
  const onsetMin = nap ? 12 * 60 + Math.floor(rand() * 240) : 23 * 60 + Math.floor(rand() * 90) - 24 * 60
  const base = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())
  const sleepOnset = stamp(new Date(base + onsetMin * 60000))
  const wakeOnset = stamp(new Date(base + onsetMin * 60000 + inBedMin * 60000))
  const workouts = synthWorkouts(day)
  const strain = workouts.length
    ? round(Math.max(...workouts.map((w) => w.strain)) + 2.2 + rand() * 3.5, 1)
    : round(4.2 + rand() * 4.8, 1)
  return {
    day: dateStr(day),
    recovery: Math.round(40 + rand() * 50),
    strain,
    hrv: Math.round(55 + rand() * 35),
    rhr: Math.round(52 + rand() * 12),
    resp: round(12.4 + rand() * 1.4, 1),
    spo2: round(94.2 + rand() * 3.2, 2),
    skinTemp: round(33.4 + rand() * 1.2, 2),
    calories: Math.round(1600 + rand() * 900 + workouts.reduce((s, w) => s + w.calories, 0)),
    avgHr: Math.round(64 + rand() * 16),
    maxHr: workouts.length ? Math.max(...workouts.map((w) => w.maxHr)) : Math.round(120 + rand() * 30),
    sleepPerformance: Math.round(55 + rand() * 40),
    sleepEfficiency: Math.round(78 + rand() * 16),
    sleepConsistency: Math.round(40 + rand() * 45),
    asleepMin,
    inBedMin,
    lightMin,
    deepMin,
    remMin,
    awakeMin,
    sleepNeedMin: Math.round(480 + rand() * 80),
    sleepDebtMin: Math.round(rand() * 110),
    sleepOnset,
    wakeOnset,
    nap,
    workouts,
  }
}

const end = new Date(`${END}T00:00:00Z`)
const days = []
for (let i = DAYS - 1; i >= 0; i--) {
  days.push(synthRow(new Date(end.getTime() - i * 86400000)))
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, `${JSON.stringify({ generatedFrom: 'synthetic-demo', days })}\n`)
console.log(`wrote ${OUT} (${DAYS} days, ${fs.statSync(OUT).size} bytes)`)
