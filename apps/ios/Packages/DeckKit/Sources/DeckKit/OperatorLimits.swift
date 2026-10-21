import Foundation

// Outside OperatorTools.swift on purpose: that file is gated on
// FoundationModels, which watchOS does not have, and the watch app links
// DeckKit. A plain value type has no business disappearing with the
// framework it happens to be used alongside.

/// How much a tool may hand back, which is a property of the model's context
/// window and so no longer a constant (deck#239).
///
/// Apple's on-device model has 4,096 tokens for the instructions, eight tool
/// schemas, the conversation and the result together, so a result has to be cut
/// hard. A downloaded model has tens of thousands, and cutting a session's
/// reply to 2,000 characters there would throw away the thing being asked about
/// for no reason.
public struct OperatorLimits: Sendable, Equatable {
	/// Characters a single tool result may carry. Roughly four to a token.
	public let resultCharacters: Int
	/// How many sessions a list may name.
	public let sessionRows: Int

	public init(resultCharacters: Int, sessionRows: Int) {
		self.resultCharacters = resultCharacters
		self.sessionRows = sessionRows
	}

	/// Apple's on-device model: about 500 tokens of the 4,096 for a result, and
	/// 25 sessions is already 1,400 of them.
	public static let appleOnDevice = OperatorLimits(resultCharacters: 2_000, sessionRows: 25)

	/// A downloaded model. 12,000 characters is roughly 3,000 tokens, which a
	/// 32k window carries along with everything else and which fits a session's
	/// whole reply rather than its opening.
	public static let downloaded = OperatorLimits(resultCharacters: 12_000, sessionRows: 80)
}
