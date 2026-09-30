import Charts
import SwiftUI
import ScoutKit

/// One day of asking prices: the median and the middle-50% band.
struct PriceBandPoint: Identifiable {
    var date: Date
    var median: Double
    var lower: Double
    var upper: Double

    var id: Date { date }

    init(date: Date, median: Double, lower: Double, upper: Double) {
        self.date = date
        self.median = median
        self.lower = lower
        self.upper = upper
    }

    /// Days without a median (no listings seen) are skipped by the callers.
    init?(_ point: WatchAnalyticsPoint) {
        guard let date = point.day, let median = point.medianPrice else { return nil }
        self.init(date: date, median: median, lower: point.lowerPrice ?? median, upper: point.upperPrice ?? median)
    }

    init?(_ point: AnalyticsData.TrendPoint) {
        guard let date = point.day, let median = point.medianPrice else { return nil }
        self.init(date: date, median: median, lower: point.lowerPrice ?? median, upper: point.upperPrice ?? median)
    }
}

/// Median asking price with the middle-50% band shaded, and optionally a
/// dashed reference line (a watch's typical price or a probable-sale median).
struct PriceBandChart: View {
    var points: [PriceBandPoint]
    var reference: Double? = nil
    var referenceLabel = "probable sale"

    var body: some View {
        if points.isEmpty {
            ContentUnavailableView("No observations yet", systemImage: "chart.xyaxis.line")
        } else {
            Chart {
                ForEach(points) { day in
                    AreaMark(x: .value("Day", day.date, unit: .day), yStart: .value("Low", day.lower), yEnd: .value("High", day.upper))
                        .foregroundStyle(Color.scoutBlue.opacity(0.15))
                    LineMark(x: .value("Day", day.date, unit: .day), y: .value("Median", day.median))
                        .foregroundStyle(Color.scoutBlue)
                }
                if let reference {
                    RuleMark(y: .value("Reference", reference))
                        .lineStyle(StrokeStyle(lineWidth: 1.5, dash: [5, 4]))
                        .foregroundStyle(Color.dealOrange)
                        .annotation(position: .top, alignment: .leading) {
                            Text(referenceLabel)
                                .font(.caption2)
                                .foregroundStyle(Color.dealOrange)
                        }
                }
            }
            .chartYScale(domain: .automatic(includesZero: false))
            .chartYAxis { plnAxis }
        }
    }
}

/// A single listing's observed asking prices over time.
struct PriceHistoryChart: View {
    var points: [PriceHistoryPoint]
    var typical: Double?

    private struct Point: Identifiable {
        var id: Int
        var date: Date
        var price: Double
    }

    private var series: [Point] {
        points.enumerated().compactMap { index, point in
            point.date.map { Point(id: index, date: $0, price: point.price) }
        }
    }

    var body: some View {
        Chart {
            ForEach(series) { point in
                LineMark(x: .value("Date", point.date), y: .value("Price", point.price))
                    .interpolationMethod(.stepEnd)
                PointMark(x: .value("Date", point.date), y: .value("Price", point.price))
                    .symbolSize(18)
            }
            if let typical {
                RuleMark(y: .value("Typical", typical))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    .foregroundStyle(.secondary)
                    .annotation(position: .top, alignment: .leading) {
                        Text("typical").font(.caption2).foregroundStyle(.secondary)
                    }
            }
        }
        .chartYScale(domain: .automatic(includesZero: false))
        .chartYAxis { plnAxis }
    }
}

@MainActor
private var plnAxis: some AxisContent {
    AxisMarks { value in
        AxisGridLine()
        AxisValueLabel {
            if let price = value.as(Double.self) { Text(Format.pln(price)) }
        }
    }
}

/// Two-column grid of headline numbers, placed as a single List row.
struct StatGrid: View {
    struct Item: Identifiable {
        var title: String
        var value: String
        var detail: String?
        var id: String { title }
    }

    var items: [Item]

    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible(), alignment: .topLeading), GridItem(.flexible(), alignment: .topLeading)], alignment: .leading, spacing: 14) {
            ForEach(items) { item in
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(item.value)
                        .font(.title3.weight(.semibold))
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    if let detail = item.detail {
                        Text(detail)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}
