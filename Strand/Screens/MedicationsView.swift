import SwiftUI
import Charts
import StrandDesign

/// Placeholder Medications screen — dose logging + a "vital response" preview, occupying the
/// fourth tab slot on iPhone (the spot Coach held before it moved back to the More list).
///
/// Everything on this screen is MOCK: the medications, dose states and the before/after vitals
/// are in-memory sample data that resets on relaunch. Nothing is persisted, synced or scored,
/// and the vital-response card is labelled as such. The screen exists to pin down the layout
/// and interaction model before a real store lands behind it.
struct MedicationsView: View {
    /// One scheduled dose row in today's plan. `due` marks the dose currently actionable
    /// (shows the "Log dose" affordance); `taken` marks it logged.
    private struct MockDose: Identifiable {
        let id = UUID()
        var time: String
        var name: String
        var detail: String
        var taken: Bool
        var due: Bool
    }

    /// The vital the response chart plots. Deltas below the chart summarise all three at once.
    private enum VitalMetric: String, CaseIterable {
        case restingHR = "Resting HR"
        case hrv = "HRV"
        case sleep = "Sleep"
    }

    private struct VitalPoint: Identifiable {
        let id = UUID()
        let date: Date
        let value: Double
    }

    @State private var doses: [MockDose] = [
        MockDose(time: "8:00 AM",  name: "Metoprolol", detail: "25 mg · with breakfast", taken: true,  due: false),
        MockDose(time: "9:30 AM",  name: "Vitamin D3", detail: "2,000 IU",               taken: true,  due: false),
        MockDose(time: "2:00 PM",  name: "Magnesium",  detail: "400 mg · glycinate",     taken: false, due: true),
        MockDose(time: "9:30 PM",  name: "Melatonin",  detail: "3 mg · before bed",      taken: false, due: false),
    ]
    @State private var medications = ["Metoprolol", "Melatonin", "Magnesium"]
    @State private var selectedMedication = "Metoprolol"
    @State private var selectedMetric: VitalMetric = .restingHR
    @State private var showAddSheet = false

    var body: some View {
        ScreenScaffold(
            title: "Medications",
            subtitle: "Log doses and see how your vitals respond.",
            topBackground: liquidScaffoldSky()
        ) {
            VStack(alignment: .leading, spacing: NoopMetrics.sectionSpacing) {
                scheduleCard
                vitalResponseCard
            }
        }
        .sheet(isPresented: $showAddSheet) {
            addMedicationSheet
                #if os(iOS)
                .noopSheetPresentation(largeFirst: false)
                #endif
                #if os(macOS)
                .frame(minWidth: NoopMetrics.editorSheetMinWidth, minHeight: NoopMetrics.editorSheetMinHeight)
                #endif
        }
    }

    // MARK: - Schedule card

    private var scheduleCard: some View {
        StrandCard(padding: NoopMetrics.space5) {
            VStack(alignment: .leading, spacing: NoopMetrics.space4) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(todayOverline).strandOverline()
                    HStack(spacing: NoopMetrics.space2 + 2) {
                        Image(systemName: "pills")
                            .foregroundStyle(StrandPalette.accent)
                            .accessibilityHidden(true)
                        Text("Schedule")
                            .font(StrandFont.title2)
                            .foregroundStyle(StrandPalette.textPrimary)
                    }
                }
                Text("Tap a dose when you take it. Times come from each medication's plan.")
                    .font(StrandFont.subhead)
                    .foregroundStyle(StrandPalette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                doseProgress

                VStack(spacing: 0) {
                    ForEach($doses) { $dose in
                        doseRow(dose: dose) {
                            withAnimation(.timingCurve(0.22, 1, 0.36, 1, duration: 0.24)) {
                                dose.taken = true
                                dose.due = false
                            }
                        }
                        if dose.id != doses.last?.id {
                            Rectangle().fill(StrandPalette.hairline).frame(height: 1)
                        }
                    }
                }

                NoopButton("Add medication", systemImage: "plus", kind: .secondary, fullWidth: true) {
                    showAddSheet = true
                }
            }
        }
    }

    private var takenCount: Int { doses.filter(\.taken).count }

    private var doseProgress: some View {
        VStack(alignment: .leading, spacing: NoopMetrics.space2) {
            HStack {
                Text("Doses logged")
                    .font(StrandFont.subhead)
                    .foregroundStyle(StrandPalette.textSecondary)
                Spacer(minLength: 0)
                Text("\(takenCount) of \(doses.count)")
                    .font(StrandFont.captionNumber)
                    .foregroundStyle(StrandPalette.textPrimary)
            }
            PipBar(value: Double(takenCount), range: 0...Double(max(doses.count, 1)),
                   segments: max(doses.count, 1), tint: StrandPalette.accent)
                .accessibilityHidden(true)
        }
    }

    private func doseRow(dose: MockDose, onLog: @escaping () -> Void) -> some View {
        HStack(spacing: NoopMetrics.space3) {
            Text(dose.time)
                .font(StrandFont.captionNumber)
                .foregroundStyle(StrandPalette.textSecondary)
                .frame(width: 62, alignment: .leading)
            VStack(alignment: .leading, spacing: 1) {
                Text(dose.name)
                    .font(StrandFont.headline)
                    .foregroundStyle(dose.taken ? StrandPalette.textSecondary : StrandPalette.textPrimary)
                Text(dose.detail)
                    .font(StrandFont.caption)
                    .foregroundStyle(StrandPalette.textTertiary)
            }
            Spacer(minLength: 0)
            if dose.taken {
                Label("Taken", systemImage: "checkmark.circle.fill")
                    .font(StrandFont.caption)
                    .foregroundStyle(StrandPalette.accent)
            } else if dose.due {
                Button(action: onLog) {
                    Text("Log dose")
                        .font(StrandFont.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(StrandPalette.accent)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(StrandPalette.accent.opacity(0.12), in: Capsule())
                        .overlay(Capsule().strokeBorder(StrandPalette.accent.opacity(0.4), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Log \(dose.name) as taken"))
            } else {
                Label(dose.time, systemImage: "circle")
                    .font(StrandFont.caption)
                    .foregroundStyle(StrandPalette.textTertiary)
            }
        }
        .padding(.vertical, NoopMetrics.space3 - 1)
    }

    private var todayOverline: String {
        let formatted = DateFormatter.localizedString(from: Date(), dateStyle: .medium, timeStyle: .none)
        return String(localized: "Today") + " · " + formatted
    }

    // MARK: - Vital response card

    private var vitalResponseCard: some View {
        StrandCard(padding: NoopMetrics.space5) {
            VStack(alignment: .leading, spacing: NoopMetrics.space4) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Placeholder").strandOverline()
                    HStack(spacing: NoopMetrics.space2 + 2) {
                        Image(systemName: "waveform.path.ecg")
                            .foregroundStyle(StrandPalette.liquidHeart)
                            .accessibilityHidden(true)
                        Text("Vital response")
                            .font(StrandFont.title2)
                            .foregroundStyle(StrandPalette.textPrimary)
                        mockBadge
                    }
                }
                Text("Resting heart rate, HRV and sleep in the 7 days before vs after a start date.")
                    .font(StrandFont.subhead)
                    .foregroundStyle(StrandPalette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                medicationChips

                SegmentedPillControl(VitalMetric.allCases, selection: $selectedMetric,
                                     fillsAvailableWidth: true) { $0.rawValue }

                vitalChart

                deltaTiles

                Text("7-day averages before vs after the start date. Correlation, not causation — placeholder data, not medical advice.")
                    .font(StrandFont.footnote)
                    .foregroundStyle(StrandPalette.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var mockBadge: some View {
        Text("Mock data")
            .font(StrandFont.overlineScaled(10))
            .tracking(0.5)
            .textCase(.uppercase)
            .foregroundStyle(StrandPalette.statusWarning)
            .padding(.horizontal, 7)
            .frame(height: NoopMetrics.sourceBadgeHeight)
            .background(StrandPalette.statusWarning.opacity(0.16), in: Capsule())
            .overlay(Capsule().strokeBorder(StrandPalette.statusWarning.opacity(0.34), lineWidth: 1))
            .accessibilityHidden(true)
    }

    private var medicationChips: some View {
        HStack(spacing: NoopMetrics.space2) {
            ForEach(medications, id: \.self) { med in
                let selected = med == selectedMedication
                Button {
                    withAnimation(.timingCurve(0.22, 1, 0.36, 1, duration: 0.24)) {
                        selectedMedication = med
                    }
                } label: {
                    Text(med)
                        .font(StrandFont.captionNumber)
                        .foregroundStyle(selected ? StrandPalette.accent : StrandPalette.textSecondary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(selected ? StrandPalette.accent.opacity(0.12) : StrandPalette.surfaceInset,
                                    in: Capsule())
                        .overlay(Capsule().strokeBorder(selected ? StrandPalette.accent.opacity(0.4)
                                                                 : StrandPalette.hairline, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: Vital chart (mock before/after series)

    /// Fourteen daily readings ending today; the medication "start" sits between day 7 and 8.
    private var vitalPoints: [VitalPoint] {
        let values: [Double]
        switch (selectedMetric, selectedMedication) {
        case (.restingHR, _):            values = [63, 62, 64, 63, 62, 63, 62, 60, 59, 60, 58, 59, 58, 58]
        case (.hrv, "Melatonin"):        values = [44, 45, 43, 46, 44, 45, 44, 49, 51, 50, 52, 53, 52, 54]
        case (.hrv, _):                  values = [48, 47, 49, 48, 50, 49, 48, 51, 52, 51, 53, 54, 53, 54]
        case (.sleep, "Melatonin"):      values = [70, 73, 68, 72, 71, 69, 72, 80, 83, 81, 85, 86, 84, 88]
        case (.sleep, _):                values = [72, 75, 70, 74, 73, 71, 74, 78, 80, 79, 82, 84, 83, 86]
        }
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        return values.enumerated().map { index, value in
            VitalPoint(date: cal.date(byAdding: .day, value: index - (values.count - 1), to: today)!,
                       value: value)
        }
    }

    /// Midpoint between the last "before" day and the first "after" day, for the dashed start rule.
    private var startMarkerDate: Date {
        let points = vitalPoints
        guard points.count > 7 else { return Date() }
        return points[6].date.addingTimeInterval(12 * 3600)
    }

    private var beforeAverage: Double {
        let before = vitalPoints.prefix(7).map(\.value)
        return before.reduce(0, +) / Double(max(before.count, 1))
    }

    private var afterAverage: Double {
        let after = vitalPoints.suffix(7).map(\.value)
        return after.reduce(0, +) / Double(max(after.count, 1))
    }

    private var metricColor: Color {
        switch selectedMetric {
        case .restingHR: StrandPalette.liquidHeart
        case .hrv: StrandPalette.metricPurple
        case .sleep: StrandPalette.sleepDeep
        }
    }

    private var vitalChart: some View {
        let points = vitalPoints
        let values = points.map(\.value)
        let yDomain = (values.min()! - 4)...(values.max()! + 4)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(selectedMetric.rawValue)
                    .font(StrandFont.subhead)
                    .fontWeight(.semibold)
                    .foregroundStyle(metricColor)
                Spacer(minLength: 0)
                Text("Last 14 days")
                    .font(StrandFont.footnote)
                    .foregroundStyle(StrandPalette.textTertiary)
            }
            Chart {
                // Dotted before/after average segments.
                RuleMark(y: .value("Before avg", beforeAverage))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 4]))
                    .foregroundStyle(StrandPalette.textTertiary.opacity(0.8))
                RuleMark(y: .value("After avg", afterAverage))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 4]))
                    .foregroundStyle(StrandPalette.textTertiary.opacity(0.8))
                // Dashed vertical rule at the medication start date.
                RuleMark(x: .value("Started", startMarkerDate))
                    .lineStyle(StrokeStyle(lineWidth: 1.2, dash: [5, 4]))
                    .foregroundStyle(StrandPalette.accent)
                    .annotation(position: .top, alignment: .center) {
                        Text("Started")
                            .font(StrandFont.overlineScaled(9))
                            .tracking(0.5)
                            .textCase(.uppercase)
                            .foregroundStyle(StrandPalette.accent)
                    }
                ForEach(points) { point in
                    AreaMark(x: .value("Day", point.date), y: .value("Value", point.value))
                        .interpolationMethod(.catmullRom)
                        .foregroundStyle(LinearGradient(
                            colors: [metricColor.opacity(0.18), Color.clear],
                            startPoint: .top, endPoint: .bottom))
                    LineMark(x: .value("Day", point.date), y: .value("Value", point.value))
                        .interpolationMethod(.catmullRom)
                        .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                        .foregroundStyle(metricColor)
                }
            }
            .chartYScale(domain: yDomain)
            .chartPlotStyle { plotArea in plotArea.clipped() }
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                    AxisGridLine().foregroundStyle(StrandPalette.hairline.opacity(0.4))
                    AxisValueLabel(format: .dateTime.month(.abbreviated).day())
                        .foregroundStyle(StrandPalette.textTertiary)
                        .font(StrandFont.footnote)
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { _ in
                    AxisGridLine().foregroundStyle(StrandPalette.hairline.opacity(0.4))
                    AxisValueLabel()
                        .foregroundStyle(StrandPalette.textTertiary)
                        .font(StrandFont.footnote)
                }
            }
            .frame(height: 160)
            .accessibilityLabel(Text("Fourteen-day \(selectedMetric.rawValue) trend with a marker at the medication start date"))
        }
    }

    private var deltaTiles: some View {
        HStack(spacing: NoopMetrics.space2) {
            deltaTile(label: "Resting HR", value: "−4", unit: "bpm", color: StrandPalette.liquidHeart)
            deltaTile(label: "HRV", value: "+6", unit: "ms", color: StrandPalette.metricPurple)
            deltaTile(label: "Deep sleep", value: "+12", unit: "min", color: StrandPalette.sleepDeep)
        }
    }

    private func deltaTile(label: LocalizedStringKey, value: String, unit: String, color: Color) -> some View {
        VStack(spacing: 3) {
            Text(label).strandOverline()
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(value)
                    .font(StrandFont.number(16))
                    .foregroundStyle(color)
                Text(unit)
                    .font(StrandFont.caption)
                    .foregroundStyle(StrandPalette.textTertiary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, NoopMetrics.space2 + 1)
        .background(StrandPalette.surfaceInset, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    // MARK: - Add medication sheet (placeholder form)

    @State private var draftName = ""
    @State private var draftDose = ""
    @State private var draftTimes = ["8:00 AM"]
    @State private var draftStartDate = Date()
    @State private var draftReminders = true
    @State private var draftTrackVitals = true

    private var addMedicationSheet: some View {
        VStack(alignment: .leading, spacing: NoopMetrics.space4) {
            HStack {
                Text("Add medication")
                    .font(StrandFont.title2)
                    .foregroundStyle(StrandPalette.textPrimary)
                Spacer(minLength: 0)
                Button {
                    showAddSheet = false
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(StrandPalette.textSecondary)
                        .frame(width: 30, height: 30)
                        .background(StrandPalette.surfaceInset, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Close"))
            }

            formField(label: String(localized: "Name"), text: $draftName, prompt: "Metoprolol")
            formField(label: String(localized: "Dose"), text: $draftDose, prompt: "25 mg")

            VStack(alignment: .leading, spacing: 6) {
                Text("Schedule").strandOverline()
                ForEach(Array(draftTimes.enumerated()), id: \.offset) { index, time in
                    HStack(spacing: NoopMetrics.space2 + 2) {
                        Image(systemName: "clock")
                            .foregroundStyle(StrandPalette.accent)
                            .accessibilityHidden(true)
                        Text(time)
                            .font(StrandFont.mono(13))
                            .foregroundStyle(StrandPalette.textPrimary)
                        Spacer(minLength: 0)
                        if draftTimes.count > 1 {
                            Button {
                                draftTimes.remove(at: index)
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(StrandPalette.textTertiary)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(Text("Remove \(time)"))
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(StrandPalette.surfaceInset, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(StrandPalette.hairline, lineWidth: 1)
                    )
                }
                Button {
                    draftTimes.append(draftTimes.count % 2 == 0 ? "8:00 AM" : "9:30 PM")
                } label: {
                    Label("Add a time", systemImage: "plus")
                        .font(StrandFont.subhead)
                        .fontWeight(.semibold)
                        .foregroundStyle(StrandPalette.accent)
                }
                .buttonStyle(.plain)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Start date").strandOverline()
                DatePicker("Start date", selection: $draftStartDate, displayedComponents: .date)
                    .labelsHidden()
                    .datePickerStyle(.compact)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(StrandPalette.surfaceInset, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(StrandPalette.hairline, lineWidth: 1)
                    )
            }

            formToggle(title: String(localized: "Dose reminders"),
                       detail: String(localized: "Notify when a dose is due."),
                       isOn: $draftReminders)
            formToggle(title: String(localized: "Track vital response"),
                       detail: String(localized: "Compare HR, HRV and sleep before vs after the start date."),
                       isOn: $draftTrackVitals)

            NoopButton("Save medication", kind: .primary, fullWidth: true) {
                saveDraft()
            }
            .disabled(draftName.trimmingCharacters(in: .whitespaces).isEmpty)
            NoopButton("Cancel", kind: .tertiary, fullWidth: true) {
                showAddSheet = false
            }
        }
        .padding(NoopMetrics.space5)
        .background(StrandPalette.surfaceBase.ignoresSafeArea())
    }

    private func formField(label: String, text: Binding<String>, prompt: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).strandOverline()
            TextField(prompt, text: text)
                .textFieldStyle(.plain)
                .font(StrandFont.mono(13))
                .foregroundStyle(StrandPalette.textPrimary)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(StrandPalette.surfaceInset, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(StrandPalette.hairline, lineWidth: 1)
                )
        }
    }

    private func formToggle(title: String, detail: String, isOn: Binding<Bool>) -> some View {
        HStack(alignment: .center, spacing: NoopMetrics.space4) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(StrandFont.body)
                    .foregroundStyle(StrandPalette.textPrimary)
                Text(detail)
                    .font(StrandFont.footnote)
                    .foregroundStyle(StrandPalette.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Toggle(title, isOn: isOn)
                .labelsHidden()
                .toggleStyle(.switch)
                .tint(StrandPalette.accent)
        }
    }

    /// Placeholder save: keeps the new medication in memory for the session so the schedule and
    /// the chip row react, then resets the draft. No persistence layer exists yet.
    private func saveDraft() {
        let name = draftName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        let detail = draftDose.trimmingCharacters(in: .whitespaces)
        for time in draftTimes {
            doses.append(MockDose(time: time, name: name,
                                  detail: detail.isEmpty ? "—" : detail,
                                  taken: false, due: false))
        }
        doses.sort { $0.time < $1.time }
        if !medications.contains(name) { medications.append(name) }
        draftName = ""; draftDose = ""; draftTimes = ["8:00 AM"]
        draftStartDate = Date(); draftReminders = true; draftTrackVitals = true
        showAddSheet = false
    }
}
