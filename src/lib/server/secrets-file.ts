import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SECRETS_FILE_RULE = 'operator.apiKeyFile must be a file inside ~/.secrets/';

// realpath, or for a path that doesn't exist yet, its nearest existing
// ancestor's realpath with the rest appended.
function realOrResolved(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.join(realOrResolved(path.dirname(p)), path.basename(p));
	}
}

// The path an apiKeyFile setting names, if it sits inside ~/.secrets/ once ~ is
// expanded and symlinks are followed; otherwise null. Anything wider would let
// whoever can change settings have deck read an arbitrary file and send its
// first line to a model endpoint as a bearer token.
export function resolveSecretsFile(file: string): string | null {
	const home = os.homedir();
	const expanded = file.replace(/^~(?=$|\/)/, home);
	if (!path.isAbsolute(expanded)) return null;
	const dir = realOrResolved(path.join(home, '.secrets'));
	const real = realOrResolved(path.resolve(expanded));
	return real.startsWith(dir + path.sep) ? real : null;
}
