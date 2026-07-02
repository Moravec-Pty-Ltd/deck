// pi-deck-notify.ts - pi's stop-hook equivalent. On agent_end (a finished pi
// turn) it runs the shared deck-notify.sh, so pi pushes the same ntfy deep-link
// to its deck session as the other harnesses.
//
// pi runs extensions in its own process, so process.env already carries the
// DECK_SESSION_ID (and DECK_BASE_URL / NTFY_TOPIC) that deck passed through.
// Point DECK_NOTIFY_SCRIPT at the copy of deck-notify.sh you installed.
//
// Install: drop this in ~/.pi/agent/extensions/ (global) or .pi/extensions/
// (project). See docs/hooks.md.
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", () => {
		// deck did not launch this session, or the script path is unset: skip.
		if (!process.env.DECK_SESSION_ID) return;
		const script = process.env.DECK_NOTIFY_SCRIPT;
		if (!script) return;

		// Fire and forget so a slow or failing push never blocks pi.
		const child = spawn(script, { stdio: "ignore", detached: true });
		child.on("error", () => {});
		child.unref();
	});
}
