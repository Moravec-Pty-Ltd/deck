// Saved issue-source credentials (issue #237), kept node-free so the grouping
// and the sharing rule unit-test without the keyring or the project store.
//
// A credential is not a stored record of its own: it is whatever the sources
// pointing at one key have to say about it. Deriving the list means there is no
// second file to keep in step with projects.json, and a credential cannot
// outlive the last source using it.
import { credentialKey } from '$lib/types';
import type { IssueSourceType, KeyedSource, Project } from '$lib/types';

// A saved key as the add-source form offers it. No key value, ever: this is
// served to the browser, which is the one place the key must not reach.
export interface CredentialDigest {
	id: string;
	type: IssueSourceType;
	// Who it authenticates as, when the sources using it recorded that.
	label: string;
	// The projects it is already used by, for telling two keys apart when the
	// label cannot.
	projects: string[];
}

// Where one source sits, so a sharing check can exclude the source being
// deleted rather than the whole project.
interface Placed {
	projectName: string;
	projectPath: string;
	source: KeyedSource;
}

function keyedSources(projects: Project[]): Placed[] {
	return projects.flatMap((project) =>
		(project.sources ?? [])
			.filter((source): source is KeyedSource => source.type !== 'github')
			.map((source) => ({ projectName: project.name, projectPath: project.path, source }))
	);
}

// What to call a credential. Linear records the account's email and ClickUp now
// records its username, so most credentials name themselves; the team is the
// fallback for a ClickUp source saved before the username was stored, and the
// provider name for anything with neither.
function label(source: KeyedSource): string {
	if (source.type === 'linear') return source.assigneeEmail || source.teamName || 'Linear key';
	return source.assigneeName || source.teamName || 'ClickUp key';
}

// The saved credentials, one per distinct key, newest project order preserved.
//
// Grouped by key rather than by source, so adding the same Linear key to four
// projects offers one entry and not four. The first source to name a key
// decides the label: a later one authenticates as the same account, so it has
// nothing different to say.
export function listCredentials(projects: Project[]): CredentialDigest[] {
	const byKey = new Map<string, CredentialDigest>();
	for (const { projectName, source } of keyedSources(projects)) {
		const key = credentialKey(source);
		if (!key) continue;
		const existing = byKey.get(key);
		if (existing) {
			if (!existing.projects.includes(projectName)) existing.projects.push(projectName);
			continue;
		}
		byKey.set(key, { id: key, type: source.type, label: label(source), projects: [projectName] });
	}
	return [...byKey.values()];
}

// Only the credentials for one provider, which is all the add form offers.
export function credentialsFor(projects: Project[], type: IssueSourceType): CredentialDigest[] {
	return listCredentials(projects).filter((c) => c.type === type);
}

// Whether a source that is about to go is the last one using its key, and so
// whether removing it should take the stored key with it.
//
// This is the rule that makes a shared credential safe to delete around: before
// #237 every source owned its key outright, so dropping a source could simply
// drop the key. Now a key another project is still pointed at has to survive.
export function keyStillUsed(
	projects: Project[],
	key: string,
	excluding: { projectPath: string; sourceIds: readonly string[] }
): boolean {
	return keyedSources(projects).some(
		({ projectPath, source }) =>
			credentialKey(source) === key &&
			!(projectPath === excluding.projectPath && excluding.sourceIds.includes(source.id))
	);
}

// The keys to forget when these sources go: the ones no surviving source still
// points at. Takes the whole set leaving at once, so removing a project drops
// the keys its sources alone held and keeps the ones it shared.
export function orphanedKeys(
	projects: Project[],
	leaving: { projectPath: string; sources: readonly { id: string }[] }
): string[] {
	const sourceIds = leaving.sources.map((s) => s.id);
	const going = keyedSources(projects).filter(
		({ projectPath, source }) => projectPath === leaving.projectPath && sourceIds.includes(source.id)
	);
	const orphaned = new Set<string>();
	for (const { source } of going) {
		const key = credentialKey(source);
		if (key && !keyStillUsed(projects, key, { projectPath: leaving.projectPath, sourceIds })) {
			orphaned.add(key);
		}
	}
	return [...orphaned];
}
