// Commit-message check (husky commit-msg hook). release-please builds the version
// bump and changelog from Conventional Commits, so every message needs a type.
// Messages stay short: a subject that says what changed, and an optional brief body.
import { readFileSync } from 'node:fs';

const TYPES = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'revert'];
const MAX_SUBJECT = 72;
const MAX_BODY_LINES = 6;
const MAX_LINE = 100;

// Git's own comment lines (the editor template) don't count, nor the diff `git commit -v` adds below the scissors line.
const text = readFileSync(process.argv[2], 'utf8').split(/^# -+ >8 -+$/m)[0];
const lines = text.split('\n').filter((l) => !l.startsWith('#'));
const subject = lines[0] ?? '';
const body = lines.slice(1).filter((l) => l.trim() !== '' && !/^(Co-authored-by|Signed-off-by|Reviewed-by|Refs|Fixes|Closes|BREAKING CHANGE): /i.test(l)); // trailers don't count

// Messages git writes itself (merges, reverts, fixup!/squash!) pass through.
if (/^(Merge|Revert|fixup!|squash!|amend!) /.test(subject)) process.exit(0);

const problems = [];
if (!new RegExp(`^(${TYPES.join('|')})(\\([\\w./-]+\\))?!?: \\S`).test(subject)) {
  problems.push(`Start with a type, like "fix: …" or "feat(video): …". Types: ${TYPES.join(', ')}; add "!" for a breaking change.`);
}
if (subject.length > MAX_SUBJECT) problems.push(`Keep the first line to ${MAX_SUBJECT} characters (it has ${subject.length}).`);
if (subject.endsWith('.')) problems.push('Leave the full stop off the first line.');
if (lines[1]?.trim()) problems.push('Leave a blank line after the first line.');
if (body.length > MAX_BODY_LINES) problems.push(`Keep the body to ${MAX_BODY_LINES} lines (it has ${body.length}); say why, not every detail.`);
if (body.some((l) => l.length > MAX_LINE)) problems.push(`Wrap body lines at ${MAX_LINE} characters.`);

if (problems.length) {
  console.error(`Commit message:\n${problems.map((p) => `  - ${p}`).join('\n')}\nGot: ${subject}`);
  process.exit(1);
}
