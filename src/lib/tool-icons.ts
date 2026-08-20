import {
	Wrench,
	Terminal,
	FileText,
	FilePen,
	FilePlus,
	Search,
	FolderSearch,
	ListChecks,
	Globe,
	Bot
} from '@lucide/svelte';

// One icon per tool, shared by the tool call itself and by the condensed run
// summary that stands in for a stretch of them.
const icons: Record<string, typeof Wrench> = {
	Bash: Terminal,
	Read: FileText,
	Edit: FilePen,
	MultiEdit: FilePen,
	NotebookEdit: FilePen,
	Write: FilePlus,
	Grep: Search,
	Glob: FolderSearch,
	TodoWrite: ListChecks,
	WebFetch: Globe,
	WebSearch: Search,
	Task: Bot
};

export function toolIcon(name: string): typeof Wrench {
	return icons[name] ?? Wrench;
}
