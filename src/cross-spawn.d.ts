// cross-spawn ships no types. We only use its single default export, a drop-in
// for child_process.spawn that also resolves Windows .cmd/.bat shims. Inline
// import() types keep this file a script so the declaration is a real ambient
// module (a top-level import would make it an augmentation of a non-existent type).
declare module 'cross-spawn' {
	const spawn: (
		command: string,
		args?: readonly string[],
		options?: import('node:child_process').SpawnOptions
	) => import('node:child_process').ChildProcess;
	export default spawn;
}
