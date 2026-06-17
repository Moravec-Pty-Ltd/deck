// App-wide toggle for tool output inside tool calls (Bash command output and
// Edit/Write/MultiEdit diffs). A single shared switch, so expanding or
// collapsing one block does the same to all of them at once. Collapsed by
// default.
export const toolOutput = $state({ open: false });
