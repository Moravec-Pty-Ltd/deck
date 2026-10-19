import SwiftUI

/// Renders agent output as block-level Markdown: headings, paragraphs, bullet
/// and numbered lists, fenced code, blockquotes, tables, and rules. Inline
/// spans (bold, italic, `code`, links) come from AttributedString. Dependency
/// free and cross-platform so both the iOS and watch detail views share it.
///
/// SwiftUI's own Text only interprets inline Markdown, so block structure
/// (headings, lists, code fences) would otherwise render as literal markup.
public struct MarkdownText: View {
	private let blocks: [MarkdownBlock]

	public init(_ text: String) {
		self.blocks = MarkdownParser.parse(text)
	}

	public var body: some View {
		selectable(
			VStack(alignment: .leading, spacing: 8) {
				ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
					view(for: block)
						.frame(maxWidth: .infinity, alignment: .leading)
				}
			})
	}

	/// Every block is selectable, not just fenced code: on a Mac, dragging
	/// across a paragraph of a reply is the ordinary thing to want, and a
	/// long-press copies it on a phone. Applied to the whole body so headings,
	/// lists, quotes and tables are covered too.
	@ViewBuilder
	private func selectable(_ content: some View) -> some View {
		#if os(watchOS)
		content
		#else
		content.textSelection(.enabled)
		#endif
	}

	@ViewBuilder
	private func view(for block: MarkdownBlock) -> some View {
		switch block {
		case let .heading(level, text):
			MarkdownInline.text(text)
				.font(headingFont(level))
				.bold()
		case let .paragraph(text):
			MarkdownInline.text(text)
		case let .list(items):
			VStack(alignment: .leading, spacing: 3) {
				ForEach(Array(items.enumerated()), id: \.offset) { _, item in
					HStack(alignment: .firstTextBaseline, spacing: 6) {
						Text(item.ordered ? "\(item.number)." : "•")
							.monospacedDigit()
							.foregroundStyle(.secondary)
						MarkdownInline.text(item.text)
						Spacer(minLength: 0)
					}
					.padding(.leading, CGFloat(item.indent) * 14)
				}
			}
		case let .code(code):
			CodeBlockView(code: code)
		case let .quote(text):
			HStack(spacing: 8) {
				RoundedRectangle(cornerRadius: 1)
					.fill(Color.secondary)
					.frame(width: 3)
				MarkdownInline.text(text)
					.foregroundStyle(.secondary)
			}
			.fixedSize(horizontal: false, vertical: true)
		case let .table(header, rows):
			MarkdownTableView(header: header, rows: rows)
		case .rule:
			Divider()
		}
	}

	private func headingFont(_ level: Int) -> Font {
		switch level {
		case 1: return .title2
		case 2: return .title3
		case 3: return .headline
		default: return .subheadline
		}
	}
}

/// A fenced code block with a copy button pinned to its top-right corner. The
/// code scrolls sideways, so the button sits in an overlay rather than inside
/// the scroll view, where it would slide away from the corner; the code carries
/// trailing padding to match, so a long line scrolled to its end still clears
/// the button.
private struct CodeBlockView: View {
	let code: String

	@State private var copied = false
	@State private var reset: Task<Void, Never>?

	private let buttonWidth: CGFloat = 30

	var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			codeText
				.font(.system(.footnote, design: .monospaced))
				.padding(8)
				.padding(.trailing, TextClipboard.isAvailable ? buttonWidth : 0)
		}
		.background(Color.primary.opacity(0.06))
		.clipShape(RoundedRectangle(cornerRadius: 8))
		.overlay(alignment: .topTrailing) {
			if TextClipboard.isAvailable { copyButton }
		}
	}

	// textSelection is unavailable on watchOS, so it is applied only where supported.
	@ViewBuilder
	private var codeText: some View {
		#if os(watchOS)
		Text(code)
		#else
		Text(code).textSelection(.enabled)
		#endif
	}

	private var copyButton: some View {
		Button {
			TextClipboard.copy(code)
			copied = true
			reset?.cancel()
			reset = Task {
				try? await Task.sleep(for: .seconds(1))
				guard !Task.isCancelled else { return }
				copied = false
			}
		} label: {
			Image(systemName: copied ? "checkmark" : "doc.on.doc")
				.font(.caption)
				.frame(width: buttonWidth, height: 34)
				.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.foregroundStyle(.secondary)
		.accessibilityLabel("Copy code")
		.onDisappear { reset?.cancel() }
	}
}

private struct MarkdownTableView: View {
	let header: [String]
	let rows: [[String]]

	var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
				GridRow {
					ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
						MarkdownInline.text(cell).bold()
					}
				}
				Divider().gridCellColumns(max(header.count, 1))
				ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
					GridRow {
						ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
							MarkdownInline.text(cell)
						}
					}
				}
			}
			.font(.footnote)
			.padding(6)
		}
		.background(Color.primary.opacity(0.04))
		.clipShape(RoundedRectangle(cornerRadius: 8))
	}
}

enum MarkdownInline {
	static func text(_ string: String) -> Text {
		if let attributed = try? AttributedString(
			markdown: string,
			options: .init(
				interpretedSyntax: .inlineOnlyPreservingWhitespace,
				failurePolicy: .returnPartiallyParsedIfPossible)) {
			return Text(attributed)
		}
		return Text(string)
	}
}
