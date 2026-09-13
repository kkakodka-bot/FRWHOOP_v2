package com.noop.ui

import android.content.Context
import android.content.Intent
import android.text.format.Formatter
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.noop.R
import com.noop.testcentre.ImuContinuousRecorder
import java.io.File
import java.text.DateFormat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Developer Options → "Record 100 Hz IMU locally" detail screen: live state, honest coverage,
 *  storage/retention, export, and delete. The switch itself also sits inline on the Test Centre
 *  Developer Options section; this screen is where the recording is inspected.
 *
 *  Everything shown here comes from [ImuContinuousRecorder]'s published status/coverage — a
 *  command acknowledgment is never presented as recording, and uncovered seconds are shown as
 *  gaps, never smoothed over. Twin of iOS ImuRecorderView. */
@Composable
fun ImuRecorderScreen(vm: AppViewModel) {
    val context = LocalContext.current
    val recorder = remember { vm.ble.continuousImuRecorder }
    val status by recorder.status.collectAsStateWithLifecycle()
    val coverage by recorder.coverage.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var exporting by remember { mutableStateOf(false) }
    var confirmDeleteAll by remember { mutableStateOf(false) }

    // Coverage walks the timestamp indexes, so it refreshes on this screen's own cadence rather
    // than the recorder's 2 s tick — and only while the screen is alive.
    LaunchedEffect(Unit) {
        while (true) {
            withContext(Dispatchers.IO) { recorder.refreshCoverage() }
            delay(5_000)
        }
    }

    ScreenScaffold(
        title = stringResource(R.string.imu_recorder_title),
        subtitle = stringResource(R.string.imu_recorder_subtitle),
    ) {
        // --- Switch + state ---
        NoopCard {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    Text(
                        stringResource(R.string.imu_recorder_switch),
                        style = NoopType.subhead, color = Palette.textPrimary,
                        modifier = Modifier.weight(1f),
                    )
                    Switch(checked = status.enabled, onCheckedChange = { recorder.setEnabled(it) })
                }
                Text(
                    stringResource(R.string.imu_recorder_blurb),
                    style = NoopType.caption, color = Palette.textTertiary,
                )
                HorizontalDivider(color = Palette.hairline)
                Text(imuRecorderPhaseText(status), style = NoopType.subhead, color = phaseTone(status))
                Text(
                    status.lastLivePacketAt?.let { stringResource(R.string.imu_recorder_last_packet, formatTime(it)) }
                        ?: stringResource(R.string.imu_recorder_no_packets),
                    style = NoopType.caption, color = Palette.textSecondary,
                )
                if (status.recordingSince != null && status.enabled) {
                    Text(
                        stringResource(R.string.imu_recorder_recording_since, formatDateTime(status.recordingSince!!)),
                        style = NoopType.caption, color = Palette.textSecondary,
                    )
                }
                if (status.strayPacketsWhileOff && !status.enabled) {
                    Text(
                        stringResource(R.string.imu_recorder_stray_warning),
                        style = NoopType.caption, color = Palette.statusWarning,
                    )
                }
                if (status.lowDiskPaused) {
                    Text(
                        stringResource(R.string.imu_recorder_low_disk),
                        style = NoopType.caption, color = Palette.statusCritical,
                    )
                }
            }
        }

        // --- Coverage ---
        NoopCard {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.imu_recorder_coverage), style = NoopType.headline, color = Palette.textPrimary)
                Text(
                    stringResource(R.string.imu_recorder_covered, coverage.coveredSeconds, coverage.expectedSeconds),
                    style = NoopType.subhead, color = Palette.textPrimary,
                )
                Text(
                    stringResource(R.string.imu_recorder_gaps, coverage.gapCount),
                    style = NoopType.subhead,
                    color = if (coverage.gapCount == 0) Palette.statusPositive else Palette.statusWarning,
                )
                coverage.firstGap?.let { (start, end) ->
                    Text(
                        stringResource(R.string.imu_recorder_first_gap, timeRange(start, end)),
                        style = NoopType.caption, color = Palette.textSecondary,
                    )
                }
                Text(
                    stringResource(R.string.imu_recorder_gaps_real),
                    style = NoopType.caption, color = Palette.textTertiary,
                )
            }
        }

        // --- Storage ---
        NoopCard {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(R.string.imu_recorder_storage), style = NoopType.headline, color = Palette.textPrimary)
                Text(
                    stringResource(R.string.imu_recorder_disk_use, Formatter.formatShortFileSize(context, coverage.diskBytes)),
                    style = NoopType.subhead, color = Palette.textPrimary,
                )
                Text(stringResource(R.string.imu_recorder_retention_limit), style = NoopType.caption, color = Palette.textSecondary)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    ImuContinuousRecorder.CAP_OPTIONS_BYTES.forEach { cap ->
                        NoopButton(
                            text = Formatter.formatShortFileSize(context, cap),
                            kind = if (status.retentionCapBytes == cap) NoopButtonKind.Primary else NoopButtonKind.Secondary,
                            modifier = Modifier.weight(1f),
                            onClick = { recorder.setRetentionCap(cap) },
                        )
                    }
                }
                Text(
                    stringResource(R.string.imu_recorder_retention_policy),
                    style = NoopType.caption, color = Palette.textTertiary,
                )
                Text(
                    stringResource(
                        R.string.imu_recorder_counters,
                        status.evictedSegments, status.conflicts, status.duplicatesSkipped,
                    ),
                    style = NoopType.caption, color = Palette.textSecondary,
                )
                Text(
                    stringResource(R.string.imu_recorder_battery_warning),
                    style = NoopType.caption, color = Palette.statusWarning,
                )
                NoopButton(
                    text = stringResource(if (exporting) R.string.imu_recorder_exporting else R.string.imu_recorder_export),
                    kind = NoopButtonKind.Secondary,
                    fullWidth = true,
                    enabled = !exporting,
                    onClick = {
                        scope.launch {
                            exporting = true
                            try {
                                exportAndShare(context, recorder)
                            } finally {
                                exporting = false
                            }
                        }
                    },
                )
                NoopButton(
                    text = stringResource(R.string.imu_recorder_delete_all),
                    kind = NoopButtonKind.Destructive,
                    fullWidth = true,
                    enabled = !status.enabled,
                    onClick = { confirmDeleteAll = true },
                )
                if (status.enabled) {
                    Text(
                        stringResource(R.string.imu_recorder_delete_disabled),
                        style = NoopType.caption, color = Palette.textTertiary,
                    )
                }
            }
        }

        // --- Privacy ---
        NoopCard {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.imu_recorder_privacy_title), style = NoopType.headline, color = Palette.textPrimary)
                Text(
                    stringResource(R.string.imu_recorder_privacy),
                    style = NoopType.caption, color = Palette.textSecondary,
                )
            }
        }
    }

    if (confirmDeleteAll) {
        AlertDialog(
            onDismissRequest = { confirmDeleteAll = false },
            title = { Text(stringResource(R.string.imu_recorder_delete_title)) },
            text = { Text(stringResource(R.string.imu_recorder_delete_message)) },
            confirmButton = {
                TextButton(onClick = {
                    confirmDeleteAll = false
                    recorder.deleteAll()
                }) { Text(stringResource(R.string.imu_recorder_delete_confirm), color = Palette.statusCritical) }
            },
            dismissButton = {
                TextButton(onClick = { confirmDeleteAll = false }) { Text(stringResource(R.string.imu_recorder_cancel)) }
            },
        )
    }
}

/** The three Off distinctions the switch contract calls for — "requested off", "stop command
 *  sent", and the owed-stop-pending state — plus the On states, where a command acknowledgment
 *  alone (START_SENT) is never presented as recording. Internal: the Test Centre's Developer
 *  Options section renders the same line under its inline switch. */
@Composable
internal fun imuRecorderPhaseText(status: ImuContinuousRecorder.Status): String = when (status.phase) {
    ImuContinuousRecorder.Phase.OFF -> stringResource(
        if (status.strayPacketsWhileOff) R.string.imu_recorder_phase_off_stray else R.string.imu_recorder_phase_off
    )
    ImuContinuousRecorder.Phase.OFF_STOP_PENDING -> stringResource(R.string.imu_recorder_phase_off_pending)
    ImuContinuousRecorder.Phase.WAITING_FOR_CONNECTION -> stringResource(R.string.imu_recorder_phase_waiting)
    ImuContinuousRecorder.Phase.START_SENT -> stringResource(
        if (status.noPacketsObserved) R.string.imu_recorder_phase_no_packets else R.string.imu_recorder_phase_start_sent
    )
    ImuContinuousRecorder.Phase.RECORDING -> stringResource(R.string.imu_recorder_phase_recording)
    ImuContinuousRecorder.Phase.STOP_SENT -> stringResource(R.string.imu_recorder_phase_stop_sent)
}

@Composable
private fun phaseTone(status: ImuContinuousRecorder.Status): Color = when (status.phase) {
    ImuContinuousRecorder.Phase.OFF -> Palette.textSecondary
    ImuContinuousRecorder.Phase.OFF_STOP_PENDING, ImuContinuousRecorder.Phase.STOP_SENT -> Palette.statusWarning
    ImuContinuousRecorder.Phase.WAITING_FOR_CONNECTION -> Palette.textSecondary
    ImuContinuousRecorder.Phase.START_SENT ->
        if (status.noPacketsObserved) Palette.statusCritical else Palette.statusWarning
    ImuContinuousRecorder.Phase.RECORDING -> Palette.statusPositive
}

private fun formatTime(ms: Long): String =
    DateFormat.getTimeInstance(DateFormat.MEDIUM).format(Date(ms))

private fun formatDateTime(ms: Long): String =
    DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(ms))

private fun timeRange(startSec: Long, endSec: Long): String =
    "${formatTime(startSec * 1_000L)} – ${formatTime(endSec * 1_000L)}"

/** Zip the bundle into the shared logs cache and hand it to the system share sheet — the ONLY way
 *  this data leaves the device, and only on this explicit gesture. */
private suspend fun exportAndShare(context: Context, recorder: ImuContinuousRecorder) {
    val zip = withContext(Dispatchers.IO) {
        val entries = recorder.exportEntries()
        val outDir = File(context.cacheDir, "logs").apply { mkdirs() }
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        val file = File(outDir, "noop-imu-continuous-$stamp.zip")
        ZipOutputStream(file.outputStream().buffered()).use { out ->
            for (entry in entries) {
                out.putNextEntry(ZipEntry(entry.name))
                out.write(entry.data)
                out.closeEntry()
            }
        }
        file
    }
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", zip)
    context.startActivity(
        Intent.createChooser(
            Intent(Intent.ACTION_SEND).apply {
                type = "application/zip"
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_SUBJECT, "NOOP continuous 100 Hz IMU recording")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            },
            context.getString(R.string.imu_recorder_export),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    )
}
