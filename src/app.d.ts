// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// Errors carry a `code` when the client can do something about them
		// beyond showing the message: a worktree conflict (see
		// $lib/worktree-conflict) names the branch and offers a way out.
		interface Error {
			message: string;
			code?: string;
			branch?: string;
		}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
