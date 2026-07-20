// The Shiki bundle for fenced code, imported dynamically (see highlighter.svelte.ts)
// so its grammars stay out of the initial chunk, mirroring how DiffView defers
// @pierre/diffs. Uses Shiki's synchronous core with the JS regex engine (no WASM,
// no top-level await) so the code renderer stays sync and streaming isn't disabled.
import { createHighlighterCoreSync, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

import githubDark from 'shiki/themes/github-dark.mjs';
import githubLight from 'shiki/themes/github-light.mjs';

// Languages common in agent transcripts. Each grammar registers its own aliases
// (e.g. shellscript covers bash/sh/zsh), which Shiki resolves at highlight time.
import bash from 'shiki/langs/bash.mjs';
import c from 'shiki/langs/c.mjs';
import cpp from 'shiki/langs/cpp.mjs';
import csharp from 'shiki/langs/csharp.mjs';
import css from 'shiki/langs/css.mjs';
import diff from 'shiki/langs/diff.mjs';
import docker from 'shiki/langs/docker.mjs';
import go from 'shiki/langs/go.mjs';
import graphql from 'shiki/langs/graphql.mjs';
import html from 'shiki/langs/html.mjs';
import ini from 'shiki/langs/ini.mjs';
import java from 'shiki/langs/java.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import json from 'shiki/langs/json.mjs';
import jsx from 'shiki/langs/jsx.mjs';
import kotlin from 'shiki/langs/kotlin.mjs';
import markdown from 'shiki/langs/markdown.mjs';
import php from 'shiki/langs/php.mjs';
import python from 'shiki/langs/python.mjs';
import ruby from 'shiki/langs/ruby.mjs';
import rust from 'shiki/langs/rust.mjs';
import scss from 'shiki/langs/scss.mjs';
import sql from 'shiki/langs/sql.mjs';
import svelte from 'shiki/langs/svelte.mjs';
import swift from 'shiki/langs/swift.mjs';
import toml from 'shiki/langs/toml.mjs';
import tsx from 'shiki/langs/tsx.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import vue from 'shiki/langs/vue.mjs';
import xml from 'shiki/langs/xml.mjs';
import yaml from 'shiki/langs/yaml.mjs';

// Shiki's sync core wants already-resolved registrations, but its loader also
// accepts the `LanguageRegistration[]` default export shape these imports give
// (verified at runtime); flatten and hand them over.
const langs = [
	bash, c, cpp, csharp, css, diff, docker, go, graphql, html, ini, java, javascript,
	json, jsx, kotlin, markdown, php, python, ruby, rust, scss, sql, svelte, swift, toml,
	tsx, typescript, vue, xml, yaml
].flat();

export function buildHighlighter(): HighlighterCore {
	return createHighlighterCoreSync({
		// forgiving: skip any grammar pattern the JS engine can't compile instead of
		// throwing, so one unsupported rule doesn't drop highlighting for the block.
		engine: createJavaScriptRegexEngine({ forgiving: true }),
		themes: [githubLight, githubDark],
		langs
	});
}
