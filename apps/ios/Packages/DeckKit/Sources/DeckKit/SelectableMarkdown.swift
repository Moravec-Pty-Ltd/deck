import Foundation

/// A message as one attributed string, for a text view that can select any
/// range of it. Block structure becomes line breaks and list markers; inline
/// markup becomes `inlinePresentationIntent` and `link` runs, so what you copy
/// is the text as read, not the Markdown source.
public enum SelectableMarkdown {
	public static func attributed(_ markdown: String) -> AttributedString {
		var out = AttributedString()
		for block in MarkdownParser.parse(markdown) {
			var piece: AttributedString
			switch block {
			case let .heading(_, text):
				piece = inline(text)
				for run in piece.runs {
					piece[run.range].inlinePresentationIntent = (run.inlinePresentationIntent ?? []).union(.stronglyEmphasized)
				}
			case let .paragraph(text), let .quote(text):
				piece = inline(text)
			case let .list(items):
				piece = lines(items.map { item in
					AttributedString(String(repeating: "  ", count: item.indent) + (item.ordered ? "\(item.number). " : "• "))
						+ inline(item.text)
				})
			case let .code(text):
				piece = code(text)
			case let .table(header, rows):
				piece = lines(([header] + rows).map { row in
					row.map(inline).reduce(into: AttributedString()) { line, cell in
						if !line.characters.isEmpty { line += AttributedString("\t") }
						line += cell
					}
				})
			case .rule:
				continue
			}
			if !out.characters.isEmpty { out += AttributedString("\n\n") }
			out += piece
		}
		return out
	}

	/// Plain text in a monospaced run, for tool output and fenced code.
	public static func code(_ text: String) -> AttributedString {
		var piece = AttributedString(text)
		piece.inlinePresentationIntent = .code
		return piece
	}

	private static func inline(_ text: String) -> AttributedString {
		MarkdownInline.attributed(text)
	}

	private static func lines(_ parts: [AttributedString]) -> AttributedString {
		parts.enumerated().reduce(into: AttributedString()) { out, part in
			if part.offset > 0 { out += AttributedString("\n") }
			out += part.element
		}
	}
}
