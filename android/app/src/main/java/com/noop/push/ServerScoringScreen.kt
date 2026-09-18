package com.noop.push

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudSync
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.noop.R
import com.noop.ui.NoopButton
import com.noop.ui.NoopButtonKind
import com.noop.ui.NoopType
import com.noop.ui.Palette
import com.noop.ui.ScreenScaffold
import com.noop.ui.SettingsCard
import com.noop.ui.SettingsToggleRow
import kotlinx.coroutines.launch

/** Settings > Advanced controls the same owner-fenced repository used by the physiology views. */
@Composable
fun ServerScoringScreen(scores: ServerScoreRepository) {
    val context = LocalContext.current
    val enabled by scores.enabled.collectAsStateWithLifecycle()
    val signedIn by scores.signedIn.collectAsStateWithLifecycle()
    val error by scores.lastError.collectAsStateWithLifecycle()
    var email by remember { mutableStateOf(ServerScoringSettings.authEmail(context)) }
    var password by remember { mutableStateOf("") }
    var working by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val configured = ServerScoringSettings.supabaseProjectUrl() != null && ServerScoringSettings.anonKey() != null
    ScreenScaffold(title = stringResource(R.string.server_scoring_title),
        subtitle = stringResource(R.string.server_scoring_description)) {
        SettingsCard(icon = Icons.Filled.CloudSync, title = stringResource(R.string.server_scoring_title),
            blurb = stringResource(R.string.server_scoring_description)) {
            SettingsToggleRow(title = stringResource(R.string.server_scoring_use_server),
                detail = stringResource(R.string.server_scoring_mode_detail), checked = enabled,
                onCheckedChange = { value ->
                    scores.setEnabled(value)
                    if (value) scope.launch { scores.refreshVisibleDays() }
                })
        }
        SettingsCard(icon = Icons.Outlined.AccountCircle, title = stringResource(R.string.server_scoring_sign_in),
            blurb = stringResource(if (signedIn) R.string.server_scoring_signed_in else R.string.physiology_hrv_sign_in)) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (!configured) Text(stringResource(R.string.physiology_hrv_configure), style = NoopType.footnote, color = Palette.statusWarning)
                OutlinedTextField(value = email, onValueChange = { email = it }, singleLine = true,
                    label = { Text(stringResource(R.string.server_scoring_email)) }, modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
                OutlinedTextField(value = password, onValueChange = { password = it }, singleLine = true,
                    label = { Text(stringResource(R.string.server_scoring_password)) }, modifier = Modifier.fillMaxWidth(),
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
                NoopButton(text = stringResource(if (working) R.string.server_scoring_signing_in else R.string.server_scoring_sign_in),
                    kind = NoopButtonKind.Secondary, fullWidth = true,
                    enabled = enabled && configured && !working && email.isNotBlank() && password.isNotEmpty(), onClick = {
                        working = true
                        scope.launch {
                            try { scores.signIn(email.trim(), password) }
                            finally { password = ""; working = false }
                        }
                    })
                if (signedIn || working) NoopButton(text = stringResource(R.string.server_scoring_sign_out),
                    kind = NoopButtonKind.Tertiary, fullWidth = true, onClick = { scores.signOut(); password = "" })
                error?.let { Text(it, style = NoopType.footnote, color = Palette.statusCritical) }
            }
        }
    }
}
