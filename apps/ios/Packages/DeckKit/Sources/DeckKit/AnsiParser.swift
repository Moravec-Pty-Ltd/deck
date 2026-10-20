import Foundation

/// A colour from an SGR code: one of the 16 named colours, the 256-colour
/// cube or grey ramp, or truecolor.
public struct AnsiColor: Hashable, Sendable {
	public let red: UInt8
	public let green: UInt8
	public let blue: UInt8

	public init(red: Int, green: Int, blue: Int) {
		self.red = UInt8(clamping: red)
		self.green = UInt8(clamping: green)
		self.blue = UInt8(clamping: blue)
	}

	init(hex: UInt32) {
		self.init(red: Int(hex >> 16 & 0xff), green: Int(hex >> 8 & 0xff), blue: Int(hex & 0xff))
	}
}

public struct AnsiStyle: Hashable, Sendable {
	public var foreground: AnsiColor?
	public var background: AnsiColor?
	public var bold = false
	public var dim = false
	public var italic = false
	public var underline = false
	public var inverse = false

	public init() {}
}

/// A stretch of text in one style.
public struct AnsiRun: Hashable, Sendable {
	public let text: String
	public let style: AnsiStyle
}

/// A port of the web's src/lib/ansi.ts: the SGR subset of `tmux capture-pane -e`
/// output becomes styled runs, and every other escape (cursor moves, private
/// modes, OSC titles and links, charset designators) is dropped. The palette
/// matches the web's, mid-toned so it reads on light and dark backgrounds.
public enum AnsiParser {
	static let basic: [AnsiColor] = [0x000000, 0xcc0000, 0x4e9a06, 0xc4a000, 0x3465a4, 0x75507b, 0x06989a, 0xd3d7cf].map(AnsiColor.init(hex:))
	static let bright: [AnsiColor] = [0x555753, 0xef2929, 0x8ae234, 0xfce94f, 0x729fcf, 0xad7fa8, 0x34e2e2, 0xeeeeec].map(AnsiColor.init(hex:))

	public static func parse(_ input: String) -> [AnsiRun] {
		var scanner = Scanner(Array(input.unicodeScalars))
		return scanner.run()
	}

	static func color256(_ n: Int) -> AnsiColor {
		if n < 16 { return n < 8 ? basic[max(n, 0)] : bright[n - 8] }
		if n >= 232 {
			let v = 8 + (n - 232) * 10
			return AnsiColor(red: v, green: v, blue: v)
		}
		let i = n - 16
		func level(_ x: Int) -> Int { x == 0 ? 0 : 55 + x * 40 }
		return AnsiColor(red: level(i / 36), green: level(i % 36 / 6), blue: level(i % 6))
	}

	static func apply(_ codes: [Int], to style: inout AnsiStyle) {
		var i = 0
		while i < codes.count {
			let code = codes[i]
			if code == 38 || code == 48 {
				i += applyExtended(codes, at: i, to: &style)
			} else {
				applySimple(code, to: &style)
			}
			i += 1
		}
	}

	private static func applySimple(_ code: Int, to style: inout AnsiStyle) {
		switch code {
		case 0: style = AnsiStyle()
		case 1: style.bold = true
		case 2: style.dim = true
		case 3: style.italic = true
		case 4: style.underline = true
		case 7: style.inverse = true
		case 22: style.bold = false; style.dim = false
		case 23: style.italic = false
		case 24: style.underline = false
		case 27: style.inverse = false
		case 30...37: style.foreground = basic[code - 30]
		case 39: style.foreground = nil
		case 40...47: style.background = basic[code - 40]
		case 49: style.background = nil
		case 90...97: style.foreground = bright[code - 90]
		case 100...107: style.background = bright[code - 100]
		default: break
		}
	}

	/// 38/48 followed by `5;n` or `2;r;g;b`. Returns how many codes it consumed
	/// past the 38/48 itself.
	private static func applyExtended(_ codes: [Int], at i: Int, to style: inout AnsiStyle) -> Int {
		func code(_ j: Int) -> Int { j < codes.count ? codes[j] : 0 }
		let color: AnsiColor
		let used: Int
		switch i + 1 < codes.count ? codes[i + 1] : nil {
		case 5:
			color = color256(code(i + 2))
			used = 2
		case 2:
			color = AnsiColor(red: code(i + 2), green: code(i + 3), blue: code(i + 4))
			used = 4
		default:
			return 0
		}
		if codes[i] == 38 { style.foreground = color } else { style.background = color }
		return used
	}

	private struct Scanner {
		let scalars: [Unicode.Scalar]
		var index = 0
		var style = AnsiStyle()
		var text = String.UnicodeScalarView()
		var runs: [AnsiRun] = []

		init(_ scalars: [Unicode.Scalar]) { self.scalars = scalars }

		mutating func run() -> [AnsiRun] {
			while index < scalars.count {
				if scalars[index] == "\u{1b}", Self.introducers.contains(at(index + 1) ?? 0) {
					flush()
					index = escapeEnd(from: index)
				} else {
					text.append(scalars[index])
					index += 1
				}
			}
			flush()
			return runs
		}

		private mutating func flush() {
			guard !text.isEmpty else { return }
			runs.append(AnsiRun(text: String(text), style: style))
			text = String.UnicodeScalarView()
		}

		private func at(_ i: Int) -> UInt32? { i < scalars.count ? scalars[i].value : nil }

		private func skip(from i: Int, while test: (UInt32) -> Bool) -> Int {
			var j = i
			while let v = at(j), test(v) { j += 1 }
			return j
		}

		private static func isParam(_ v: UInt32) -> Bool { (0x30...0x39).contains(v) || v == 0x3b || v == 0x3f }

		/// What can follow ESC to start an escape: [ ] ( ). Any other ESC is
		/// left in the text, as the web leaves it.
		private static let introducers: Set<UInt32> = [0x5b, 0x5d, 0x28, 0x29]

		/// Where the escape starting at `start` ends, applying it to the style
		/// when it is an SGR.
		private mutating func escapeEnd(from start: Int) -> Int {
			switch at(start + 1) {
			case 0x5b: return csiEnd(from: start + 2)
			case 0x5d: return oscEnd(from: start + 2) ?? designatorEnd(from: start + 2)
			default: return designatorEnd(from: start + 2)
			}
		}

		private mutating func csiEnd(from start: Int) -> Int {
			let paramsEnd = skip(from: start, while: Self.isParam)
			let intermediatesEnd = skip(from: paramsEnd, while: { (0x20...0x2f).contains($0) })
			guard let final = at(intermediatesEnd), (0x40...0x7e).contains(final) else { return intermediatesEnd }
			let params = String(String.UnicodeScalarView(scalars[start..<paramsEnd]))
			if final == 0x6d, paramsEnd == intermediatesEnd, !params.contains("?") {
				let codes = params.isEmpty ? [0] : params.split(separator: ";", omittingEmptySubsequences: false).map { Int($0) ?? 0 }
				AnsiParser.apply(codes, to: &style)
			}
			return intermediatesEnd + 1
		}

		/// An OSC string, ended by BEL or ESC \. Nil when it never ends properly,
		/// which the web then strips as a short designator instead.
		private func oscEnd(from start: Int) -> Int? {
			var j = start
			while let v = at(j) {
				if v == 0x07 { return j + 1 }
				if v == 0x1b { return at(j + 1) == 0x5c ? j + 2 : nil }
				j += 1
			}
			return nil
		}

		private func designatorEnd(from start: Int) -> Int {
			let end = skip(from: start, while: Self.isParam)
			guard let v = at(end), (0x41...0x5a).contains(v) || (0x61...0x7a).contains(v) else { return end }
			return end + 1
		}
	}
}
