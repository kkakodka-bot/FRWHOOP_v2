/**
 * Map the app prefs blob onto typed public.user_settings columns
 * (migration 20260824190000). Extra nested domains stay in extra_settings.
 */

function parseBedtimeLabel(label) {
  if (label == null || String(label).trim() === '' || String(label).toLowerCase() === 'off') {
    return { enabled: false, time: '22:30' };
  }
  const raw = String(label).trim();
  const m12 = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m12) {
    let h = Number(m12[1]) % 12;
    if (/pm/i.test(m12[3])) h += 12;
    return { enabled: true, time: `${String(h).padStart(2, '0')}:${m12[2]}` };
  }
  const m24 = raw.match(/^(\d{2}):(\d{2})/);
  if (m24) return { enabled: true, time: `${m24[1]}:${m24[2]}` };
  return { enabled: true, time: '22:30' };
}

function flatten(settings = {}) {
  if (settings.prefs && typeof settings.prefs === 'object' && !('notificationsApp' in settings)) {
    return { ...settings.prefs };
  }
  return { ...settings };
}

export function toTypedSettingsRow(settings = {}, userId) {
  const prefs = flatten(settings);
  const bedtime = parseBedtimeLabel(prefs.bedtimeReminder);
  const extra = {};
  if (prefs.targetBedtime) extra.target_bedtime = prefs.targetBedtime;
  if (prefs.wearLocation === 'bicep' || prefs.wearLocation === 'wrist') extra.wear_location = prefs.wearLocation;
  if (Array.isArray(prefs.wearLocationEvents)) extra.wear_location_events = prefs.wearLocationEvents;
  if (prefs.autoWorkoutHaptics === true) extra.auto_workout_haptics_enabled = true;
  if (prefs.autoWorkoutHaptics === false) extra.auto_workout_haptics_enabled = false;
  if (typeof prefs.autoWorkoutMotionRequired === 'boolean') extra.auto_workout_motion_required = prefs.autoWorkoutMotionRequired;
  if (prefs.autoWorkoutMinConfidence) extra.auto_workout_min_confidence = prefs.autoWorkoutMinConfidence;
  if (prefs.autoWorkoutDetectorVersion) extra.auto_workout_detector_version = prefs.autoWorkoutDetectorVersion;
  if (prefs.autoWorkoutRolloutPercentage != null) extra.auto_workout_rollout_percentage = prefs.autoWorkoutRolloutPercentage;
  const activity = String(prefs.activityGoal || 'moderate').toLowerCase();
  const row = {
    user_id: userId,
    notifications_enabled: prefs.notificationsApp !== false,
    haptic_alerts_enabled: prefs.hapticAlerts !== false,
    auto_workout_detect: prefs.autoWorkoutDetect !== false,
    auto_workout_haptics_enabled: prefs.autoWorkoutHaptics === true,
    auto_workout_motion_required: prefs.autoWorkoutMotionRequired === true,
    auto_workout_min_confidence: prefs.autoWorkoutMinConfidence === 'high' ? 'high' : 'standard',
    auto_workout_detector_version: String(prefs.autoWorkoutDetectorVersion || '2.2.1-beta').slice(0, 32),
    auto_workout_rollout_percentage: Number.isFinite(Number(prefs.autoWorkoutRolloutPercentage))
      ? Math.max(0, Math.min(100, Math.round(Number(prefs.autoWorkoutRolloutPercentage))))
      : 100,
    units: prefs.units === 'metric' ? 'metric' : 'imperial',
    activity_goal: ['low', 'moderate', 'high', 'peak'].includes(activity) ? activity : 'moderate',
    calories_goal: Number(prefs.caloriesGoal) || 2400,
    steps_goal: Number(prefs.stepsGoal) || 10000,
    bedtime_reminder_enabled: bedtime.enabled,
    bedtime_reminder_time: bedtime.time,
    sleep_mode: ['PEAK', 'PERFORM', 'GET_BY'].includes(prefs.sleepMode) ? prefs.sleepMode : 'PEAK',
    wake_time: prefs.wakeTime || null,
    recovery_goal: Number.isFinite(Number(prefs.recoveryGoal)) ? Number(prefs.recoveryGoal) : 66,
    sleep_schedule: Array.isArray(prefs.sleepSchedule) ? prefs.sleepSchedule : [0, 1, 2, 3, 4],
    alarm_enabled: Boolean(prefs.alarmEnabled),
    haptic_alarm: prefs.hapticAlarm !== false,
    smart_wake: prefs.smartWake !== false,
    hibernation: Boolean(prefs.hibernation),
    stress_show_sleep: prefs.stressShowSleep !== false,
    stress_alerts: Boolean(prefs.stressAlerts),
    extra_settings: extra,
  };
  return row;
}

export function fromTypedSettingsRow(row) {
  if (!row || typeof row !== 'object') return null;
  const extra = row.extra_settings && typeof row.extra_settings === 'object' ? row.extra_settings : {};
  return {
    settings: {
      notificationsApp: row.notifications_enabled !== false,
      hapticAlerts: row.haptic_alerts_enabled !== false,
      autoWorkoutDetect: row.auto_workout_detect !== false,
      autoWorkoutHaptics: row.auto_workout_haptics_enabled === true
        || (row.auto_workout_haptics_enabled == null && extra.auto_workout_haptics_enabled === true),
      autoWorkoutMotionRequired: row.auto_workout_motion_required === true
        || (row.auto_workout_motion_required == null && extra.auto_workout_motion_required === true),
      autoWorkoutMinConfidence: (row.auto_workout_min_confidence || extra.auto_workout_min_confidence) === 'high'
        ? 'high' : 'standard',
      autoWorkoutDetectorVersion: row.auto_workout_detector_version
        || extra.auto_workout_detector_version || '2.2.1-beta',
      autoWorkoutRolloutPercentage: Number.isFinite(Number(row.auto_workout_rollout_percentage))
        ? Number(row.auto_workout_rollout_percentage)
        : (Number.isFinite(Number(extra.auto_workout_rollout_percentage))
          ? Number(extra.auto_workout_rollout_percentage) : 100),
      units: row.units || 'imperial',
      activityGoal: row.activity_goal || 'moderate',
      caloriesGoal: row.calories_goal,
      stepsGoal: row.steps_goal,
      bedtimeReminder: row.bedtime_reminder_enabled === false ? 'Off' : null,
      sleepMode: row.sleep_mode || 'PEAK',
      wakeTime: row.wake_time || null,
      recoveryGoal: row.recovery_goal,
      sleepSchedule: row.sleep_schedule,
      alarmEnabled: Boolean(row.alarm_enabled),
      hapticAlarm: row.haptic_alarm !== false,
      smartWake: row.smart_wake !== false,
      hibernation: Boolean(row.hibernation),
      stressShowSleep: row.stress_show_sleep !== false,
      stressAlerts: Boolean(row.stress_alerts),
      weeklyPlan: extra.weekly_plan,
      longevity: extra.longevity,
      alarms: extra.alarms,
      permissions: extra.permissions,
      targetBedtime: extra.target_bedtime,
      wearLocation: extra.wear_location === 'bicep' ? 'bicep' : 'wrist',
      wearLocationEvents: Array.isArray(extra.wear_location_events) ? extra.wear_location_events : [],
    },
    updatedAt: row.updated_at || null,
    extra,
  };
}
