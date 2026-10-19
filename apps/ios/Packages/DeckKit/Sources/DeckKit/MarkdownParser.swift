import Foundation

struct MarkdownListItem: Equatable {
	let indent: Int
	let ordered: Bool
	let number: Int
	let text: String
}

enum MarkdownBlock: Equatable {
	case heading(level: Int, text: String)
	case paragraph(String)
	case list(items: [MarkdownListItem])
	case code(String)
	case quote(String)
	case table(header: [String], rows: [[String]])
	case rule
}

/// Small block-level Markdown parser. Deliberately forgiving: unknown or
/// malformed markup falls through to paragraphs rather than failing.
enum MarkdownParser {
	static func parse(_ text: String) -> [MarkdownBlock] {
		let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
		var blocks: [MarkdownBlock] = []
		var paragraph: [String] = []
		var index = 0

		func flushParagraph() {
			guard !paragraph.isEmpty else { return }
			let joined = paragraph.joined(separator: " ").trimmingCharacters(in: .whitespaces)
			if !joined.isEmpty { blocks.append(.paragraph(joined)) }
			paragraph = []
		}

		while index < lines.count {
			let line = lines[index]
			let trimmed = line.trimmingCharacters(in: .whitespaces)

			// Fenced code block.
			if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
				flushParagraph()
				let fence = String(trimmed.prefix(3))
				var code: [String] = []
				index += 1
				while index < lines.count,
					!lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
					code.append(lines[index])
					index += 1
				}
				index += 1 // closing fence
				blocks.append(.code(code.joined(separator: "\n")))
				continue
			}

			if trimmed.isEmpty {
				flushParagraph()
				index += 1
				continue
			}

			if let level = headingLevel(trimmed) {
				flushParagraph()
				let content = String(trimmed.drop(while: { $0 == "#" }))
					.trimmingCharacters(in: .whitespaces)
				blocks.append(.heading(level: level, text: content))
				index += 1
				continue
			}

			if isRule(trimmed) {
				flushParagraph()
				blocks.append(.rule)
				index += 1
				continue
			}

			// GitHub-flavored table: header row, a dash separator, then body.
			if trimmed.contains("|"), index + 1 < lines.count,
				isTableSeparator(lines[index + 1]) {
				flushParagraph()
				let header = splitTableRow(trimmed)
				var rows: [[String]] = []
				index += 2
				while index < lines.count {
					let bodyLine = lines[index].trimmingCharacters(in: .whitespaces)
					guard bodyLine.contains("|"), !bodyLine.isEmpty else { break }
					rows.append(splitTableRow(bodyLine))
					index += 1
				}
				blocks.append(.table(header: header, rows: rows))
				continue
			}

			if trimmed.hasPrefix(">") {
				flushParagraph()
				var quoted: [String] = []
				while index < lines.count {
					var quoteLine = lines[index].trimmingCharacters(in: .whitespaces)
					guard quoteLine.hasPrefix(">") else { break }
					quoteLine.removeFirst()
					if quoteLine.hasPrefix(" ") { quoteLine.removeFirst() }
					quoted.append(quoteLine)
					index += 1
				}
				blocks.append(.quote(quoted.joined(separator: " ").trimmingCharacters(in: .whitespaces)))
				continue
			}

			if let item = listItem(line) {
				flushParagraph()
				var items: [MarkdownListItem] = [item]
				index += 1
				while index < lines.count, let next = listItem(lines[index]) {
					items.append(next)
					index += 1
				}
				blocks.append(.list(items: items))
				continue
			}

			paragraph.append(trimmed)
			index += 1
		}

		flushParagraph()
		return blocks
	}

	static func headingLevel(_ line: String) -> Int? {
		guard line.hasPrefix("#") else { return nil }
		let hashes = line.prefix { $0 == "#" }.count
		guard hashes <= 6, line.dropFirst(hashes).first == " " else { return nil }
		return hashes
	}

	static func isRule(_ line: String) -> Bool {
		let stripped = line.replacingOccurrences(of: " ", with: "")
		guard stripped.count >= 3 else { return false }
		let chars = Set(stripped)
		return chars.count == 1 && "-*_".contains(chars.first!)
	}

	static func listItem(_ line: String) -> MarkdownListItem? {
		let leading = line.prefix { $0 == " " || $0 == "\t" }
		let indent = leading.reduce(0) { $0 + ($1 == "\t" ? 2 : 1) } / 2
		let rest = line[leading.endIndex...]

		for marker in ["- ", "* ", "+ "] where rest.hasPrefix(marker) {
			let text = String(rest.dropFirst(marker.count)).trimmingCharacters(in: .whitespaces)
			return MarkdownListItem(indent: indent, ordered: false, number: 0, text: text)
		}

		var digits = ""
		var cursor = rest.startIndex
		while cursor < rest.endIndex, rest[cursor].isNumber {
			digits.append(rest[cursor])
			cursor = rest.index(after: cursor)
		}
		guard !digits.isEmpty, cursor < rest.endIndex,
			rest[cursor] == "." || rest[cursor] == ")" else { return nil }
		let afterDelimiter = rest.index(after: cursor)
		guard afterDelimiter < rest.endIndex, rest[afterDelimiter] == " " else { return nil }
		let text = String(rest[rest.index(after: afterDelimiter)...]).trimmingCharacters(in: .whitespaces)
		return MarkdownListItem(indent: indent, ordered: true, number: Int(digits) ?? 1, text: text)
	}

	static func isTableSeparator(_ line: String) -> Bool {
		let trimmed = line.trimmingCharacters(in: .whitespaces)
		guard trimmed.contains("|"), trimmed.contains("-") else { return false }
		let cells = splitTableRow(trimmed)
		guard !cells.isEmpty else { return false }
		return cells.allSatisfy { cell in
			let body = cell.replacingOccurrences(of: " ", with: "")
			guard !body.isEmpty else { return false }
			return body.allSatisfy { $0 == "-" || $0 == ":" }
		}
	}

	static func splitTableRow(_ line: String) -> [String] {
		var row = line.trimmingCharacters(in: .whitespaces)
		if row.hasPrefix("|") { row.removeFirst() }
		if row.hasSuffix("|") { row.removeLast() }
		return row.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
	}
}
